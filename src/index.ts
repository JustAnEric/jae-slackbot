import "dotenv/config";
import startChecks from "./start-checks";

import axios from "axios";
const emoji = require('node-emoji');
import remark from 'remark';
import remarkRemoveComments from 'remark-remove-comments';

import { App, BlockAction, ButtonAction } from "@slack/bolt";
import { GenericMessageEvent } from "@slack/types";
import { AbortableAsyncIterator, ChatResponse } from "ollama";

import globals from "./globals";
import { Stream } from "./streaming";
import { Tools } from "./tool-calling";
import { PENDING_FEEDBACK, db, insertFeedback } from "./feedback";

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true
});

const CONVERSATIONS = new Map();
const CHANNEL_CACHE = new Map();
const USER_CACHE = new Map();
const TOOLS = new Tools();

//<|think|>
const systemPrompt = remark.remark()
                        .use(remarkRemoveComments)
                        .processSync(globals.fs.readFileSync(globals.path.join(__dirname, '..', 'PROMPT.md')))
                        .toString('utf-8')
                        .trim();

function promptTemplate(template: string, vars: Record<string, any>) {
    return template.replace(/\{([^}]+)\}/g, (match, key) => {
        return key in vars ? vars[key] : match;
    });
}

function makeMessageContent(messageInfoProps: { user?: string, text?: string } = {}) {
    const { user, text } = messageInfoProps;
    const userData = USER_CACHE.get(user) || {};
    return `<MESSAGE_INFO><AUTHOR><MENTION><@${user}></MENTION><NAME>${userData.real_name || userData.name || 'Unknown User'}</NAME></AUTHOR></MESSAGE_INFO><CONTENT>${emoji.emojify(text)}</CONTENT>`;
}

