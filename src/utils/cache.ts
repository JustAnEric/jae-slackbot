import type { App } from "@slack/bolt";
import { Channel } from "@slack/web-api/dist/types/response/ConversationsInfoResponse";
import type { User } from "@slack/web-api/dist/types/response/UsersInfoResponse";

export class UserCache {
    private cache = new Map();
    private app: App | null = null;

    constructor({ app }: { app: App }) {
        this.app = app;
    }

    has(v: any) {
        return this.cache.has(v);
    }

    async none_and_cache(v: any) : Promise<User | null> {
        if (this.has(v)) {
            return this.cache.get(v);
        }
        const u = await this.getUser(v);
        if (!u || !u.user) {
            return null;
        }
        this.cache.set(v, u.user);
        return u.user;
    }

    get(v: any) {
        return this.cache.get(v);
    }

    private getUser(u: string) {
        if (!this.app) return undefined;
        return this.app.client.users.info({ user: u });
    }
}

export class ChannelCache {
    private cache = new Map();
    private app: App | null = null;

    constructor({ app }: { app: App }) {
        this.app = app;
    }

    has(v: any) {
        return this.cache.has(v);
    }

    async none_and_cache(v: any) : Promise<Channel | null> {
        if (this.has(v)) {
            return this.cache.get(v);
        }
        const ch = await this.getChannel(v);
        if (!ch || !ch.channel) {
            return null;
        }
        this.cache.set(v, ch.channel);
        return ch.channel;
    }

    get(v: any) {
        return this.cache.get(v);
    }

    async prefetch() {
        if (!this.app) return;
        try {
            const result = await this.app.client.conversations.list({ types: 'public_channel,private_channel,im' });
            if (result.channels)
            for (const channel of result.channels) {
                this.cache.set(channel.id, channel);
            }
        } catch (e) {
            console.error("failed to pre-cache channels:", e);
            return;
        }
    }

    private getChannel(ch: string) {
        if (!this.app) return undefined;
        return this.app.client.conversations.info({ channel: ch });
    }
}