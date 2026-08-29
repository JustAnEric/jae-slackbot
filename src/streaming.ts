import type { SayStreamFn } from "@slack/bolt";
import type { AnyChunk, GenericMessageEvent } from "@slack/types";
import type { ChatAppendStreamArguments, WebClient } from "@slack/web-api";
import type { ChatResponse, AbortableAsyncIterator } from "ollama";

import type { Tools } from "./tool-calling";

const parseThinkingSections = (thinkingText: string, { final = false } = {}) => {
    const source = String(thinkingText || '');
    if (!source.trim()) return [];

    const sections : Array<{ title: string, body: string[] | string }> = [];
    let current: { title: string, body: string[] } | null = null;

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
            const rest = numberedMatch[1]?.trim();
            const headingMatch = rest?.match(/^(?:\*\*)?([^:*]+?)(?:\*\*)?:\s*(.*)$/);
            const title = (headingMatch ? headingMatch[1] : rest)?.replaceAll('*', '').trim();
            if (!title) continue;
            const remainder = headingMatch ? headingMatch[2]?.replaceAll('*', '').trim() : '';
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

class Stream {
    sayStream: SayStreamFn;
    message: GenericMessageEvent;
    tools: Tools;
    stream: ReturnType<WebClient["chatStream"]>;
    thinkingBuffer: string;
    activeStepsMap: Map<string, { title: string, sentDetails?: boolean }>;
    reasoningInitialized: boolean;
    toolCallInitialized: boolean;
    toolCalls: Array<any>;
    lastNewlinePos: number;

    constructor({ sayStreamFunction, message, tools }: { sayStreamFunction: SayStreamFn, message: GenericMessageEvent, tools: Tools }) {
        this.sayStream = sayStreamFunction;
        this.message = message;
        this.tools = tools;
        this.stream = this.sayStream({
            thread_ts: message.thread_ts || message.ts,
            task_display_mode: "plan"
        });
        this.thinkingBuffer = '';
        this.activeStepsMap = new Map();
        this.reasoningInitialized = false;
        this.toolCallInitialized = false;
        this.toolCalls = [];
        this.lastNewlinePos = 0;
    }

    private async flushThinking() {
        if (!this.reasoningInitialized || this.activeStepsMap.size === 0) return;

        const sections = parseThinkingSections(this.thinkingBuffer, { final: true });
        const finalEmits: Array<AnyChunk> = sections.map((section, index) => {
            const stepId = `step_${index + 1}`;
            const existing = this.activeStepsMap.get(stepId);
            return {
                type: "task_update",
                id: stepId,
                title: section.title,
                status: "complete",
                details: (!existing?.sentDetails && section.body) ? section.body as string : undefined
            };
        });

        await this.stream.append({ chunks: finalEmits });
        this.activeStepsMap.clear();
        this.thinkingBuffer = '';
        this.reasoningInitialized = false;
        this.lastNewlinePos = 0;
    }

    reset() {
        this.thinkingBuffer = '';
        this.activeStepsMap.clear();
        this.reasoningInitialized = false;
        this.toolCallInitialized = false;
        this.lastNewlinePos = 0;
    }

    async *process(modelResponse: [AbortableAsyncIterator<ChatResponse>, ...any]) {
        for await (const part of modelResponse[0]) {
            const result = await this.chunk(part);
            yield result;
        }
    }

    async chunk(part: ChatResponse) {
        // process the chunk
        const hasThinkingField = typeof part?.message?.thinking === 'string';
        const thinkingChunk = hasThinkingField ? part.message.thinking : '';

        let modelResponse : [null, string, string, Array<any>] = [null, "", "", []];

        if (hasThinkingField && thinkingChunk) {
            this.thinkingBuffer += thinkingChunk;
            modelResponse[2] += thinkingChunk;

            const newNewlinePos = this.thinkingBuffer.lastIndexOf('\n');
            if (newNewlinePos > this.lastNewlinePos) {
                this.lastNewlinePos = newNewlinePos;

                if (!this.reasoningInitialized) {
                    this.reasoningInitialized = true;
                    await this.stream.append({
                        chunks: [{ type: "plan_update", title: "My thoughts" }]
                    });
                }

                const sections = parseThinkingSections(this.thinkingBuffer);
                const chunksToEmit: Array<AnyChunk> = [];

                for (let i = 0; i < sections.length; i++) {
                    const section = sections[i];
                    if (!section) continue;
                    const stepId = `step_${i + 1}`;
                    const isCompletedStep = i < sections.length - 1;
                    const existing = this.activeStepsMap.get(stepId);

                    if (!existing) {
                        chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "in_progress" });
                        this.activeStepsMap.set(stepId, { title: section.title, sentDetails: false });
                    } else if (isCompletedStep && !existing.sentDetails) {
                        chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "complete", details: section.body as string || undefined });
                        let step = this.activeStepsMap.get(stepId);
                        if (step) step.sentDetails = true;
                    }
                }

                if (chunksToEmit.length > 0) {
                    await this.stream.append({ chunks: chunksToEmit });
                }
            }
        }

        if (part.message.content) {
            modelResponse[1] += part.message.content;

            await this.flushThinking();

            await this.stream.append({ markdown_text: part.message.content });
        }

        if (part.message.tool_calls) {
            await this.flushThinking();

            if (!this.toolCallInitialized) {
                this.toolCallInitialized = true;
                await this.stream.append({
                    chunks: [{ type: "plan_update", title: "Tools" }]
                });
            }

            const toolResults = [];
            for (const toolCall of part.message.tool_calls) {
                const tool = this.tools.get(toolCall.function.name);
                const toolCallId = crypto.randomUUID();

                if (!tool) {
                    // tool doesn't exist
                    await this.stream.append({ chunks: [{ type: "task_update", id: toolCallId, title: `${toolCall.function.name}()`, details: "This tool does not exist.", status: "error" }] });
                    toolResults.push({ toolCall: null, result: { status: "error", text: `The tool you have called does not exist.`, tool_name: toolCall.function.name }, toolCallId });
                    continue;
                }

                await this.stream.append({ chunks: [{ type: "task_update", id: toolCallId, title: `${tool.config.function.name}()`, details: tool.config.function.description || undefined, status: "in_progress" }] });

                let result, error;
                try {
                    result = await tool?.callback(toolCall.function.arguments);
                } catch (e) {
                    error = e;
                    result = { status: "error", text: `The tool you have called has encountered an error.`, tool_name: toolCall.function.name };
                }

                if (!error && result) {
                    await this.stream.append({ chunks: [{ type: "task_update", id: toolCallId, title: `${tool.config.function.name}()`, details: undefined, status: "complete" }] });
                } else {
                    await this.stream.append({ chunks: [{ type: "task_update", id: toolCallId, title: `${tool.config.function.name}()`, details: '\nThere was an error running this tool.', status: "error" }] });
                    console.error(`Error running tool [${tool.config.function.name}]:\n${error}`);
                }

                toolResults.push({ toolCall, result, toolCallId });
            }

            return { type: 'tool_calls' as const, toolResults };
        }

        return { type: 'content' as const, content: modelResponse[1], thinkingContent: modelResponse[2] };
    }

    async stop() {
        return await this.stream.stop();
    }

    async append(data: Omit<ChatAppendStreamArguments, 'channel' | 'ts'>) {
        return await this.stream.append(data);
    }
}

export { Stream };