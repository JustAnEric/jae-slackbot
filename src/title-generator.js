// TO BE USED

const fs = require('fs');
const path = require('path');
const remark = require('remark');
const remarkRemoveComments = require('remark-remove-comments');

const globals = require("./globals");

const systemPrompt = remark.remark()
                        .use(remarkRemoveComments.default)
                        .processSync(fs.readFileSync(path.join(__dirname, '..', 'TITLE_PROMPT.md')))
                        .toString('utf-8')
                        .trim();

module.exports = {
    async newtitle(messages = []) {
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