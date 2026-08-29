import type { ToolDefinition } from '../types';

const config: ToolDefinition = {
    type: 'function',
    function: {
        name: 'ping',
        description: 'This tool is a test. If it returns `pong`, that means it has ran successfully.',
        parameters: {
            type: 'object',
            properties: {}
        },
    },
};

async function callback(args: Record<string, any>): Promise<string> {
    return `pong`;
}

export default { config, callback };