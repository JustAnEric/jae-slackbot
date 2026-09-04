import type { ToolDefinition } from '../types';
import axios from 'axios';

const config: ToolDefinition = {
    type: 'function',
    function: {
        name: 'stardance',
        description: 'This tool makes an action on Stardance, and returns relevant data back. Use this if someone sends a Stardance URL like (INCLUDE ALL THE PATH FROM THEIR REQUEST, REPLACING THE * WILDCARD): https://stardance.hackclub.com/*',
        parameters: {
            type: 'object',
            properties: {
                'url': { 'description': 'The Stardance URL to translate', 'type': 'string' },
                'limit': { 'description': 'The amount of results to be returned (max 20)', 'type': 'number' },
                'offset': { 'description': 'The offset to the limit (used for pagination)', 'type': 'number' }
            },
            required: ['url']
        },
    },
};

async function callback(args: Record<string, any>): Promise<string> {
    if (!args.url) {
        return `Error: No query argument supplied!`;
    }

    // parse url
    const url = new URL(args.url);
    const pparts = url.pathname.split('/').filter(Boolean);

    const qS = new URLSearchParams();

    if (args.limit) {
        qS.set("limit", args.limit);
    }
    if (args.offset) {
        qS.set("offset", args.offset);
    }

    if (pparts[0]?.startsWith("@") && pparts.length === 1) {
        // grab a user
        let sd = await axios.get(`https://api.stardancestats.xyz/v1/users/${pparts[0]}?${qS}`, { responseType: 'json' });
        let sd2 = await axios.get(`https://api.stardancestats.xyz/v1/users/${pparts[0]}/devlogs?${qS}`, { responseType: 'json' });
        let out = { user: sd.data, devlogs: sd2.data };
        return JSON.stringify(out);
    }

    if (pparts[0]?.startsWith("@") && pparts[1]?.toLowerCase() === "projects") {
        // grab a user's projects
        let sd = await axios.get(`https://api.stardancestats.xyz/v1/users/${pparts[0]}/projects?${qS}`, { responseType: 'json' });
        let out = sd.data;
        return JSON.stringify(out);
    }

    if (pparts[0]?.toLowerCase() === "shop" && pparts.length === 1) {
        // grab the stardance shop
        let sd = await axios.get(`https://api.stardancestats.xyz/v1/shop?${qS}`, { responseType: 'json' });
        let out = sd.data;
        return JSON.stringify(out);
    } else if (pparts[0]?.toLowerCase() === "shop" && pparts[1]?.toLowerCase() === "category" && pparts.length === 3) {
        const category = pparts[2]?.toLowerCase();
        const validCategories = ["all", "experiences", "hardware", "software", "swag", "grants"];
        if (!category) {
            return JSON.stringify({ 'error': 'incorrect URL' });
        }
        if (!validCategories.includes(category)) {
            return JSON.stringify({ 'error': `invalid shop category inside URL: /shop/category/${validCategories.join('|')}` })
        }
        // grab the stardance shop
        qS.set("category", category);
        let sd = await axios.get(`https://api.stardancestats.xyz/v1/shop?${qS}`, { responseType: 'json' });
        let out = sd.data;
        return JSON.stringify(out);
    } else if (pparts[0]?.toLowerCase() === "shop" && pparts[1]?.toLowerCase() === "items" && pparts.length === 3) {
        // grab the stardance shop
        let sd = await axios.get(`https://api.stardancestats.xyz/v1/shop/${pparts[2]}?${qS}`, { responseType: 'json' });
        let out = sd.data;
        return JSON.stringify(out);
    }

    return `Error: That URL is unknown`;
}

export default { config, callback };