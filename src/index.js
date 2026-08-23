require("dotenv").config();

const axios = require("axios");
const emoji = require('node-emoji');
const fs = require('fs');
const path = require('path');
const remark = require('remark');
const remarkRemoveComments = require('remark-remove-comments');

const { App } = require("@slack/bolt");
const { Ollama } = require("ollama");
const { ChatResponse } = require("ollama/browser");

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

function makeMessageContent(messageInfoProps = {}) {
    const { user, text } = messageInfoProps;
    const userData = USER_CACHE.get(user) || {};
    return `<MESSAGE_INFO><AUTHOR><MENTION><@${user}></MENTION><NAME>${userData.real_name || userData.name || 'Unknown User'}</NAME></AUTHOR></MESSAGE_INFO><CONTENT>${text}</CONTENT>`;
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
        think: process.env.THINKING_MODE.trim().toLowerCase() == "false" ? false : true,
        stream: process.env.STREAM_MODE.trim().toLowerCase() == "false" ? false : true
    });

    return request;
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

app.message(async ({ say, message, setStatus, sayStream, event }) => {
    async function respdone() {
        // Clear status when done
        try {
            if (setStatus) await setStatus("");
        } catch (e) {}
    }

    async function setstatus() {
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
    }

    const subtype = event.subtype || message.subtype;

    if (subtype) return;

    const threadKey = `${message.channel}:${message.thread_ts || message.ts}`;

    if (message.channel_type == "im" && message.channel.startsWith('D') && message.text) {
        if (!CONVERSATIONS.get(threadKey)) {
            CONVERSATIONS.set(threadKey, []);
        }

        await setstatus();

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

        // check if thread_ts is set, if the thread key is unpopulated, grab messages and populate
        if (message.thread_ts && (!CONVERSATIONS.get(threadKey) || (CONVERSATIONS.get(threadKey) || []).length == 0)) {
            try {
                const result = await app.client.conversations.replies({
                    channel: message.channel,
                    ts: message.thread_ts
                });

                if (result && result.messages) {
                    const threadMessages = result.messages.map(msg => {
                        return { role: msg.user === process.env.SLACK_BOT_MEMBER_ID ? 'assistant' : 'user', content: msg.user === process.env.SLACK_BOT_MEMBER_ID ? msg.text : makeMessageContent({ user: msg.user, text: msg.text }) };
                    });
                    CONVERSATIONS.set(threadKey, threadMessages);
                }
            } catch (e) {
                console.error("failed to fetch thread messages:", e);
            }
        }

        let modelResponse = [await runAI(message.text, CONVERSATIONS.get(threadKey) || [], { 
            uid: message.user, 
            cid: message.channel, 
            ct: message.channel_type, 
            cn: message.channel_type === 'im' ? 'dm' : (CHANNEL_CACHE.get(message.channel)?.name || 'unknown'), 
            un: userData.real_name || userData.name, 
            s: { e: emoji.emojify(userData.profile.status_emoji || ''), t: userData.profile.status_text },
            // *just for debug ^^
            userID: message.user,
            channelID: message.channel,
            channelType: 'Direct Message Channel',
            channelName: 'dm',
            userName: userData.real_name || userData.name,
            userStatusEmoji: emoji.emojify(userData.profile.status_emoji || ''),
            userStatusText: userData.profile.status_text
        }), ""];

        if (modelResponse[0].constructor.name == "ChatResponse") {
            // not streaming
            modelResponse[1] = modelResponse[0].message.content;

            await say({ text: modelResponse[1], mrkdwn: true, link_names: true, thread_ts: message.thread_ts || message.ts }); // reply in thread
        } else {
            // it's an asynciterator
            const stream = sayStream({ thread_ts: message.thread_ts || message.ts });
            try {
                for await (const part of modelResponse[0]) {
                    if (part.done) {
                        await stream.stop();
                        break;
                    }
                    if (part.message.content) {
                        modelResponse[1] += part.message.content;
                        await stream.append({ markdown_text: part.message.content });
                    }
                }
            } catch (e) {
                await stream.append({ markdown_text: '\n\n:x:' }); // marks an error
                await stream.stop();
            }
        }

        CONVERSATIONS.set(threadKey, [
            ...(CONVERSATIONS.get(threadKey) || []),
            { role: 'user', content: makeMessageContent({ user: message.user, text: message.text }) },
            { role: 'assistant', content: modelResponse[1] }
        ]);

        return await respdone();
    } else if ((message.channel_type === 'channel' || message.channel_type === 'group') && (message.channel.startsWith('C') || message.channel.startsWith('G'))) {
        if (message.text && ((message.text.includes(`<@${process.env.SLACK_BOT_MEMBER_ID}>`) || message.thread_ts) && message.channel === process.env.SLACK_BOT_TEST_CHANNEL)) {
            if (!CONVERSATIONS.get(threadKey)) {
                CONVERSATIONS.set(threadKey, []);
            }

            await setstatus();

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

            // check if thread_ts is set, if the thread key is unpopulated, grab messages and populate
            if (message.thread_ts && (!CONVERSATIONS.get(threadKey) || (CONVERSATIONS.get(threadKey) || []).length == 0)) {
                try {
                    const result = await app.client.conversations.replies({
                        channel: message.channel,
                        ts: message.thread_ts
                    });

                    if (result && result.messages) {
                        const threadMessages = result.messages.map(msg => {
                            return { role: msg.user === process.env.SLACK_BOT_MEMBER_ID ? 'assistant' : 'user', content: msg.user === process.env.SLACK_BOT_MEMBER_ID ? msg.text : makeMessageContent({ user: msg.user, text: msg.text }) };
                        });
                        CONVERSATIONS.set(threadKey, threadMessages);
                    }
                } catch (e) {
                    console.error("failed to fetch thread messages:", e);
                }
            }

            let modelResponse = [await runAI(message.text, CONVERSATIONS.get(threadKey) || [], { 
                uid: message.user, 
                cid: message.channel, 
                ct: message.channel_type, 
                cn: CHANNEL_CACHE.get(message.channel)?.name || 'unknown',
                un: userData.real_name || userData.name, 
                s: { e: emoji.emojify(userData.profile.status_emoji || ''), t: userData.profile.status_text },
                // *just for debug ^^
                userID: message.user,
                channelID: message.channel,
                channelType: message.channel_type === 'channel' ? 'Public Channel' : 'Private Channel',
                channelName: CHANNEL_CACHE.get(message.channel)?.name || 'unknown',
                userName: userData.real_name || userData.name,
                userStatusEmoji: emoji.emojify(userData.profile.status_emoji || ''),
                userStatusText: userData.profile.status_text
            }), ""];

            if (modelResponse[0].constructor.name == "ChatResponse") {
                // not streaming
                modelResponse[1] = modelResponse[0].message.content;

                await say({ text: modelResponse[1], mrkdwn: true, link_names: true, thread_ts: message.thread_ts || message.ts }); // reply in thread
            } else {
                // it's an asynciterator
                const stream = sayStream({ thread_ts: message.thread_ts || message.ts });
                try {
                    for await (const part of modelResponse[0]) {
                        if (part.done) {
                            await stream.stop();
                            break;
                        }
                        if (part.message.content) {
                            modelResponse[1] += part.message.content;
                            await stream.append({ markdown_text: part.message.content });
                        }
                    }
                } catch (e) {
                    await stream.append({ markdown_text: '\n\n:x:' }); // marks an error
                    await stream.stop();
                }
            }

            CONVERSATIONS.set(threadKey, [
                ...(CONVERSATIONS.get(threadKey) || []),
                { role: 'user', content: makeMessageContent({ user: message.user, text: message.text }) },
                { role: 'assistant', content: modelResponse[1] }
            ]);

            return await respdone();
        }
    }
});

(async () => {
    await app.start();


    try {
        const result = await app.client.conversations.list({ types: 'public_channel,private_channel,im' });
        for (const channel of result.channels) {
            CHANNEL_CACHE.set(channel.id, channel);
        }
    } catch (e) {
        console.error("failed to pre-cache channels:", e);
    }

    console.log("bot is running!");
})();
