use libc::{
    c_int, dup2, execvp, fcntl, fork, openpty, waitpid, F_GETFL, F_SETFL,
    O_NONBLOCK, STDIN_FILENO, STDOUT_FILENO, STDERR_FILENO,
};
use serde::{Deserialize, Serialize};
use std::env;
use std::ffi::CString;
use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::io::FromRawFd;
use std::ptr;
use std::thread;
use std::time::Duration;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum OutputEvent {
    Stdout { data: String },
    Stderr { data: String },
    StdinRequested { prompt: String },
    Exit { code: i32 },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HostInputEvent {
    Text { data: String },
    KeyInput { key: String },
}

fn emit(event: OutputEvent) {
    let json = serde_json::to_string(&event).unwrap();
    println!("{}", json);
    let _ = io::stdout().flush();
}

fn key_to_ansi_bytes(key: &str) -> Option<&'static [u8]> {
    match key.to_uppercase().as_str() {
        "F1"  => Some(b"\x1bOP"),
        "F2"  => Some(b"\x1bOQ"),
        "F3"  => Some(b"\x1bOR"),
        "F4"  => Some(b"\x1bOS"),
        "F5"  => Some(b"\x1b[15~"),
        "F6"  => Some(b"\x1b[17~"),
        "F7"  => Some(b"\x1b[18~"),
        "F8"  => Some(b"\x1b[19~"),
        "F9"  => Some(b"\x1b[20~"),
        "F10" => Some(b"\x1b[21~"),
        "F11" => Some(b"\x1b[23~"),
        "F12" => Some(b"\x1b[24~"),

        "UP"        => Some(b"\x1b[A"),
        "DOWN"      => Some(b"\x1b[B"),
        "RIGHT"     => Some(b"\x1b[C"),
        "LEFT"      => Some(b"\x1b[D"),
        "ENTER"     => Some(b"\r"),
        "TAB"       => Some(b"\t"),
        "BACKSPACE" => Some(b"\x7f"),
        "ESCAPE"    => Some(b"\x1b"),
        "CTRL_C"    => Some(b"\x03"),
        "CTRL_D"    => Some(b"\x04"),

        _ => None,
    }
}

fn set_nonblocking(fd: c_int) {
    unsafe {
        let flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: entrypoint <command> [args...]");
        std::process::exit(1);
    }

    let mut master_fd: c_int = 0;
    let mut slave_fd: c_int = 0;

    unsafe {
        if openpty(&mut master_fd, &mut slave_fd, ptr::null_mut(), ptr::null_mut(), ptr::null_mut()) < 0 {
            eprintln!("Failed to open PTY");
            std::process::exit(1);
        }
    }

    set_nonblocking(master_fd);

    let master_file = unsafe { File::from_raw_fd(master_fd) };
    let mut master_reader = master_file.try_clone()?;
    let mut master_writer = master_file;

    thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = BufReader::new(stdin.lock());
        let mut line = String::new();

        while let Ok(bytes) = reader.read_line(&mut line) {
            if bytes == 0 { break; }

            if let Ok(event) = serde_json::from_str::<HostInputEvent>(&line) {
                match event {
                    HostInputEvent::Text { data } => {
                        let _ = master_writer.write_all(data.as_bytes());
                    }
                    HostInputEvent::KeyInput { key } => {
                        if let Some(ansi_seq) = key_to_ansi_bytes(&key) {
                            let _ = master_writer.write_all(ansi_seq);
                        }
                    }
                }
                let _ = master_writer.flush();
            } else {
                let _ = master_writer.write_all(line.as_bytes());
                let _ = master_writer.flush();
            }

            line.clear();
        }
    });

    let pid = unsafe { fork() };

    if pid < 0 {
        eprintln!("Fork failed");
        std::process::exit(1);
    } else if pid == 0 {
        unsafe {
            libc::setsid();

            dup2(slave_fd, STDIN_FILENO);
            dup2(slave_fd, STDOUT_FILENO);
            dup2(slave_fd, STDERR_FILENO);

            let mut termattr: libc::termios = std::mem::zeroed();
            libc::tcgetattr(slave_fd, &mut termattr);
            libc::cfmakeraw(&mut termattr);
            libc::tcsetattr(slave_fd, libc::TCSANOW, &mut termattr);

            let c_cmd = CString::new(args[1].clone()).unwrap();
            let c_args: Vec<CString> = args[1..]
                .iter()
                .map(|s| CString::new(s.as_str()).unwrap())
                .collect();

            let mut arg_ptrs: Vec<*const libc::c_char> = c_args.iter().map(|s| s.as_ptr()).collect();
            arg_ptrs.push(ptr::null());

            execvp(c_cmd.as_ptr(), arg_ptrs.as_ptr());
            libc::_exit(127);
        }
    } else {
        unsafe { libc::close(slave_fd); }

        let mut buffer = [0u8; 1024];
        let mut pending_prompt = String::new();
        let mut prompt_emitted = false;

        loop {
            match master_reader.read(&mut buffer) {
                Ok(n) if n > 0 => {
                    let text = String::from_utf8_lossy(&buffer[..n]).to_string();
                    pending_prompt.push_str(&text);
                    prompt_emitted = false;

                    emit(OutputEvent::Stdout { data: text });
                }
                Ok(0) => break, // EOF reached
                Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => {
                    if !pending_prompt.is_empty() && !prompt_emitted {
                        let prompt_line = pending_prompt
                            .lines()
                            .last()
                            .unwrap_or(&pending_prompt)
                            .to_string();

                        emit(OutputEvent::StdinRequested {
                            prompt: prompt_line,
                        });
                        prompt_emitted = true;
                        pending_prompt.clear();
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                Err(ref e) if e.raw_os_error() == Some(libc::EIO) => {
                    // PTY master returns EIO when slave closes!
                    break;
                }
                _ => break,
            }
        }

        let mut status: c_int = 0;
        unsafe { waitpid(pid, &mut status, 0); }
        let exit_code = if libc::WIFEXITED(status) {
            libc::WEXITSTATUS(status)
        } else {
            1
        };

        emit(OutputEvent::Exit { code: exit_code });
    }

    Ok(())
}