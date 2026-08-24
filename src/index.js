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

function makeMessageContent(messageInfoProps = {}) {
    const { user, text } = messageInfoProps;
    const userData = USER_CACHE.get(user) || {};
    return `<MESSAGE_INFO><AUTHOR><MENTION><@${user}></MENTION><NAME>${userData.real_name || userData.name || 'Unknown User'}</NAME></AUTHOR></MESSAGE_INFO><CONTENT>${text}</CONTENT>`;
}

const parseThinkingSections = (thinkingText, { final = false } = {}) => {
    const source = String(thinkingText || '');
    if (!source.trim()) return [];

    const sections = [];
    let current = null;

    const pushCurrent = () => {
        if (!current) return;
        const body = current.body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
        if (current.title || body) sections.push({ title: current.title, body });
    };

    const lines = source.split('\n');
    const linesToProcess = final || source.endsWith('\n') ? lines : lines.slice(0, -1);

    for (const rawLine of linesToProcess) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        const numberedMatch = trimmed.match(/^\d+\.\s*(.+)$/);
        if (numberedMatch) {
            pushCurrent();
            const rest = numberedMatch[1].trim();
            const headingMatch = rest.match(/^(?:\*\*)?([^:*]+?)(?:\*\*)?:\s*(.*)$/);
            const title = (headingMatch ? headingMatch[1] : rest).replaceAll('*', '').trim();
            const remainder = headingMatch ? headingMatch[2].replaceAll('*', '').trim() : '';
            current = { title, body: [] };
            if (remainder) current.body.push(remainder);
            continue;
        }

        if (!current) continue;

        const lineBody = trimmed
            .replace(/^[-*•]\s+/, '')
            .replaceAll('*', '')
            .trim();

        if (lineBody) current.body.push(lineBody);
    }

    pushCurrent();
    return sections;
};

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
            temperature: parseFloat(process.env.TEMPERATURE || 0.8),
            num_predict: -1
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

