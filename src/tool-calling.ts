import type { ToolDefinition } from "./types";

class Tools {
    private map: Map<string, { config: ToolDefinition, callback: (args: { [key: string]: string }) => any | Promise<any> }> = new Map();

    constructor() {
        
    }

    // get the tool definition
    get(toolName: string) {
        return this.map.get(toolName);
    }

    /* 
    * add the tool definition
    */
    add(toolConfig: ToolDefinition, callback: (args: { [key: string]: string }) => any | Promise<any>) {
        this.map.set(toolConfig.function.name, { config: toolConfig, callback });
    }

    get rawJson() {
        return Array.from(this.map.values().map(m=>m.config));
    }
}

export { Tools };