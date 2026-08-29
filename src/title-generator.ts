// TO BE USED

import globals from "./globals";

import remark from 'remark';
import remarkRemoveComments from 'remark-remove-comments';

const systemPrompt = remark.remark()
                        .use(remarkRemoveComments.default)
                        .processSync(globals.fs.readFileSync(globals.path.join(__dirname, '..', 'TITLE_PROMPT.md')))
                        .toString('utf-8')
                        .trim();

const defaultmodel = () => {
    return process.env.TITLE_GENERATION_MODEL == "__default" || !process.env.TITLE_GENERATION_MODEL ? 
        process.env.MODEL : process.env.TITLE_GENERATION_MODEL;
}

const newtitle = async (messages: Array<any> = []) => {
    function succ(m = "") {
        return [true, m];
    }

    function fail(m = "") {
        return [false, m];
    }

    // filter messages so no system prompt is included
    messages = messages.filter(m => m.role !== "system");

    if (messages.length <= 2) {
        // not enough context
        return fail();
    }

    messages.unshift({
        role: "system",
        content: systemPrompt
    });
    messages.push({
        role: "user",
        content: "Proceed to generate a title for this conversation."
    });

    const model = defaultmodel();

    if (!model) {
        console.warn("No title generation model set; this affects conversations as they'll have no meaningful title set.");
        return null;
    }

    if (!globals.ollama) {
        console.warn("CRTICIAL    Ollama is disabled!!");
        return null;
    }

    const req = await globals.ollama.chat({
        messages: messages,
        model
    });

    return req.message.content;
}

export { newtitle };

module.exports = {
    async newtitle(messages: Array<any> = []) {
        function succ(m = "") {
            return [true, m];
        }

        function fail(m = "") {
            return [false, m];
        }

        // filter messages so no system prompt is included
        messages = messages.filter(m => m.role !== "system");

        if (messages.length <= 2) {
            // not enough context
            return fail();
        }

        messages.unshift({
            role: "system",
            content: systemPrompt
        });
        messages.push({
            role: "user",
            content: "Proceed to generate a title for this conversation."
        });

        if (!this.defaultmodel) {
            console.warn("No title generation model set; this affects conversations as they'll have no meaningful title set.");
            return null;
        }

        if (!globals.ollama) {
            console.warn("CRTICIAL    Ollama is disabled!!");
            return null;
        }

        const req = await globals.ollama.chat({
            messages: messages,
            model: this.defaultmodel
        });

        return req.message.content;
    },

    get defaultmodel() {
        return process.env.TITLE_GENERATION_MODEL == "__default" || !process.env.TITLE_GENERATION_MODEL ? 
            process.env.MODEL : process.env.TITLE_GENERATION_MODEL;
    }
}