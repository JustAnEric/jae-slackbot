import Database from 'better-sqlite3';
import type { PendingFeedback } from "./types";
import type { WebClient } from "@slack/web-api";

export const db = new Database('feedback.db');
export const PENDING_FEEDBACK = new Map<string, PendingFeedback>();

db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    message_ts TEXT PRIMARY KEY,
    thread_key TEXT,
    user_id TEXT,
    rating TEXT,
    user_message TEXT,
    model_messages TEXT,
    timestamp INTEGER
)`);

export const insertFeedback = db.prepare(`INSERT OR REPLACE INTO feedback VALUES (?, ?, ?, ?, ?, ?, ?)`);

export class FeedbackEngine {
    stream: ReturnType<WebClient["chatStream"]>;

    constructor({ stream }: { stream: ReturnType<WebClient["chatStream"]> }) {
        this.stream = stream;
    }
}