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
import { PENDING_FEEDBACK, insertFeedback } from "./feedback";
import { saveUserSettings, getUserSetting, getUserSettings } from "./user-settings";

import { ChannelCache, UserCache } from "./utils/cache";

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true
});

const CONVERSATIONS = new Map();
const CHANNEL_CACHE = new ChannelCache({ app });
const USER_CACHE = new UserCache({ app });
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

async function runAI(prompt: string, conversation = [], additionalData = {}, with_tools: boolean = true, uS: {[key: string]:any} = {}) {
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
        think: (process.env.THINKING_MODE?.trim().toLowerCase() == "false" ? false : uS.thinkingMode ?? true),
        stream: (process.env.STREAM_MODE?.trim().toLowerCase() == "false" ? false : true) as true,
        tools: with_tools ? uS.toolCalling != false ? TOOLS.rawJson : undefined : undefined
    });

    return request;
}

app.command("/jae-ping", async ({ command, ack, respond }) => {
    const start = Date.now();
    await ack();
    const latency = Date.now() - start;
    await respond({ text: `Pong!\nLatency: ${latency}ms` });
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

app.event('app_home_opened', async ({ event, client }) => {
    const userSettings = getUserSettings(event.user);

    const options: [Array<any>, Array<any>] = [
        [
            {
                text: { type: 'plain_text' as const, text: 'thinking mode' },
                value: 'thinking_mode'
            },
            {
                text: { type: 'plain_text' as const, text: 'tool calling' },
                value: 'tool_calling'
            }
        ],
        [
            {
                text: { type: 'plain_text' as const, text: 'ask for feedback collection' },
                value: 'feedback_collection_ask'
            }
        ]
    ];

    let initialOptions : Array<any> = [];

    options.forEach(element => {
        initialOptions.push(element.filter(
            opt => {
                if (opt.value === 'thinking_mode' && process.env.THINKING_MODE?.toLowerCase().trim() == "true") return userSettings.thinkingMode ?? process.env.THINKING_MODE?.toLowerCase().trim() == "true";
                if (opt.value === 'tool_calling' && process.env.TOOLS_ENABLED?.toLowerCase().trim() == "true") return userSettings.toolCalling ?? process.env.TOOLS_ENABLED?.toLowerCase().trim() == "true";
                if (opt.value === 'feedback_collection_ask') return (userSettings.feedbackCollection || {}).Ask || true;
                return false;
            }
        ));
    });

    await client.views.publish({
        user_id: event.user,
        view: {
            type: 'home',
            blocks: [
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: '*bot configuration & settings*' }
                },
                {
                    type: 'divider'
                },
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: '*behavior*' },
                    accessory: {
                        type: 'checkboxes',
                        action_id: 'settings_toggles',
                        options: options[0],
                        initial_options: initialOptions[0].length > 0 ? initialOptions[0] : undefined
                    }
                },
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: '*others*' },
                    accessory: {
                        type: 'checkboxes',
                        action_id: 'settings_toggles',
                        options: options[1],
                        initial_options: initialOptions[1].length > 0 ? initialOptions[1] : undefined
                    }
                },
            ]
        }
    });
});

app.action('settings_toggles', async ({ ack, action, body }) => {
    await ack();

    if (action.type === "checkboxes") {
        // action.selected_options gives array of what is currently turned on
        const selectedValues = action.selected_options.map(opt => opt.value);

        const isThinkingMode = selectedValues.includes('thinking_mode');
        const isToolCalling = selectedValues.includes('tool_calling');
        const isFeedbackCollectionAsk = selectedValues.includes('feedback_collection_ask');
        
        saveUserSettings(body.user.id, {
            thinkingMode: isThinkingMode,
            toolCalling: isToolCalling,
            feedbackCollection: {
                Ask: isFeedbackCollectionAsk
            }
        });
    }
});