app.message(async ({ say, message, setStatus, sayStream, event, client }) => {
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

        let modelResponse = [await runAI(message.text, (CONVERSATIONS.get(threadKey) || []).slice(-parseInt(process.env.MAX_PREVIOUS_MESSAGES || "15")), { 
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
        }), "", ""];

        if (modelResponse[0].constructor.name == "ChatResponse") {
            // not streaming
            modelResponse[1] = modelResponse[0].message.content;

            await say({ text: modelResponse[1], mrkdwn: true, link_names: true, thread_ts: message.thread_ts || message.ts }); // reply in thread
        } else {
            // it's an asynciterator
            const stream = sayStream({ thread_ts: message.thread_ts || message.ts });
            try {
                let thinkingBuffer = '';
                let activeStepsMap = new Map();
                let reasoningInitialized = false;
                let lastNewlinePos = 0;

                for await (const part of modelResponse[0]) {
                    const hasThinkingField = typeof part?.message?.thinking === 'string';
                    const thinkingChunk = hasThinkingField ? part.message.thinking : '';

                    if (hasThinkingField && thinkingChunk) {
                        thinkingBuffer += thinkingChunk;

                        const newNewlinePos = thinkingBuffer.lastIndexOf('\n');
                        if (newNewlinePos > lastNewlinePos) {
                            lastNewlinePos = newNewlinePos;

                            if (!reasoningInitialized) {
                                reasoningInitialized = true;
                                await stream.append({
                                    chunks: [{ type: "plan_update", title: "My thoughts" }]
                                });
                            }

                            const sections = parseThinkingSections(thinkingBuffer);
                            const chunksToEmit = [];

                            for (let i = 0; i < sections.length; i++) {
                                const section = sections[i];
                                const stepId = `step_${i + 1}`;
                                const isCompletedStep = i < sections.length - 1;
                                const existing = activeStepsMap.get(stepId);

                                if (!existing) {
                                    chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "in_progress" });
                                    activeStepsMap.set(stepId, { title: section.title, sentDetails: false });
                                } else if (isCompletedStep && !existing.sentDetails) {
                                    chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "complete", details: section.body || undefined });
                                    activeStepsMap.get(stepId).sentDetails = true;
                                }
                            }

                            if (chunksToEmit.length > 0) {
                                await stream.append({ chunks: chunksToEmit });
                            }
                        }
                    }

                    if (part.message.content) {
                        modelResponse[1] += part.message.content;

                        if (reasoningInitialized && activeStepsMap.size > 0) {
                            const sections = parseThinkingSections(thinkingBuffer, { final: true });
                            const finalEmits = [];

                            sections.forEach((section, index) => {
                                const stepId = `step_${index + 1}`;
                                const existing = activeStepsMap.get(stepId);
                                finalEmits.push({
                                    type: "task_update",
                                    id: stepId,
                                    title: section.title,
                                    status: "complete",
                                    details: (!existing?.sentDetails && section.body) ? section.body : undefined
                                });
                            });

                            await stream.append({ chunks: finalEmits });
                            activeStepsMap.clear();
                            thinkingBuffer = ''; // reset so re-entries are clean
                            reasoningInitialized = false;
                            lastNewlinePos = 0;
                        }

                        await stream.append({ markdown_text: part.message.content });
                    }

                    if (part.done) break;
                }
            } catch (e) {
                await stream.append({ markdown_text: '\n\n:x:' }); // marks an error
            } finally {
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

            let modelResponse = [await runAI(message.text, (CONVERSATIONS.get(threadKey) || []).slice(-parseInt(process.env.MAX_PREVIOUS_MESSAGES || "15")), { 
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
            }), "", ""];

            if (modelResponse[0].constructor.name == "ChatResponse") {
                // not streaming
                modelResponse[1] = modelResponse[0].message.content;

                await say({ text: modelResponse[1], mrkdwn: true, link_names: true, thread_ts: message.thread_ts || message.ts }); // reply in thread
            } else {
                // it's an asynciterator
                const stream = sayStream({ thread_ts: message.thread_ts || message.ts, task_display_mode: "plan" });
                try {
                    let thinkingBuffer = '';
                    let activeStepsMap = new Map();
                    let reasoningInitialized = false;
                    let lastNewlinePos = 0;

                    for await (const part of modelResponse[0]) {
                        const hasThinkingField = typeof part?.message?.thinking === 'string';
                        const thinkingChunk = hasThinkingField ? part.message.thinking : '';

                        if (hasThinkingField && thinkingChunk) {
                            thinkingBuffer += thinkingChunk;

                            const newNewlinePos = thinkingBuffer.lastIndexOf('\n');
                            if (newNewlinePos > lastNewlinePos) {
                                lastNewlinePos = newNewlinePos;

                                if (!reasoningInitialized) {
                                    reasoningInitialized = true;
                                    await stream.append({
                                        chunks: [{ type: "plan_update", title: "My thoughts" }]
                                    });
                                }

                                const sections = parseThinkingSections(thinkingBuffer);
                                const chunksToEmit = [];

                                for (let i = 0; i < sections.length; i++) {
                                    const section = sections[i];
                                    const stepId = `step_${i + 1}`;
                                    const isCompletedStep = i < sections.length - 1;
                                    const existing = activeStepsMap.get(stepId);

                                    if (!existing) {
                                        chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "in_progress" });
                                        activeStepsMap.set(stepId, { title: section.title, sentDetails: false });
                                    } else if (isCompletedStep && !existing.sentDetails) {
                                        chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "complete", details: section.body || undefined });
                                        activeStepsMap.get(stepId).sentDetails = true;
                                    }
                                }

                                if (chunksToEmit.length > 0) {
                                    await stream.append({ chunks: chunksToEmit });
                                }
                            }
                        }

                        if (part?.message?.content) {
                            modelResponse[1] += part.message.content;

                            if (reasoningInitialized && activeStepsMap.size > 0) {
                                const sections = parseThinkingSections(thinkingBuffer, { final: true });
                                const finalEmits = [];

                                sections.forEach((section, index) => {
                                    const stepId = `step_${index + 1}`;
                                    const existing = activeStepsMap.get(stepId);
                                    finalEmits.push({
                                        type: "task_update",
                                        id: stepId,
                                        title: section.title,
                                        status: "complete",
                                        details: (!existing?.sentDetails && section.body) ? section.body : undefined
                                    });
                                });

                                await stream.append({ chunks: finalEmits });
                                activeStepsMap.clear();
                                thinkingBuffer = ''; // reset so re-entries are clean
                                reasoningInitialized = false;
                                lastNewlinePos = 0;
                            }

                            await stream.append({
                                markdown_text: part.message.content
                            });
                        }

                        if (part.done) break;
                    }
                } catch (e) {
                    await stream.append({ markdown_text: '\n\n:x:' }); // marks an error
                } finally {
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
