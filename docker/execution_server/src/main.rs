use std::{collections::HashMap, fs, io::{BufRead, BufReader, Read, Write}, net::{TcpListener, TcpStream}, thread, sync::{mpsc}, time::{Duration}};
use mimetype_detector;
use regex::Regex;
use bytes::Bytes;
use lazy_regex::{regex_replace_all};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha1::{Digest, Sha1};
use tungstenite::protocol::Role;
use tungstenite::WebSocket;
use serde_json::{self, Number};
use serde_json::json;
use serde::Deserialize;
use serde::Serialize;

static WEB_TEMPLATE_DIR : &'static str = "web/";
static STATIC_FILE_DIR : &'static str = "static/";

#[derive(Deserialize, Debug)]
struct WebSocketData<'a> {
    t: String,
    #[serde(borrow)]
    cmd: Vec<&'a str>,
    ts: Option<Number>,
    container_id: Option<String>
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutputEvent {
    Stdout { data: String },
    Stderr { data: String },
    StdinRequested { prompt: String },
    Exit { code: i32 },
}

#[derive(Deserialize, Serialize, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HostInputEvent {
    Text { data: String },
    KeyInput { key: String },
}

pub struct DockerProxy {
    base_url: String,
}

impl DockerProxy {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// 1. create container (returns container id)
    pub fn create_container(&self, name: &str, image: &str, cmd: Vec<&str>) -> Result<String, String> {
        let url = format!("{}/containers/create?name={}", self.base_url, name);

        let body = json!({
            "Image": image,
            "Cmd": cmd,
            "Tty": true,
            "OpenStdin": true,
            "AttachStdin": true,
            "AttachStdout": true,
            "AttachStderr": true,
            "HostConfig": {
                "AutoRemove": false
            }
        });

        let response = ureq::post(&url)
            .header("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| format!("http create failed: {e}"))?;

        let json_resp: serde_json::Value = response
            .into_body()
            .read_json()
            .map_err(|e| format!("failed to parse create response: {e}"))?;

        if let Some(id) = json_resp.get("Id").and_then(|v| v.as_str()) {
            Ok(id.to_string())
        } else {
            Err("proxy returned no container id".to_string())
        }
    }

    /// 2. start container
    pub fn start_container(&self, id_or_name: &str) -> Result<(), String> {
        let url = format!("{}/containers/{}/start", self.base_url, id_or_name);

        ureq::post(&url)
            .send("")
            .map_err(|e| format!("failed to start container: {e}"))?;

        Ok(())
    }

    /// 3. stop container (with short grace period)
    pub fn stop_container(&self, id_or_name: &str) -> Result<(), String> {
        let url = format!("{}/containers/{}/stop?t=2", self.base_url, id_or_name);

        ureq::post(&url)
            .send("")
            .map_err(|e| format!("failed to stop container: {e}"))?;

        Ok(())
    }

    /// 4. kill container immediately
    pub fn kill_container(&self, id_or_name: &str) -> Result<(), String> {
        let url = format!("{}/containers/{}/kill", self.base_url, id_or_name);

        ureq::post(&url)
            .send("")
            .map_err(|e| format!("failed to kill container: {e}"))?;

        Ok(())
    }

    pub fn delete_container(&self, id_or_name: &str, force: bool) -> Result<(), String> {
        let url = format!("{}/containers/{}?force={}", self.base_url, id_or_name, match force {true => "true", false => "false"});

        ureq::delete(&url)
            .call()
            .map_err(|e| format!("failed to remove container: {e}"))?;

        Ok(())
    }

    pub fn create_interactive_container(&self, name: &str, image: &str, cmd: Vec<&str>) -> Result<String, String> {
        let url = format!("{}/containers/create?name={}", self.base_url, name);

        let body = json!({
            "Image": image,
            "Cmd": cmd,
            "Tty": true,
            "OpenStdin": true,
            "AttachStdin": true,
            "AttachStdout": true,
            "AttachStderr": true,
            "HostConfig": {
                "AutoRemove": true
            }
        });

        let response = ureq::post(&url)
            .header("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| format!("http create failed: {e}"))?;

        let json_resp: serde_json::Value = response
            .into_body()
            .read_json()
            .map_err(|e| format!("failed to parse create response: {e}"))?;

        if let Some(id) = json_resp.get("Id").and_then(|v| v.as_str()) {
            Ok(id.to_string())
        } else {
            Err("proxy returned no container id".to_string())
        }
    }
}

pub fn encode_uri(s: impl AsRef<str>) -> String {
    regex_replace_all!(r"[^A-Za-z0-9_\-\.:/\\]", s.as_ref(), |seq: &str| {
        let mut r = String::new();
        for ch in seq.to_owned().bytes() {
            r.push('%');
            r.push_str(octet_to_hex(ch).as_ref());
        }
        r.clone()
    }).into_owned()
}

pub fn decode_uri(s: impl AsRef<str>) -> String {
    // using a closure that doesn't allocate inside the loop
    let normalized = s.as_ref().replace('+', " ");

    regex_replace_all!(r"%[A-Fa-f0-9]{2}", &normalized, |caps: &str| {
        // caps is just "%A1", so we take the slice [1..3] which is "A1"
        let hex = &caps[1..];
        
        // parse the hex string directly to a u8
        if let Ok(byte) = u8::from_str_radix(hex, 16) {
            // convert the byte to a char (or keep as u8 for safety with non-utf8)
            std::char::from_u32(byte as u32)
                .map(|c| c.to_string())
                .unwrap_or_else(|| format!("%{}", hex.to_uppercase()))
        } else {
            caps.to_string()
        }
    }).into_owned()
}

fn octet_to_hex(arg: u8) -> String {
    format!("{:02X}", arg)
}

fn make_header(name: &str, value: &str) -> String {
    return format!("{name}: {value}");
}

/*fn parse_query(qs: String) -> HashMap<String, String> {
    let mut map = HashMap::new();

    for pair in qs.split('&') {
        let mut parts = pair.splitn(2, '=');

        if let (Some(key), Some(value)) = (parts.next(), parts.next()) {
            map.insert(key.to_string(), decode_uri(value.to_string()));
        }
    }

    map
}*/

/*fn get_query<'a>(pq: &'a HashMap<String, String>, kn: &str, or: &'a str) -> &'a str {
    pq.get(kn).map_or(or, |v| v.as_str())
}*/

/*fn cookie<'a>(cookies: &'a HashMap<String, String>) -> String {
    cookies.iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<String>>()
        .join("; ")
}*/

/*fn set_cookie_header(cookie_str: &String) -> String {
    make_header("Set-Cookie", cookie_str)
}*/

fn package_headers(headers_list: &[&str]) -> String {
    headers_list.join("\r\n")
}

/*fn is_form_data(headers: &HashMap<String, String>) -> bool {
    let content_type: Option<(&String, &String)> = headers.get_key_value("content-type");

    if content_type.is_some() {
        return content_type.unwrap().1.contains("application/x-www-form-urlencoded");
    } else {
        return false;
    };
}*/

fn banner() -> String {
    let banner = r#"
========================================
 ERIC'S NUMBER ONE WEB SERVER
 BECAUSE HE'S THE BEST OF ALL TIME
========================================
"#;
    banner.to_string()
}

fn render_web_tmpl(file_path: &str, context: &HashMap<String, String>) -> String {
    let does_exist: Result<bool, std::io::Error> = fs::exists(format!("{WEB_TEMPLATE_DIR}{file_path}"));

    if does_exist.is_err() { return "<h1>500</h1> <p>Internal Server Error</p><code>ERR:TEMPLATE_NOT_FOUND</code>".to_string(); }

    let does_template_exist = does_exist.unwrap();

    if !does_template_exist { return "<h1>500</h1> <p>Internal Server Error</p><code>ERR:TEMPLATE_NOT_FOUND</code>".to_string(); }

    // read file
    let file_content_req = fs::read_to_string(format!("{WEB_TEMPLATE_DIR}{file_path}"));

    if file_content_req.is_err() { return "<h1>500</h1> <p>Internal Server Error</p><code>ERR:TEMPLATE_NOT_FOUND</code>".to_string(); }

    let f_c = file_content_req.unwrap();
    let mut file_contents = f_c.clone();

    // basic templating (like jinja)
    let re = Regex::new(r"\{\{(.*?)\}\}").unwrap();

    //if context.is_none() {
        // then we can't do anything
    //    return "<h1>500</h1> <p>Internal Server Error</p><code>ERR:TEMPLATING_ENGINE_CONTEXT_REQUIRED</code>".to_string();
    //}

    //let context = context.unwrap();

    for caps in re.captures_iter(&f_c) {
        // caps[0] is the whole match (e.g., "{{name}}")
        // caps[1] is just the content inside (e.g., "name")

        let value: Option<&String> = context.get(&caps[1].trim().to_string());

        if value.is_none() {
            return "<h1>500</h1> <p>Internal Server Error</p><code>ERR:TEMPLATING_ENGINE_CONTEXT_REQUIRED</code>".to_string();
        }

        file_contents = file_contents.replacen(&caps[0], value.unwrap(), 1);
    }

    return file_contents.to_string();
}

fn static_file_is_servable(file_path: &str) -> bool {
    if file_path.contains("..") {
        return false;
    }
    let does_exist: Result<bool, std::io::Error> = fs::exists(format!("{STATIC_FILE_DIR}{file_path}"));

    if does_exist.is_err() { return false; }

    let does_template_exist = does_exist.unwrap();

    if !does_template_exist { return false; }

    return true;
}

fn serve_static_file(file_path: &str) -> Bytes {
    let does_exist: Result<bool, std::io::Error> = fs::exists(format!("{STATIC_FILE_DIR}{file_path}"));

    if does_exist.is_err() { return Bytes::copy_from_slice("<h1>500</h1> <p>Internal Server Error</p><code>ERR:FILE_NOT_FOUND</code>".as_bytes()); }

    let does_template_exist = does_exist.unwrap();

    if !does_template_exist { return Bytes::copy_from_slice("<h1>500</h1> <p>Internal Server Error</p><code>ERR:FILE_NOT_FOUND</code>".as_bytes()); }

    // read file
    let file_content_req = fs::read(format!("{STATIC_FILE_DIR}{file_path}"));

    if file_content_req.is_err() { return Bytes::copy_from_slice("<h1>500</h1> <p>Internal Server Error</p><code>ERR:FILE_NOT_FOUND</code>".as_bytes()); }

    let file_contents = file_content_req.unwrap();

    return Bytes::from(file_contents);
}

fn err_404(mut stream: TcpStream) {
    let response_text = "<h1>404</h1> <p>Not Found</p>";
    let response_length = response_text.len();

    let content_length_header = make_header("Content-Length", &response_length.to_string());
    let content_type_header = make_header("Content-Type", "text/html");

    let headers = package_headers([content_length_header.as_str(), content_type_header.as_str()].as_ref());

    let response = format!("HTTP/1.1 404 Not Found\r\n{headers}\r\n\r\n{response_text}");
    stream.write_all(response.as_bytes()).unwrap();
}

/*fn err_403(mut stream: TcpStream) {
    let response_text = "<h1>403</h1> <p>Forbidden</p>";
    let response_length = response_text.len();

    let content_length_header = make_header("Content-Length", &response_length.to_string());
    let content_type_header = make_header("Content-Type", "text/html");

    let headers = package_headers([content_length_header.as_str(), content_type_header.as_str()].as_ref());

    let response = format!("HTTP/1.1 403 Forbidden\r\n{headers}\r\n\r\n{response_text}");
    stream.write_all(response.as_bytes()).unwrap();
}*/

fn err_405(mut stream: TcpStream) {
    let response_text = "<h1>405</h1> <p>Method Not Allowed</p>";
    let response_length = response_text.len();

    let content_length_header = make_header("Content-Length", &response_length.to_string());
    let content_type_header = make_header("Content-Type", "text/html");

    let headers = package_headers([content_length_header.as_str(), content_type_header.as_str()].as_ref());

    let response = format!("HTTP/1.1 405 Method Not Allowed\r\n{headers}\r\n\r\n{response_text}");
    stream.write_all(response.as_bytes()).unwrap();
}

fn make_response_200(mut stream: TcpStream, response_text: String, headers_str: &str) {
    let response_length = response_text.len();

    let content_length_header = make_header("Content-Length", &response_length.to_string());

    let response = format!("HTTP/1.1 200 OK\r\n{content_length_header}\r\n{headers_str}\r\n\r\n{response_text}");
    stream.write_all(response.as_bytes()).unwrap();
}

fn make_response_200_bytes(mut stream: TcpStream, response_buf: Bytes, headers_str: &str) {
    let response_length = response_buf.len();

    let content_length_header = make_header("Content-Length", &response_length.to_string());

    let response = format!("HTTP/1.1 200 OK\r\n{content_length_header}\r\n{headers_str}\r\n\r\n");

    // write the header part first
    stream.write_all(response.as_bytes()).unwrap();
    
    // then write the response body directly!
    stream.write_all(&response_buf).unwrap();
}

fn route_root(stream: TcpStream, req_path: &str, req_method: &str, _req_query: String, _req_headers: &HashMap<String, String>, _req_body: String) {
    if req_path == "/" && req_method == "GET" {
        // display default page
        let mut context: HashMap<String, String> = HashMap::new();
        context.insert("title".to_string(), "Eric's Number One Web Server".to_string());
        let response_template = render_web_tmpl("index.html", &context);
        let server_header = make_header("Server", "erics number one web server because he's the best of all time");
        make_response_200(stream, response_template, &package_headers([server_header.as_str()].as_ref()));
        return;
    } else if req_path == "/" && req_method != "GET" {
        err_405(stream);
        return;
    }
}

fn route_docs(stream: TcpStream, req_path: &str, req_method: &str, _req_query: String, _req_headers: &HashMap<String, String>, _req_body: String) {
    if req_path == "/docs" && req_method == "GET" {
        // display default page
        let context: HashMap<String, String> = HashMap::new();
        let response_template = render_web_tmpl("docs.html", &context);
        let server_header = make_header("Server", "erics number one web server because he's the best of all time");
        make_response_200(stream, response_template, &package_headers([server_header.as_str()].as_ref()));
        return;
    } else if req_path == "/docs" && req_method != "GET" {
        err_405(stream);
        return;
    }
}

fn route_static(mut stream: TcpStream, req_path: &str, _req_method: &str, _req_query: String, _req_headers: &HashMap<String, String>, _req_body: String) {
    if req_path.contains("..") {
        // block it! 403 forbidden is perfect here
        // send back
        let status_text = "<h1>403</h1> <p>Forbidden</p>";
        let status_text_length = status_text.len();
        let content_length_header = make_header("Content-Length", &status_text_length.to_string());
        let headers = package_headers([content_length_header.as_str()].as_ref());
        let response = format!("HTTP/1.1 403 Forbidden\r\n{headers}\r\n\r\n{status_text}");
        stream.write_all(response.as_bytes()).unwrap();
        return;
    }

    let file_content = serve_static_file(req_path);
    let real_fp = format!("{STATIC_FILE_DIR}{req_path}");
    let file_path = std::path::Path::new(&real_fp);
    let file_ext = file_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mimetype: &'static str = match mimetype_detector::detect_file(file_path) {
        Ok(detected) => detected.mime(),
        Err(_) => "application/octet-stream",
    };

    let mimetype_override = match file_ext {
        "css" => "text/css",
        "js" => "text/javascript",
        "html" => "text/html",
        "htm" => "text/htm",
        _ => mimetype
    };

    let content_type_header = make_header("Content-Type", &format!("{mimetype_override}").to_string());

    make_response_200_bytes(stream, file_content, &package_headers([content_type_header.as_str()].as_ref()));
    return;
}

static RESPONSES : [(&'static str, fn(stream: TcpStream, req_path: &str, req_method: &str, req_query: String, req_headers: &HashMap<String, String>, req_body: String)); 3] = [
    ("/", route_root),
    ("/docs", route_docs),
    ("/static", route_static)
];

fn main() {
    eprintln!("{}", banner());

    let addr = "0.0.0.0:6200";

    let listener = TcpListener::bind(addr).unwrap();

    println!("Listening on {}...", addr);

    for stream in listener.incoming() {
        let stream = stream.unwrap();

        let _ = stream.set_nodelay(true); //nagle's algorithm
        
        thread::spawn(|| { handle_conn(stream); });
    }
}

fn handle_conn(mut stream: TcpStream) {
    let mut buf_reader = BufReader::new(&stream);
    let mut request_headers: HashMap<String, String> = HashMap::new();
    let mut content_length = 0;
    let mut first_line = String::new();
    //let http_request: Vec<_> = buf_reader
    //    .lines()
    //    .map(|line| {
    //        line.unwrap_or(String::from("Error"))
    //    })
    //    .take_while(|line| !line.is_empty())
    //    .collect();

    buf_reader.read_line(&mut first_line).unwrap();

    loop {
        let mut line = String::new();
        buf_reader.read_line(&mut line).unwrap();

        if line.trim().is_empty() { break; } // headers end

        let mut header_nbuf = line.splitn(2, ':');
        let Some(header_name) = header_nbuf.next() else { continue; };
        let Some(header_value) = header_nbuf.next() else { continue; };
        //let header_name: String = header_nbuf.nth(0).unwrap().trim().parse().unwrap();
        //let header_value: String = header_nbuf.nth(0).unwrap().trim().parse().unwrap();

        if header_name.to_lowercase() == "content-length" {
            if let Ok(len) = header_value.trim().parse::<usize>() {
                content_length = len;
            }
        }

        request_headers.insert(header_name.to_string().to_lowercase(), header_value.trim().to_string());
    }

    let mut body = String::new();
    let is_transfer_encoding: Option<(&String, &String)> = request_headers.get_key_value("transfer-encoding");

    // safeguard against memory exhaustion attacks by limiting the size of the request body
    if content_length > 10 * 1024 * 1024 {
        let status_text = "<h1>413</h1> <p>Payload Too Large</p>";
        let status_text_length = status_text.len();
        let content_length_header = make_header("Content-Length", &status_text_length.to_string());
        let headers = package_headers([content_length_header.as_str()].as_ref());
        let response = format!("HTTP/1.1 413 Payload Too Large\r\n{headers}\r\n\r\n{status_text}");
        stream.write_all(response.as_bytes()).unwrap();
        return;
    }
    
    if content_length > 0 {
        // read body support
        let mut body_bytes = vec![0; content_length];
        buf_reader.read_exact(&mut body_bytes).unwrap();
        body = match String::from_utf8(body_bytes) {
            Ok(body) => body,
            Err(_) => {
                let status_text = "<h1>400</h1> <p>Bad Request: Request body must be valid UTF-8</p>";
                let status_text_length = status_text.len();
                let content_length_header =
                    make_header("Content-Length", &status_text_length.to_string());
                let headers = package_headers([content_length_header.as_str()].as_ref());
                let response = format!(
                    "HTTP/1.1 400 Bad Request\r\n{headers}\r\n\r\n{status_text}"
                );
                stream.write_all(response.as_bytes()).unwrap();
                return;
            }
        };
    } else if is_transfer_encoding.is_some() {
        if is_transfer_encoding.unwrap().1 == "chunked" {
            // send back 
            let status_text = "This server does not allow Transfer-Encoding: chunked; requests yet.";
            let status_text_length = status_text.len();
            let content_length_header = make_header("Content-Length", &status_text_length.to_string());
            let headers = package_headers([content_length_header.as_str()].as_ref());
            let response = format!("HTTP/1.1 403 Forbidden\r\n{headers}\r\n\r\n{status_text}");
            stream.write_all(response.as_bytes()).unwrap();
            return;
        }
    }

    let mut request_head_parts:std::str::Split<'_, char>  = first_line.split(' ');
    let request_method = request_head_parts.nth(0);
    let request_path = request_head_parts.nth(0);

    if request_method.is_none() {
        println!("No request");
        let status_text = "There was no request.";
        let status_text_length = status_text.len();
        let content_length_header = make_header("Content-Length", &status_text_length.to_string());
        let headers = package_headers([content_length_header.as_str()].as_ref());
        let response = format!("HTTP/1.1 404 Not Found\r\n{headers}\r\n\r\n{status_text}");
        stream.write_all(response.as_bytes()).unwrap();
        return;
    } else {
        let req_path = request_path.unwrap_or("/");
        let mut req_path_split_query = req_path.split('?');
        let req_path_without_query = req_path_split_query.nth(0).unwrap_or("/");
        let query_str = req_path_split_query.nth(0).unwrap_or("");
        let req_query = format!("{query_str}");
        
        let req_method = request_method.unwrap_or("GET");

        // Check if the client wants a WebSocket connection
        let is_upgrade = request_headers.get("upgrade").map(|v| v.to_lowercase() == "websocket").unwrap_or(false);

        if req_path == "/ws" && is_upgrade {
            handle_websocket(stream, &request_headers);
            return;
        }

        for response in RESPONSES {
            if response.0 == req_path_without_query {
                response.1(stream, req_path_without_query, req_method, req_query, &request_headers, body);
                return;
            }
        }

        // try static
        if static_file_is_servable(req_path_without_query) {
            route_static(stream, req_path_without_query, req_method, req_query, &request_headers, body);
            return;
        }

        // let's just display 404
        err_404(stream);
        return;
    }
}

fn handle_websocket(mut stream: TcpStream, headers: &HashMap<String, String>) {
    let Some(key) = headers.get("sec-websocket-key") else {
        eprintln!("missing sec-websocket-key header");
        return;
    };

    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    let accept_key = BASE64.encode(hasher.finalize());

    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Accept: {}\r\n\r\n",
        accept_key
    );

    if let Err(e) = stream.write_all(response.as_bytes()) {
        eprintln!("failed to send handshake response: {e}");
        return;
    }

    let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));

    let mut websocket = WebSocket::from_raw_socket(stream, Role::Server, None);
    println!("WebSocket client successfully connected!");

    let (tx, rx) = mpsc::channel::<String>();

    let mut containers: Vec<String> = Vec::new();

    let mut docker_writer: Option<TcpStream> = None;

    loop {
        while let Ok(outgoing_text) = rx.try_recv() {
            let res = websocket.send(tungstenite::Message::Text(outgoing_text.into()));
            if res.is_ok() {
                let _ = websocket.flush();
                println!("[SERVER]: Successfully sent frame to WebSocket client!");
            }
        }

        let msg_res = websocket.read();

        match msg_res {
            Ok(msg) => {
                if msg.is_text() {
                    let text = msg.to_string();

                    println!("[WS RECEIVED]: {}", text);

                    if let Ok(_input_event) = serde_json::from_str::<HostInputEvent>(&text) {
                        if let Some(ref mut writer) = docker_writer {
                            let mut line = text.clone();
                            if !line.ends_with('\n') {
                                line.push('\n');
                            }
                            if let Err(err) = writer.write_all(line.as_bytes()) {
                                eprintln!("failed to write to container stdin: {err}");
                            } else {
                                let _ = writer.flush();
                            }
                        }
                        continue;
                    }

                    if let Ok(ws_data) = serde_json::from_str::<WebSocketData>(&text) {
                        if ws_data.t == "spawn" {
                            let container_name = format!("jae-box-{}", uuid::Uuid::new_v4().to_string());
                            let proxy_host = "docker-proxy:2375";

                            let Ok(mut attach_stream) = TcpStream::connect(proxy_host) else {
                                eprintln!("failed to connect to docker-proxy");
                                continue;
                            };

                            println!("Cmd: {:?}", ws_data.cmd);

                            let prox = DockerProxy::new("http://docker-proxy:2375");
                            let container_id = prox.create_container(container_name.as_str(), "jae-exec-worker", ws_data.cmd).unwrap();

                            // it's now time to track the container
                            containers.push(container_id.clone());

                            let ss1 = serde_json::json!({ "type": "spawn_ack", "ack_key": ws_data.ts, "container_id": container_id.clone(), "rate": "steady" });
                            let ss = ss1.as_str();

                            if !ss.is_none() {
                                if tx.send(ss.unwrap().to_string()).is_ok() {
                                    println!("Response sent to client for spawn command");
                                }
                            }

                            println!("{}", container_id);

                            let req = format!(
                                "POST /containers/{}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=1 HTTP/1.1\r\n\
                                 Host: {}\r\n\
                                 Upgrade: tcp\r\n\
                                 Connection: Upgrade\r\n\r\n",
                                container_id, proxy_host
                            );

                            if attach_stream.write_all(req.as_bytes()).is_err() {
                                continue;
                            }

                            let docker_reader = attach_stream.try_clone().unwrap();
                            docker_writer = Some(attach_stream);

                            let tx_clone = tx.clone();

                            thread::spawn(move || {
                                let mut reader = BufReader::new(docker_reader);

                                // 1. STRIP HTTP HEADERS
                                let mut pattern_state = 0;
                                let mut byte_buf = [0u8; 1];

                                while reader.read_exact(&mut byte_buf).is_ok() {
                                    match (pattern_state, byte_buf[0]) {
                                        (0, b'\r') => pattern_state = 1,
                                        (1, b'\n') => pattern_state = 2,
                                        (2, b'\r') => pattern_state = 3,
                                        (3, b'\n') => break,
                                        (_, b'\r') => pattern_state = 1,
                                        _ => pattern_state = 0,
                                    }
                                }

                                println!("[SERVER]: HTTP headers stripped! Reading raw TTY lines...");

                                // 2. READ RAW TTY LINES
                                for line in reader.lines() {
                                    let Ok(raw_line) = line else { break };
                                    let trimmed = raw_line.trim();
                                    if trimmed.is_empty() {
                                        continue;
                                    }

                                    println!("[CONTAINER LINE]: {}", trimmed);

                                    let response_json = if let Ok(event) = serde_json::from_str::<OutputEvent>(trimmed) {
                                        serde_json::to_string(&event).unwrap()
                                    } else {
                                        let fallback = OutputEvent::Stdout {
                                            data: trimmed.to_string(),
                                        };
                                        serde_json::to_string(&fallback).unwrap()
                                    };

                                    if tx_clone.send(response_json).is_err() {
                                        break;
                                    }
                                }
                            });

                            let e: Result<(), String> = prox.start_container(container_id.as_str());
                            println!("{}", e.is_ok());
                        } else if ws_data.t == "kill" {
                            let prox = DockerProxy::new("http://docker-proxy:2375");

                            if ws_data.container_id.is_none() {
                                let ss1 = serde_json::json!({ "type": "kill_ack", "ack_key": ws_data.ts, "rate": "perplexed" });
                                let ss = ss1.as_str();

                                if !ss.is_none() {
                                    if tx.send(ss.unwrap().to_string()).is_ok() {
                                        println!("Malformed data on kill");
                                    }
                                }
                            } else {
                                let k = ws_data.container_id.unwrap();
                                if containers.contains(&k) {
                                    let e: Result<(), String> = prox.kill_container(&k);
                                    let _ = prox.delete_container(&k, true);
                                    if e.is_ok() {
                                        let ss1 = serde_json::json!({ "type": "kill_ack", "ack_key": ws_data.ts, "rate": "steady" });
                                        let ss = ss1.as_str();

                                        if !ss.is_none() {
                                            if tx.send(ss.unwrap().to_string()).is_ok() {
                                                println!("Killed container");
                                            }
                                        }
                                    }
                                } else {
                                    let ss1 = serde_json::json!({ "type": "kill_ack", "ack_key": ws_data.ts, "rate": "angrily_perplexed" });
                                    let ss = ss1.as_str();

                                    if !ss.is_none() {
                                        if tx.send(ss.unwrap().to_string()).is_ok() {
                                            println!("Out of bounds attempt on kill");
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else if msg.is_close() {
                    println!("Client requested connection close.");
                    for id in containers {
                        let prox = DockerProxy::new("http://docker-proxy:2375");
                        let _ = prox.kill_container(&id);
                        let _ = prox.delete_container(&id, true);
                    }
                    break;
                }
            }
            Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {
                continue;
            }
            Err(e) => {
                println!("WebSocket error or disconnection: {}", e);
                break;
            }
        }
    }
}