async function runAI(prompt: string, conversation = [], additionalData = {}, with_tools: boolean = true) {
    if (!globals.ollama) return console.warn("CRTICIAL    Ollama is disabled!!");
    console.log('doing ollama request');

    const system = promptTemplate(systemPrompt, additionalData);

    const request = await globals.ollama.chat({
        messages: [
            { role: 'system', content: system },
            ...conversation,
            { role: 'user', content: prompt }
        ],
        options: {
            num_ctx: parseInt(process.env.CONTEXT_WINDOW_SIZE || "4096"),
            temperature: parseFloat(process.env.TEMPERATURE || "0.8"),
            num_predict: -1
        },
        model: process.env.MODEL || 'gemma4:e2b',
        think: (process.env.THINKING_MODE?.trim().toLowerCase() == "false" ? false : true),
        stream: (process.env.STREAM_MODE?.trim().toLowerCase() == "false" ? false : true) as true,
        tools: with_tools ? TOOLS.rawJson : undefined
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

app.action("feedback_positive", async ({ ack, body, client }) => {
    await ack();
    const bkaction = body as BlockAction<ButtonAction>;
    const messageTs = bkaction.message?.ts || '';
    const channelId = bkaction.channel?.id || '';
    const pending = PENDING_FEEDBACK.get(messageTs);

    if (!pending) {
        //await respond({ response_type: "ephemeral", markdown_text: 'This message has already had feedback!' });
        await client.chat.postEphemeral({
            channel: channelId,
            user: bkaction.user.id,
            thread_ts: messageTs,
            text: "This message has already had feedback!"
        });
        return;
    }

    if (pending?.userId != bkaction.user.id) {
        //await respond({ response_type: "ephemeral", markdown_text: 'You cannot vote on this message, this is not *your* message.' });
        await client.chat.postEphemeral({
            channel: channelId,
            user: bkaction.user.id,
            thread_ts: messageTs,
            markdown_text: "You cannot vote on this message, this is not *your* message."
        });
        return;
    }

    insertFeedback.run(
        messageTs,
        pending?.threadKey,
        bkaction.user.id,
        'positive',
        pending?.userMessage,
        pending?.modelMessages,
        Date.now()
    );

    await client.chat.postEphemeral({
        channel: channelId,
        user: bkaction.user.id,
        thread_ts: messageTs,
        text: "👍 Got it, thanks!"
    });

    PENDING_FEEDBACK.delete(messageTs);
});

app.action("feedback_negative", async ({ ack, body, client }) => {
    await ack();
    const bkaction = body as BlockAction<ButtonAction>;
    const messageTs = bkaction.message?.ts || '';
    const channelId = bkaction.channel?.id || '';
    const pending = PENDING_FEEDBACK.get(messageTs);

    if (!pending) {
        //await respond({ response_type: "ephemeral", markdown_text: 'This message has already had feedback!' });
        await client.chat.postEphemeral({
            channel: channelId,
            user: bkaction.user.id,
            thread_ts: messageTs,
            text: "This message has already had feedback!"
        });
        return;
    }

    if (pending?.userId != bkaction.user.id) {
        //await respond({ response_type: "ephemeral", markdown_text: 'You cannot vote on this message, this is not *your* message.' });
        await client.chat.postEphemeral({
            channel: channelId,
            user: bkaction.user.id,
            thread_ts: messageTs,
            markdown_text: "You cannot vote on this message, this is not *your* message."
        });
        return;
    }

    insertFeedback.run(
        messageTs,
        pending?.threadKey,
        bkaction.user.id,
        'negative',
        pending?.userMessage,
        pending?.modelMessages,
        Date.now()
    );

    await client.chat.postEphemeral({
        channel: channelId,
        user: bkaction.user.id,
        thread_ts: messageTs,
        text: "I've got your feedback, your negativity will be investigated! 😅"
    });

    PENDING_FEEDBACK.delete(messageTs);
});

app.message(async ({ say, message, setStatus, sayStream, event, client }) => {
    if (event.subtype) return;
    if (message.subtype) return;

    const msg = message as GenericMessageEvent;

    const threadKey = `${message.channel}:${message.thread_ts || message.ts}`;

    if (!CONVERSATIONS.get(threadKey)) {
        CONVERSATIONS.set(threadKey, []);
    }

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

    async function respdone() {
        // Clear status when done
        try {
            if (setStatus) await setStatus("");
        } catch (e) {}
    }

    async function makemodelresponse(with_tools: boolean = true): Promise<[void | AbortableAsyncIterator<ChatResponse> | ChatResponse, string, string, Array<any>]> {
        return [await runAI(msg.text || "", (CONVERSATIONS.get(threadKey) || []).slice(-parseInt(process.env.MAX_PREVIOUS_MESSAGES || "15")), { 
            uid: msg.user, 
            cid: msg.channel, 
            ct: msg.channel_type, 
            cn: msg.channel_type === 'im' ? 'dm' : (CHANNEL_CACHE.get(message.channel)?.name || 'unknown'), 
            un: userData.real_name || userData.name, 
            s: { e: emoji.emojify(userData.profile.status_emoji || ''), t: userData.profile.status_text },
            // *just for debug ^^
            userID: msg.user,
            channelID: msg.channel,
            channelType: msg.channel_type,
            channelName: msg.channel_type === 'im' ? 'dm' : (CHANNEL_CACHE.get(message.channel)?.name || 'unknown'),
            userName: userData.real_name || userData.name,
            userStatusEmoji: emoji.emojify(userData.profile.status_emoji || ''),
            userStatusText: userData.profile.status_text
        }, with_tools), "", "", []];
    }

    async function setstatus() {
        await setStatus({
            //channel_id: message.channel,
            //thread_ts: msg.thread_ts || msg.ts,
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

    async function getchannelmessages() {
        try {
            if (!msg.thread_ts) return;
            const result = await app.client.conversations.replies({
                channel: msg.channel,
                ts: msg.thread_ts
            });

            if (result && result.messages) {
                const threadMessages = result.messages.map(msg => {
                    if (msg.user === process.env.SLACK_BOT_MEMBER_ID) {
                        let content = (msg.blocks || [])
                            .filter((b: any) => b.type !== 'actions')
                            .flatMap((b: any) => {
                                if (b.type === 'rich_text') {
                                    return b.elements?.flatMap((el: any) =>
                                        el.elements?.map((e: any) => e.text || '').join('') || ''
                                    ) || [];
                                }
                                if (b.type === 'section') {
                                    return [b.text?.text || ''];
                                }
                                return [];
                            })
                            .join('\n')
                            .trim() || msg.text || '';
                        return { role: 'assistant', content: content };
                    } else {
                        return { role: 'user', content: makeMessageContent({ user: msg.user, text: msg.text }) };
                    }
                });
                CONVERSATIONS.set(threadKey, threadMessages);
            }
        } catch (e) {
            console.error("failed to fetch thread messages:", e);
        }
    }

    if (message.channel_type == "im" && message.channel.startsWith('D') && message.text) {
        await setstatus();

        // check if thread_ts is set, if the thread key is unpopulated, grab messages and populate
        if (message.thread_ts && (!CONVERSATIONS.get(threadKey) || (CONVERSATIONS.get(threadKey) || []).length == 0)) {
            await getchannelmessages();
        }

        let messageSet = false;
        let stream: Stream | null = null;

        let mr = [];

        while (true) {
            let modelResponse = await makemodelresponse(process.env.STREAM_MODE?.toLowerCase().trim() == "true" ? true : false);
            let hadToolCalls = false;

            if (!messageSet) {
                CONVERSATIONS.set(threadKey, [
                    ...(CONVERSATIONS.get(threadKey) || []),
                    { role: 'user', content: makeMessageContent({ user: message.user, text: message.text }) }
                ]);
                messageSet = true;
            }

            if (modelResponse[0]?.constructor.name == "ChatResponse") {
                // not streaming
                modelResponse[1] = (modelResponse[0] as ChatResponse).message.content;
                modelResponse[2] = (modelResponse[0] as ChatResponse).message.thinking || "";

                mr.push(modelResponse);

                const blocks = [
                    {
                        type: "actions",
                        elements: [
                            {
                                type: "button",
                                text: { type: "plain_text", text: "👍" },
                                action_id: "feedback_positive",
                                value: message.ts
                            },
                            {
                                type: "button",
                                text: { type: "plain_text", text: "👎" },
                                action_id: "feedback_negative",
                                value: message.ts
                            }
                        ]
                    }
                ];

                const m = await say({ text: modelResponse[1], mrkdwn: true, link_names: true, thread_ts: message.thread_ts || message.ts, blocks }); // reply in thread

                if (m.ok && m.ts) PENDING_FEEDBACK.set(m.ts, {
                    userMessage: message.text || '',
                    modelMessages: JSON.stringify(mr),
                    threadKey,
                    userId: message.user
                });
            } else {
                // it's an asynciterator

                if (!stream) {
                    stream = new Stream({ sayStreamFunction: sayStream, message, tools: TOOLS });
                } else {
                    stream.reset();
                }

                const streamProc = stream.process(modelResponse as [AbortableAsyncIterator<ChatResponse>, string, string, Array<any>]);
                try {
                    for await (const mut of streamProc) {
                        if (mut.type == "content") {
                            modelResponse[1] += mut.content;
                            modelResponse[2] += mut.thinkingContent;
                            //console.log(modelResponse[1]);
                            //console.log('---');
                            //console.log(modelResponse[2]);
                        }
                        if (mut.type == "tool_calls") {
                            hadToolCalls = true;
                            const history = [];
                            history.push({ role: 'assistant', tool_calls: mut.toolResults.map(r => r.toolCall) });
                            for (const { toolCall, result: toolResult } of mut.toolResults) {
                                history.push({ role: 'tool', content: String(toolResult), tool_name: toolCall?.function.name });
                            }
                            modelResponse[3].push(...mut.toolResults);
                            CONVERSATIONS.set(threadKey, [
                                ...(CONVERSATIONS.get(threadKey) || []), ...history
                            ]);
                        }
                    }
                } catch (e) {
                    console.log(e);
                    await stream.append({ markdown_text: '\n\n:x:' }); // marks an error
                } finally {
                    //await stream.stop();
                }
            }

            if (modelResponse[1].trim()) {
                CONVERSATIONS.set(threadKey, [
                    ...(CONVERSATIONS.get(threadKey) || []),
                    { role: 'assistant', content: modelResponse[1] }
                ]);
            }

            mr.push(modelResponse);

            if (!hadToolCalls) break;
        }

        if (stream?.stream.ts) {
            PENDING_FEEDBACK.set(stream?.stream.ts, {
                userMessage: message.text || '',
                modelMessages: JSON.stringify(mr),
                threadKey,
                userId: message.user
            });

            await stream?.append({
                chunks: [
                    {
                        type: "blocks",
                        blocks: [
                            {
                                type: "actions",
                                elements: [
                                    {
                                        type: "button",
                                        text: { type: "plain_text", text: "👍" },
                                        action_id: "feedback_positive",
                                        value: message.ts
                                    },
                                    {
                                        type: "button",
                                        text: { type: "plain_text", text: "👎" },
                                        action_id: "feedback_negative",
                                        value: message.ts
                                    }
                                ]
                            }
                        ]
                    }
                ]
            });
        }

        await stream?.stop();

        return await respdone();
    } else if ((message.channel_type === 'channel' || message.channel_type === 'group') && (message.channel.startsWith('C') || message.channel.startsWith('G'))) {
        if (message.text && ((message.text.includes(`<@${process.env.SLACK_BOT_MEMBER_ID}>`) || message.thread_ts) && message.channel === process.env.SLACK_BOT_TEST_CHANNEL)) {
            await setstatus();

            // check if thread_ts is set, if the thread key is unpopulated, grab messages and populate
            if (message.thread_ts && (!CONVERSATIONS.get(threadKey) || (CONVERSATIONS.get(threadKey) || []).length == 0)) {
                await getchannelmessages();
            }

            let messageSet = false;
            let stream: Stream | null = null;

            let mr = [];

            while (true) {
                let modelResponse = await makemodelresponse(process.env.STREAM_MODE?.toLowerCase().trim() == "true" ? true : false);
                let hadToolCalls = false;

                if (!messageSet) { // so that tool calls can't repeat sending the user message
                    CONVERSATIONS.set(threadKey, [
                        ...(CONVERSATIONS.get(threadKey) || []),
                        { role: 'user', content: makeMessageContent({ user: message.user, text: message.text }) }
                    ]);
                    messageSet = true;
                }

                if (modelResponse[0]?.constructor.name == "ChatResponse") {
                    // not streaming
                    modelResponse[1] = (modelResponse[0] as ChatResponse).message.content;
                    modelResponse[2] = (modelResponse[0] as ChatResponse).message.thinking || "";

                    mr.push(modelResponse);

                    const blocks = [
                        {
                            type: "actions",
                            elements: [
                                {
                                    type: "button",
                                    text: { type: "plain_text", text: "👍" },
                                    action_id: "feedback_positive",
                                    value: message.ts
                                },
                                {
                                    type: "button",
                                    text: { type: "plain_text", text: "👎" },
                                    action_id: "feedback_negative",
                                    value: message.ts
                                }
                            ]
                        }
                    ];

                    const m = await say({ text: modelResponse[1], mrkdwn: true, link_names: true, thread_ts: message.thread_ts || message.ts, blocks }); // reply in thread

                    if (m.ok && m.ts) PENDING_FEEDBACK.set(m.ts, {
                        userMessage: message.text || '',
                        modelMessages: JSON.stringify(mr),
                        threadKey,
                        userId: message.user
                    });
                } else {
                    // it's an asynciterator

                    if (!stream) {
                        stream = new Stream({ sayStreamFunction: sayStream, message, tools: TOOLS });
                    } else {
                        stream.reset();
                    }

                    const streamProc = stream.process(modelResponse as [AbortableAsyncIterator<ChatResponse>, string, string, Array<any>]);
                    try {
                        for await (const mut of streamProc) {
                            if (mut.type == "content") {
                                modelResponse[1] += mut.content;
                                modelResponse[2] += mut.thinkingContent;
                                //console.log(modelResponse[1]);
                                //console.log('---');
                                //console.log(modelResponse[2]);
                            }
                            if (mut.type == "tool_calls") {
                                hadToolCalls = true;
                                const history = [];
                                history.push({ role: 'assistant', tool_calls: mut.toolResults.map(r => r.toolCall) });
                                for (const { toolCall, result: toolResult } of mut.toolResults) {
                                    history.push({ role: 'tool', content: String(toolResult), tool_name: toolCall?.function.name });
                                }
                                modelResponse[3].push(...mut.toolResults);
                                CONVERSATIONS.set(threadKey, [
                                    ...(CONVERSATIONS.get(threadKey) || []), ...history
                                ]);
                            }
                        }
                    } catch (e) {
                        console.log(e);
                        await stream.append({ markdown_text: '\n\n:x:' }); // marks an error
                    }
                }

                if (modelResponse[1].trim()) {
                    // so that an empty response doesn't create a new message
                    CONVERSATIONS.set(threadKey, [
                        ...(CONVERSATIONS.get(threadKey) || []),
                        { role: 'assistant', content: modelResponse[1] }
                    ]);
                }

                mr.push(modelResponse);

                if (!hadToolCalls) break;
            }

            if (stream?.stream.ts) {
                PENDING_FEEDBACK.set(stream?.stream.ts, {
                    userMessage: message.text || '',
                    modelMessages: JSON.stringify(mr),
                    threadKey,
                    userId: message.user
                });

                await stream?.append({
                    chunks: [
                        {
                            type: "blocks",
                            blocks: [
                                {
                                    type: "actions",
                                    elements: [
                                        {
                                            type: "button",
                                            text: { type: "plain_text", text: "👍" },
                                            action_id: "feedback_positive",
                                            value: message.ts
                                        },
                                        {
                                            type: "button",
                                            text: { type: "plain_text", text: "👎" },
                                            action_id: "feedback_negative",
                                            value: message.ts
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                });
            }

            await stream?.stop();

            return await respdone();
        }
    }
});

(async () => {
    await startChecks();

    // if there are tools, load them in
    if (process.env.TOOLS_ENABLED?.toLowerCase().trim() == "true") {
        const toolsDir = globals.path.join(__dirname, 'tools');
        const alltools = globals.fs.readdirSync(toolsDir);
        for (const file of alltools) {
            // load the tool
            const fileExt = globals.path.extname(globals.path.join(toolsDir, file));
            const mod = await import(`./tools/${file}`);
            if (!mod.default.default.config || !mod.default.default.callback) {
                console.error(`ERROR loading tool: tools/${file}`);
                continue;
            }
            TOOLS.add(mod.default.default.config, mod.default.default.callback);
            console.log(`SUCCESS loaded tool: tools/${file} as ${mod.default.default.config.function.name}`)
        }
    }

    await app.start();

    try {
        const result = await app.client.conversations.list({ types: 'public_channel,private_channel,im' });
        if (result.channels)
        for (const channel of result.channels) {
            CHANNEL_CACHE.set(channel.id, channel);
        }
    } catch (e) {
        console.error("failed to pre-cache channels:", e);
    }

    console.log("bot is running!");
})();
