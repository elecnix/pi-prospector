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
	/** Request a graceful shutdown of pi. No-op in print mode. */
	shutdown?: () => void | Promise<void>;
}

export interface ExtensionCommandContext extends ExtensionContext {
	ui: ExtensionUIContext;
}

export interface FlagOptions {
	description: string;
	type: "string" | "boolean";
	default?: string | boolean;
}

export interface SessionStartEvent {
	reason: "startup" | "reload" | "new" | "resume" | "fork";
	previousSessionFile?: string;
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
	/** Register a CLI flag (e.g. `--prospect <value>`). */
	registerFlag(name: string, options: FlagOptions): void;
	/** Read a previously-registered flag's value. */
	getFlag(name: string): string | boolean | undefined;
	/** Subscribe to a lifecycle event. Only the events this extension uses are typed. */
	on(
		event: "session_start",
		handler: (event: SessionStartEvent, ctx: ExtensionCommandContext) => void | Promise<void>,
	): void;
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

/** A tool offered to the model. `parameters` is a TypeBox schema (TSchema). */
export interface PiTool {
	name: string;
	description: string;
	parameters: unknown;
}

export interface PiContext {
	systemPrompt?: string;
	messages: PiUserMessage[];
	/** Tools the model may call; used to force structured output. */
	tools?: PiTool[];
}

export interface PiCompleteOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	temperature?: number;
	maxTokens?: number;
	/** Max client-side retries for transient failures (e.g. provider 429s). */
	maxRetries?: number;
	signal?: AbortSignal;
}

/** The subset of `@earendil-works/pi-ai` we call at runtime. */
export interface PiAiModule {
	complete: (model: PiModel, context: PiContext, options?: PiCompleteOptions) => Promise<PiAssistantMessage>;
}
