/**
 * Type definitions for pi-prospector.
 * All data shapes are plain TypeScript interfaces — no TypeBox schemas needed
 * for internal types. TypeBox schemas are used only for the Pi tool registration
 * where Pi's API expects them.
 */

// ─── Config ───

export interface ProspectorConfig {
	model?: string; // provider/model format, e.g. "openrouter/deepseek-v4-flash"
	dbPath?: string; // defaults to ~/.pi/agent/prospector.db
}

// ─── Session ───

export interface SessionHeader {
	id: string;
	version: number;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
}

// ─── Messages ───

export type MessageRole =
	| "user"
	| "assistant"
	| "toolResult"
	| "bashExecution"
	| "custom"
	| "branchSummary"
	| "compactionSummary";

export interface ToolCallInfo {
	name: string;
	arguments: Record<string, unknown>;
}

export interface ToolResultInfo {
	toolCallId: string;
	toolName: string;
	isError: boolean;
	textLength: number;
}

export interface MessageEntry {
	id: string;
	parentId: string | null;
	timestamp: string | null;
	role: MessageRole;
	contentText: string | null;
	contentThinking: string | null;
	toolCalls: ToolCallInfo[] | null;
	toolResults: ToolResultInfo[] | null;
}

export interface ParsedLine {
	type: "session" | "message";
	data: SessionHeader | MessageEntry;
}

// ─── Sync ───

export interface DiscoveredSession {
	filePath: string;
	project: string;
	mtime: number; // milliseconds
}

export interface SyncCursor {
	session_id: string;
	last_line: number;
	last_modified: number;
}

export interface ForkInfo {
	parentSessionId: string;
	parentFilePath: string;
	branchLine: number; // line number where the fork diverges
}

export interface SyncResult {
	sessionsProcessed: number;
	sessionsSkipped: number;
	messagesInserted: number;
	forksResolved: number;
	errors: string[];
}

// ─── Proposals ───

export type ProposalSeverity = "friction" | "correction" | "waste" | "suggestion";
export type ProposalStatus = "new" | "accepted" | "rejected";

export interface NewProposal {
	sessionId: string;
	target: string;
	severity: ProposalSeverity;
	summary: string;
	detail: string;
	evidence: string;
	dedupHash: string;
}

export interface Proposal {
	id: string;
	created_at: string;
	session_id: string;
	target: string;
	severity: ProposalSeverity;
	summary: string;
	detail: string;
	evidence: string;
	status: ProposalStatus;
	dedup_hash: string;
}

// ─── Stats ───

export interface Stats {
	totalSessions: number;
	totalMessages: number;
	totalToolResults: number;
	messagesProcessed: number;
	proposalsByStatus: Record<ProposalStatus, number>;
}

// ─── Analyze ───

export interface AnalyzeResult {
	sessionsAnalyzed: number;
	proposalsGenerated: number;
	errors: string[];
}