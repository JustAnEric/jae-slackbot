import path from "node:path";
import fs, { PathLike } from "fs";
import ws from "ws";
import { v4 as uuidv4 } from "uuid";

interface Packet {
    type: string;
    ts?: number;
    auth_token?: string;
    container_id?: string;
    cmd?: Array<string>;
    rate?: 'steady' | 'perplexed' | 'angrily_perplexed' | 'dismiss' | 'mildly_perplexed' | 'stop';
    ack_key?: number;
    data?: string;
    code?: number;
    prompt?: string;
}

export class API {
    private w: undefined | ws.WebSocket;
    private api_event_listeners: { [key: string]: Function[] } = {};
    private ack_event_listeners: { [key: string]: Function[] } = {
        'auth': [],
        'spawn': [],
        'kill': []
    };
    private authenticated = false;
    private collected_container_output: Packet[] = [];

    constructor(private auth_token: string | null = null, private auth_server: string | null = null) {
        // defaults
        if (!this.auth_server) {
            this.auth_server = process.env.EXECUTION_SERVER || "127.0.0.1:6200";
        }

        console.log(this.auth_server);

        if (!this.auth_token) {
            this.auth_token = process.env.EXECUTION_SERVER_TOKEN || null;
            if (!this.auth_token) this.log(`the execution server has no default token! this is a security risk and it's recommended you add one by configuring EXECUTION_SERVER_TOKEN on both ends!`);
        }
    }

    log(...data: any[]) {
        console.log(`[EXEC SERVER]`, ...data);
    }

    send_packet(type: string, data: Omit<Packet, 'type'>) {
        if (this.w?.readyState !== 1) {
            console.log(this.w?.readyState);
            return false;
        }
        let ts = Math.random();
        this.w?.send(JSON.stringify({ t: type, ts: ts, ...data }));
        return { ts: ts };
    }

    send_packet_wait_ack(type: string, data: Omit<Packet, 'type'>): Promise<Packet> {
        return new Promise(
            (resolve, reject) => {
                let dwo = this.send_packet(type, data);
                if (dwo) {
                    const listener = async (d: Packet) => {
                        if (dwo.ts != d.ack_key) return;
                        if (!this.ack_event_listeners[type]) return console.warn("NO LISTENERS");
                        this.ack_event_listeners[type] = this.ack_event_listeners[type]?.filter(l => l !== listener);
                        resolve(d);
                    };
                    this.ack_event_listeners[type]?.push(listener);
                } else {
                    reject("No websocket");
                }
            }
        );
    }

    container_output_done() : Promise<Packet[]> {
        return new Promise(
            (resolve, reject) => {
                let c: NodeJS.Timeout | undefined;
                c = setInterval(() => {
                    const last = this.collected_container_output[this.collected_container_output.length - 1];
                    if (last && last.type == "exit") {
                        clearInterval(c);
                        resolve(this.collected_container_output);
                    }
                }, 5);
            }
        )
    }

    async spawn(cmd: Array<string>) {
        const l = await this.send_packet_wait_ack('spawn', { cmd });
        if (l.rate == "steady") {
            return l.container_id;
        } else {
            return null;
        }
    }

    async kill(container_id: string) {
        const l = await this.send_packet_wait_ack('kill', { container_id });
        return l.rate == "steady";
    }

    init() {
        console.log(this.auth_server);
        this.w = new ws.WebSocket(`ws://${this.auth_server}/ws`);

        this.w.onopen = async () => {
            this.log("WebSocket ready");

            if (this.auth_token) {
                // server requires auth
                let o = await this.send_packet_wait_ack('auth', { auth_token: this.auth_token });
                this.log(o);
                this.authenticated = true;
                this.log("Auth succeeded");
            } else {
                this.authenticated = true;
            }
        };

        this.w.onmessage = (e) => {
            const j: Packet = JSON.parse(e.data.toString());
            this.log(j);

            if (j.type.endsWith('_ack')) {
                // it's an acknowledgement
                let ackType = j.type.substring(0, j.type.lastIndexOf('_'));
                this.log("ackType:",ackType);
                if (ackType in this.ack_event_listeners && this.ack_event_listeners[ackType]) {
                    for (const v of this.ack_event_listeners[ackType]) {
                        v(j);
                    }
                }
            }

            if (j.type == "stdout" || j.type == "stdin" || j.type == "stderr" || j.type == "stdin_requested" || j.type == "exit") {
                console.log(`pushed ${j.type}`);
                this.collected_container_output.push(j);
            }
        }

        return new Promise(
            (resolve, reject) => {
                let c: NodeJS.Timeout | undefined;
                c = setInterval(() => {
                    if (this.authenticated) {
                        clearInterval(c);
                        resolve(this);
                    }
                }, 5);
            }
        ); // wait until connection
    }

    close() {
        this.w?.close();
    }
}