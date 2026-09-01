import type { ToolDefinition } from '../types';
import { API as execServerAPI } from "../utils/tools/execution_server/api";
import { split as shlex_split } from "shlex";

const config: ToolDefinition = {
    type: 'function',
    function: {
        name: 'run_command',
        description: 'This tool runs a command inside a container.',
        parameters: {
            type: 'object',
            properties: {
                'command': { 'description': 'The command to run (runs in Alpine Linux)', 'type': 'string' }
            },
            required: ['command']
        },
    },
};

async function callback(args: Record<string, any>): Promise<string> {
    if (!args.command) {
        return `Error: No command argument supplied!`;
    }

    const api = new execServerAPI();
    await api.init();

    let container = await api.spawn(shlex_split(args.command));
    let out = await api.container_output_done();
    if (container) await api.kill(container);

    return JSON.stringify(out);
}

export default { config, callback };