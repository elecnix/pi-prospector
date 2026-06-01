/**
 * Local type stubs for @earendil-works/pi-coding-agent.
 *
 * The real package is a private peer dependency not available in CI.
 * These stubs let us compile without it. At runtime, Pi provides the real types.
 */

export interface ExtensionUIContext {
	notify: (message: string, level?: string) => void;
}

export interface ExtensionToolContext {
	notify: (message: string, level?: string) => void;
}

export interface ExtensionCommandContext {
	ui: ExtensionUIContext;
}

export interface ExtensionAPI {
	registerCommand(name: string, options: {
		description: string;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	}): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
	}): void;
}