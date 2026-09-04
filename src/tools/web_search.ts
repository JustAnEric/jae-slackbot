import type { ToolDefinition } from '../types';
import axios from 'axios';

interface SearXNGResult {
    template: string;
    url: string;
    title: string;
    content: string;
    publishedDate: null | string;
    thumbnail: string;
    engine: string;
    parsed_url: Array<string>;
    img_src: string;
    priority: string;
    engines: Array<string>;
    positions: Array<number>;
    score: number;
    category: string;
}

interface BotSearchResult {
    url: string;
    title: string;
    content: string;
    publishedDate: null | string;
    score: number;
}

const config: ToolDefinition = {
    type: 'function',
    function: {
        name: 'web_search',
        description: 'This tool searches the web.',
        parameters: {
            type: 'object',
            properties: {
                'query': { 'description': 'The search query', 'type': 'string' },
                'max_results': { 'description': 'The amount of results to be returned (max 20)', 'type': 'number' }
            },
            required: ['query']
        },
    },
};

async function callback(args: Record<string, any>): Promise<string> {
    if (!args.query) {
        return `Error: No query argument supplied!`;
    }

    args.max_results = args.max_results || 10;

    let out = await axios.get(`http://${process.env.SEARXNG_SERVER || '127.0.0.1:6201'}/search?q=${args.query}&format=json`, {
        responseType: 'json'
    });

    let results: Array<SearXNGResult> = out.data.results;
    let refResults = results.map(e => {
        let result: BotSearchResult = {
            url: e.url, title: e.title, content: e.content,
            publishedDate: e.publishedDate, score: e.score
        };
        return result;
    });

    return JSON.stringify(refResults);
}

export default { config, callback };