async function processMessagePipeline({ message, say, setStatus, sayStream }: any) {
    const msg = message as GenericMessageEvent;
    const threadKey = `${msg.channel}:${msg.thread_ts || msg.ts}`;

    async function respdone() {
        // Clear status when done
        try {
            if (setStatus) await setStatus("");
        } catch (e) { }
    }

    if (!CONVERSATIONS.get(threadKey)) {
        CONVERSATIONS.set(threadKey, []);
    }

    const userData = await USER_CACHE.none_and_cache(msg.user);
    const currentUserSettings = getUserSettings(msg.user);

    if (!userData) {
        await say({ text: ':warning: Unexpected error: we could not complete your response.' });
        return;
    }

    async function makemodelresponse(with_tools: boolean = true): Promise<[void | AbortableAsyncIterator<ChatResponse> | ChatResponse, string, string, Array<any>]> {
        const channel = await CHANNEL_CACHE.none_and_cache(msg.channel);
        return [await runAI(msg.text || "", (CONVERSATIONS.get(threadKey) || []).slice(-parseInt(process.env.MAX_PREVIOUS_MESSAGES || "15")), {
            uid: msg.user,
            cid: msg.channel,
            ct: msg.channel_type,
            cn: msg.channel_type === 'im' ? 'dm' : (channel?.name || 'unknown'),
            un: userData?.real_name || userData?.name,
            s: { e: emoji.emojify(userData?.profile?.status_emoji || ''), t: userData?.profile?.status_text },
            userID: msg.user,
            channelID: msg.channel,
            channelType: msg.channel_type,
            channelName: msg.channel_type === 'im' ? 'dm' : (channel?.name || 'unknown'),
            userName: userData?.real_name || userData?.name,
            userStatusEmoji: emoji.emojify(userData?.profile?.status_emoji || ''),
            userStatusText: userData?.profile?.status_text
        }, with_tools, currentUserSettings), "", "", []];
    }

    async function setstatus() {
        await setStatus({
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
                const threadMessages = result.messages.map(m => {
                    if (m.user === process.env.SLACK_BOT_MEMBER_ID) {
                        let content = (m.blocks || [])
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
                            .trim() || m.text || '';
                        return { role: 'assistant', content: content };
                    } else {
                        return { role: 'user', content: makeMessageContent({ user: m.user, text: m.text }) };
                    }
                });
                CONVERSATIONS.set(threadKey, threadMessages);
            }
        } catch (e) {
            console.error("failed to fetch thread messages:", e);
        }
    }

    await setstatus();

    if (message.thread_ts && (!CONVERSATIONS.get(threadKey) || (CONVERSATIONS.get(threadKey) || []).length === 0)) {
        await getchannelmessages();
    }

    let messageSet = false;
    let stream: Stream | null = null;
    let mr = [];

    while (true) {
        let modelResponse = await makemodelresponse(process.env.STREAM_MODE?.toLowerCase().trim() === "true");
        let hadToolCalls = false;

        if (!messageSet) {
            CONVERSATIONS.set(threadKey, [
                ...(CONVERSATIONS.get(threadKey) || []),
                { role: 'user', content: makeMessageContent({ user: message.user, text: message.text }) }
            ]);
            messageSet = true;
        }

        if (modelResponse[0]?.constructor.name === "ChatResponse") {
            modelResponse[1] = (modelResponse[0] as ChatResponse).message.content;
            modelResponse[2] = (modelResponse[0] as ChatResponse).message.thinking || "";
            mr.push(modelResponse);

            const blocks = [];

            if ((currentUserSettings.feedbackCollection || {}).Ask) {
                blocks.push({
                    type: "actions",
                    elements: [
                        { type: "button", text: { type: "plain_text", text: "👍" }, action_id: "feedback_positive", value: message.ts },
                        { type: "button", text: { type: "plain_text", text: "👎" }, action_id: "feedback_negative", value: message.ts }
                    ]
                });
            }

            const m = await say({ text: modelResponse[1], mrkdwn: true, link_names: true, thread_ts: message.thread_ts || message.ts, blocks });

            if (m.ok && m.ts && (currentUserSettings.feedbackCollection || {}).Ask) {
                PENDING_FEEDBACK.set(m.ts, {
                    userMessage: message.text || '',
                    modelMessages: JSON.stringify(mr),
                    threadKey,
                    userId: message.user
                });
            }
        } else {
            if (!stream) {
                stream = new Stream({ sayStreamFunction: sayStream, message, tools: TOOLS });
            } else {
                stream.reset();
            }

            const streamProc = stream.process(modelResponse as [AbortableAsyncIterator<ChatResponse>, string, string, Array<any>]);
            try {
                for await (const mut of streamProc) {
                    if (mut.type === "content") {
                        modelResponse[1] += mut.content;
                        modelResponse[2] += mut.thinkingContent;
                    }
                    if (mut.type === "tool_calls") {
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
                await stream.append({ markdown_text: '\n\n:x:' });
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

    if (stream?.stream.ts && currentUserSettings.feedbackCollection.Ask) {
        PENDING_FEEDBACK.set(stream?.stream.ts, {
            userMessage: message.text || '',
            modelMessages: JSON.stringify(mr),
            threadKey,
            userId: message.user
        });

        await stream?.append({
            chunks: [{
                type: "blocks",
                blocks: [{
                    type: "actions",
                    elements: [
                        { type: "button", text: { type: "plain_text", text: "👍" }, action_id: "feedback_positive", value: message.ts },
                        { type: "button", text: { type: "plain_text", text: "👎" }, action_id: "feedback_negative", value: message.ts }
                    ]
                }]
            }]
        });
    }

    await stream?.stop();
    return await respdone();
}

app.message(async ({ say, message, setStatus, sayStream, event }) => {
    if (event.subtype || message.subtype || !message.text) return;

    const isDM = message.channel_type === "im" && message.channel.startsWith('D');
    const isChannelMention = (message.channel_type === 'channel' || message.channel_type === 'group') &&
        (message.channel.startsWith('C') || message.channel.startsWith('G')) &&
        message.text.includes(`<@${process.env.SLACK_BOT_MEMBER_ID}>`);

    if (isDM || isChannelMention) {
        await processMessagePipeline({ message, say, setStatus, sayStream });
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

            let addToolCondition = true;

            if (mod.default.default.addToolCondition) {
                addToolCondition = await mod.default.default.addToolCondition();
            }

            if (addToolCondition === true) {
                TOOLS.add(mod.default.default.config, mod.default.default.callback);
                console.log(`SUCCESS loaded tool: tools/${file} as ${mod.default.default.config.function.name}`);
            } else {
                console.warn(`WARN tool was not loaded as the condition was not true and instead another value: tools/${file} as ${mod.default.default.config.function.name} - complaint: ${addToolCondition}`);
            }
        }
    }

    await app.start();

    await CHANNEL_CACHE.prefetch();

    console.log("bot is running!");
})();
