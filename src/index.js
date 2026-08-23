require("dotenv").config();

const axios = require("axios");
const emoji = require('node-emoji');
const fs = require('fs');
const path = require('path');
const remark = require('remark');
const remarkRemoveComments = require('remark-remove-comments');

const { App } = require("@slack/bolt");
const { Ollama } = require("ollama");

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true
});
const ollama = new Ollama({ host: process.env.OLLAMA_HOST });

const CONVERSATIONS = new Map();
const CHANNEL_CACHE = new Map();
const USER_CACHE = new Map();

//<|think|>
const systemPrompt = remark.remark()
                        .use(remarkRemoveComments.default)
                        .processSync(fs.readFileSync(path.join(__dirname, '..', 'PROMPT.md')))
                        .toString('utf-8')
                        .trim();

function promptTemplate(template, vars) {
    return template.replace(/\{([^}]+)\}/g, (match, key) => {
        return key in vars ? vars[key] : match;
    });
}

async function runAI(prompt, conversation = [], additionalData = {}) {
    console.log('doing ollama request');

    const system = promptTemplate(systemPrompt, additionalData);

    const request = await ollama.chat({
        messages: [
            { role: 'system', content: system },
            ...conversation,
            { role: 'user', content: prompt }
        ],
        options: {
            num_ctx: parseInt(process.env.CONTEXT_WINDOW_SIZE || "4096"),
            temperature: parseFloat(process.env.TEMPERATURE || 0.8)
        },
        model: process.env.MODEL || 'gemma4:e2b',
        think: process.env.THINKING_MODE.trim().toLowerCase() == "false" ? false : true
    });

    return request.message.content;
}

app.command("/jae-ping", async ({ command, ack, respond }) => {
    const start = Date.now();
    await ack();
    const latency = Date.now() - start;
    await respond({ text: `Pong!\nLatency: ${latency}ms` });
});

app.command("/jae-catfact", async ({ ack, respond }) => {
    await ack();

    try {
        const response = await axios.get("https://catfact.ninja/fact");
        await respond({ text: `Cat Fact:\n${response.data.fact}` });
    } catch (err) {
        await respond({ text: "Failed to fetch a cat fact." });
    }
});

app.command("/jae-joke", async ({ ack, respond }) => {
    await ack();

    try {
        const response = await axios.get("https://official-joke-api.appspot.com/random_joke");
        await respond({
            text:
                `${response.data.setup}

${response.data.punchline}`
        });
    } catch (err) {
        await respond({ text: "Failed to fetch a joke." });
    }
});

app.message(async ({ say, message, setStatus }) => {
    async function respdone() {
        // Clear status when done
        try {
            if (setStatus) await setStatus("");
        } catch (e) {}
    }

    if (message.subtype) return;
    if (message.channel_type == "im" && message.channel.startsWith('D') && message.text) {
        if (!CONVERSATIONS.get(message.user)) {
            CONVERSATIONS.set(message.user, []);
        }

        await setStatus({
            channel_id: message.channel,
            thread_ts: message.thread_ts || message.ts,
            status: 'thinking...',
            loading_messages: [
                'Loading jae…',
                'Teaching the hamsters to type faster…',
                'Untangling the internet cables…',
                'Consulting the office goldfish…',
                'Polishing up the response just for you…',
                'Convincing the AI to stop overthinking…',
            ],
        });

        if (!USER_CACHE.has(message.user)) {
            let userData = (await app.client.users.info({ user: message.user })).user;
            if (!userData) {
                await say({ text: ':warning: Unexpected error: we could not complete your response.' });
                return await respdone();
            } else {
                USER_CACHE.set(message.user, userData);
            }
        }

        let userData = USER_CACHE.get(message.user) || null;

        const modelResponse = await runAI(message.text, CONVERSATIONS.get(message.user) || [], { 
            uid: message.user, 
            cid: message.channel, 
            ct: message.channel_type, 
            cn: message.channel_type === 'im' ? 'dm' : (CHANNEL_CACHE.get(message.channel)?.name || 'unknown'), 
            un: userData.real_name || userData.name, 
            s: { e: emoji.emojify(userData.profile.status_emoji), t: userData.profile.status_text },
            // *just for debug ^^
            userID: message.user,
            channelID: message.channel,
            channelType: 'Direct Message Channel',
            channelName: 'dm',
            userName: userData.real_name || userData.name,
            userStatusEmoji: emoji.emojify(userData.profile.status_emoji),
            userStatusText: userData.profile.status_text
        });
        
        CONVERSATIONS.set(message.user, [
            ...(CONVERSATIONS.get(message.user) || []),
            { role: 'user', content: message.text },
            { role: 'assistant', content: modelResponse }
        ]);

        await say({ text: modelResponse, mrkdwn: true, link_names: true });

        return await respdone();
    }
});

(async () => {
    await app.start();

    try {
        const result = await app.client.conversations.list({ types: 'public_channel,private_channel' });
        for (const channel of result.channels) {
            CHANNEL_CACHE.set(channel.id, channel);
        }
    } catch (e) {
        console.error("failed to pre-cache channels:", e);
    }

    console.log("bot is running!");
})();
