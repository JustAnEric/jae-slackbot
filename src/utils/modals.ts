export class ModalBuilder {
    private view: any = {
        type: 'modal',
        callback_id: '',
        title: { type: 'plain_text', text: '' },
        submit: { type: 'plain_text', text: 'submit' },
        blocks: []
    };

    constructor(callbackId: string) {
        this.view.callback_id = callbackId;
    }

    title(text: string) {
        this.view.title.text = text;
        return this;
    }

    input(id: string, label: string, placeholder = '') {
        this.view.blocks.push({
            type: 'input',
            block_id: `${id}_block`,
            label: { type: 'plain_text', text: label },
            element: {
                type: 'plain_text_input',
                action_id: `${id}_input`,
                placeholder: { type: 'plain_text', text: placeholder }
            }
        });
        return this;
    }

    build() {
        return this.view;
    }
}