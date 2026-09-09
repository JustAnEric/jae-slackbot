import Database from 'better-sqlite3';

export const db = new Database('users.db');

db.exec(`CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    preferences TEXT,
    timestamp INTEGER
)`);

export const insertUser = db.prepare(`INSERT OR REPLACE INTO users VALUES (?, ?, ?)`);
export const getUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`);

export function saveUserSettings(userId: string, { ...settings }: { [key: string]: any }) {
    insertUser.run(
        userId,
        JSON.stringify(settings),
        Date.now()
    );
}

export function getUserSetting(userId: string, key: string, __default: any) {
    const u: any = getUser.get(userId);
    if (!u) return __default;
    const preferencesObj = JSON.parse(u.preferences);
    return key in preferencesObj ? preferencesObj[key] : __default;
}

export function getUserSettings(userId: string) {
    const u: any = getUser.get(userId);
    if (!u) return {};
    const preferencesObj = JSON.parse(u.preferences);
    return preferencesObj;
}