/**
 * Local type stubs for the Pi host packages.
 *
 * The real `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`
 * packages are optional peer dependencies that are not installed in CI. These
 * stubs describe just enough of their surface for this extension to compile and
 * type-check. At runtime inside Pi, the real implementations are used.
 */

// ───────────────────────── pi-coding-agent ─────────────────────────

export interface PiModel {
	id: string;
	provider: string;
	name?: string;
}

export type ResolvedRequestAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

export interface ModelRegistry {
	find(provider: string, modelId: string): PiModel | undefined;
	getAll(): PiModel[];
	getAvailable(): PiModel[];
	getApiKeyAndHeaders(model: PiModel): Promise<ResolvedRequestAuth>;
}

export interface ExtensionUIContext {
	notify: (message: string, level?: string) => void;
	select?: (options: unknown) => Promise<unknown>;
	confirm?: (options: unknown) => Promise<boolean>;
	input?: (options: unknown) => Promise<string | undefined>;
	setStatus?: (text: string) => void;
}

export interface ExtensionContext {
	modelRegistry: ModelRegistry;
	model?: PiModel;
	signal?: AbortSignal;
	cwd?: string;
	hasUI?: boolean;
}

export interface ExtensionCommandContext extends ExtensionContext {
	ui: ExtensionUIContext;
}

export interface ToolResultContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolResultContent[];
	details?: unknown;
}

export interface ExtensionAPI {
	registerCommand(
		name: string,
		options: {
			description: string;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
		},
	): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			onUpdate: unknown,
			ctx: ExtensionCommandContext,
		) => Promise<ToolResult> | ToolResult;
	}): void;
}

// ───────────────────────── pi-ai (minimal) ─────────────────────────

export interface PiTextContent {
	type: "text";
	text: string;
}
export interface PiThinkingContent {
	type: "thinking";
	thinking: string;
}
export interface PiToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCallContent;

export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PiAssistantMessage {
	role: "assistant";
	content: PiAssistantContent[];
	model: string;
	usage: PiUsage;
	stopReason: string;
	errorMessage?: string;
	timestamp: number;
}

export interface PiUserMessage {
	role: "user";
	content: string;
	timestamp: number;
}

export interface PiContext {
	systemPrompt?: string;
	messages: PiUserMessage[];
}

export interface PiCompleteOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	temperature?: number;
	maxTokens?: number;
	signal?: AbortSignal;
}

/** The subset of `@earendil-works/pi-ai` we call at runtime. */
export interface PiAiModule {
	complete: (model: PiModel, context: PiContext, options?: PiCompleteOptions) => Promise<PiAssistantMessage>;
}
