import type { ToolDefinition } from '../types';
import axios from 'axios';

const config: ToolDefinition = {
    type: 'function',
    function: {
        name: 'stardance_search',
        description: 'This tool searches Stardance for projects or users.',
        parameters: {
            type: 'object',
            properties: {
                'scope': { 'description': 'Either can be "projects" or "users".', 'type': 'string' },
                'query': { 'description': 'The search query', 'type': 'string' },
                'limit': { 'description': 'The amount of results to be returned (max 20)', 'type': 'number' },
                'offset': { 'description': 'The offset to the limit (used for pagination)', 'type': 'number' }
            },
            required: ['scope', 'query']
        },
    },
};

async function callback(args: Record<string, any>): Promise<string> {
    if (!args.scope || !args.query) {
        return `Error: One or more of required arguments are not supplied!`;
    }

    const qS = new URLSearchParams();

    if (args.limit) {
        qS.set("limit", args.limit);
    }
    if (args.offset) {
        qS.set("offset", args.offset);
    }

    if (args.scope == "projects") {
        // grab the stardance projects about query
        qS.set("q", args.query);
        let sd = await axios.get(`https://api.stardancestats.xyz/v1/projects/search?${qS}`, { responseType: 'json' });
        let out = sd.data;
        out.items.forEach((i: any) => {
            i.project_url = `https://stardance.hackclub.com/projects/${i.project_id}`;
        });
        return JSON.stringify(out);
    } else if (args.scope == "users") {
        // grab the stardance users about query
        qS.set("q", args.query);
        let sd = await axios.get(`https://api.stardancestats.xyz/v1/users/search?${qS}`, { responseType: 'json' });
        let out = sd.data;
        out.items.forEach((i: any) => {
            i.user_profile_url = `https://stardance.hackclub.com/@${i.username}`;
        });
        return JSON.stringify(out);
    } else {
        return `Error: Invalid scope, must be one of type: "projects" | "users"`;
    }
}

export default { config, callback };