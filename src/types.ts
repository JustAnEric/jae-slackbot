export interface ToolFunctionDefinition {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, {
            type: string;
            description: string;
            enum?: string[];
        }>;
        required?: string[];
    };
}

export interface ToolDefinition {
    type: 'function';
    function: ToolFunctionDefinition;
}