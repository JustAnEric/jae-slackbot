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

class Stream {
    constructor(sayStreamFunction, message) {
        this.sayStream = sayStreamFunction;
        this.message = message;
        this.stream = this.sayStream({
            thread_ts: message.thread_ts || message.ts,
            task_display_mode: "plan"
        });
        this.thinkingBuffer = '';
        this.activeStepsMap = new Map();
        this.reasoningInitialized = false;
        this.lastNewlinePos = 0;
    }

    async *process(modelResponse) {
        for await (const part of modelResponse[0]) {
            yield await this.chunk(part);
        }
    }

    async chunk(part) {
        // process the chunk
        const hasThinkingField = typeof part?.message?.thinking === 'string';
        const thinkingChunk = hasThinkingField ? part.message.thinking : '';

        let modelResponse = [null, "", ""];

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
                const chunksToEmit = [];

                for (let i = 0; i < sections.length; i++) {
                    const section = sections[i];
                    const stepId = `step_${i + 1}`;
                    const isCompletedStep = i < sections.length - 1;
                    const existing = this.activeStepsMap.get(stepId);

                    if (!existing) {
                        chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "in_progress" });
                        this.activeStepsMap.set(stepId, { title: section.title, sentDetails: false });
                    } else if (isCompletedStep && !existing.sentDetails) {
                        chunksToEmit.push({ type: "task_update", id: stepId, title: section.title, status: "complete", details: section.body || undefined });
                        this.activeStepsMap.get(stepId).sentDetails = true;
                    }
                }

                if (chunksToEmit.length > 0) {
                    await this.stream.append({ chunks: chunksToEmit });
                }
            }
        }

        if (part.message.content) {
            modelResponse[1] += part.message.content;

            if (this.reasoningInitialized && this.activeStepsMap.size > 0) {
                const sections = parseThinkingSections(this.thinkingBuffer, { final: true });
                const finalEmits = [];

                sections.forEach((section, index) => {
                    const stepId = `step_${index + 1}`;
                    const existing = this.activeStepsMap.get(stepId);
                    finalEmits.push({
                        type: "task_update",
                        id: stepId,
                        title: section.title,
                        status: "complete",
                        details: (!existing?.sentDetails && section.body) ? section.body : undefined
                    });
                });

                await this.stream.append({ chunks: finalEmits });
                this.activeStepsMap.clear();
                this.thinkingBuffer = ''; // reset so re-entries are clean
                this.reasoningInitialized = false;
                this.lastNewlinePos = 0;
            }

            await this.stream.append({ markdown_text: part.message.content });
        }

        return modelResponse;
    }

    async stop() {
        return await this.stream.stop();
    }

    async append(data) {
        return await this.stream.append(data);
    }
}

module.exports = { Stream };