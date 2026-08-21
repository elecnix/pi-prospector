/**
 * File-touch detection: which tabular files a session's tool calls read or
 * wrote, and what content the transcript captured for each.
 *
 * This is DataProfiler's input seam (issue #175): profile *files*, not inline
 * fragments. A touch pairs
 *
 * - the **path**, read from normalized tool-call arguments — structured tools'
 *   `file_path`/`path` fields, or path-shaped tokens in a `bash` command —
 *   filtered to textual tabular extensions (`.csv`, `.tsv`/`.tab`,
 *   `.json`/`.jsonl`) under the config's format toggles. Binary tabular
 *   formats (`.parquet`, `.xlsx`, …) are counted as skipped, never extracted:
 *   their bytes do not survive into a text transcript intact enough to
 *   profile.
 * - the **content**, captured from the paired tool result — resolved through
 *   the shared action stream (`buildToolStream`), i.e. by the provider's
 *   tool-call id, exactly like every analyzer that reads what the agent did.
 *   A result row carrying several results joins its texts ambiguously, so no
 *   content is claimed there — the same honesty rule the failure analyzer
 *   applies to error text. A `write` tool call carries the written content in
 *   its arguments (`content`), which is the transcript's record of what landed
 *   in the file; that is used when the paired result merely acknowledges.
 *
 * Everything here is pure and deterministic: fixed tokenisation, fixed
 * extension sets, stream order preserved.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream, type ToolInvocation } from "../../tool-stream.js";
import type { DataprofilerConfig } from "./config.js";

/** The direction a tool call touched a file with. */
export type TouchDirection = "read" | "write";

/** The textual tabular formats a finding can name. */
export const FILE_FORMATS = ["csv", "tsv", "json"] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

/** Binary tabular formats: recognised so they can be *counted as skipped*, never extracted. */
const BINARY_TABULAR_EXTENSIONS = [
	".parquet",
	".xlsx",
	".xls",
	".avro",
	".feather",
	".pkl",
	".h5",
	".db",
	".sqlite",
	".sqlite3",
] as const;

/** One tabular-file touch: a path, how it was touched, and any captured content. */
export interface FileTouch {
	/** The file path, verbatim from the tool-call arguments. */
	path: string;
	/** Read or write. */
	direction: TouchDirection;
	/** The format implied by the extension (already filtered by config toggles). */
	format: FileFormat;
	/** Tool name that performed the touch. */
	tool: string;
	/** The provider's tool-call id, or "" when the transcript recorded none. */
	callId: string;
	/** The assistant message that issued the call — the finding's anchor. */
	callMessageId: string;
	/** The message that carried the paired result, or null when none arrived. */
	resultMessageId: string | null;
	/**
	 * The file content the transcript captured, or null when none could be
	 * attributed unambiguously (no paired result, an errored result, an
	 * ambiguous multi-result row, or a write whose arguments carried no body).
	 */
	content: string | null;
}

export interface FileTouchScan {
	/** Extracted touches, in tool-stream order. */
	touches: FileTouch[];
	/** Tabular-binary paths seen and deliberately not extracted. */
	skippedBinary: number;
	/** Path-shaped tokens whose extension matched no enabled format. */
	skippedOtherExtension: number;
}

/** Structured tools whose job is reading files (result carries the content). */
const READ_TOOLS = new Set(["read", "view", "cat"]);
/** Structured tools whose job is writing files (arguments carry the content). */
const WRITE_TOOLS = new Set(["write", "create"]);
/** Structured tools that patch part of a file: a touch, but never whole-content. */
const EDIT_TOOLS = new Set(["edit", "patch"]);

/** Bash output flags whose following token is a write target. */
const OUTPUT_FLAGS = new Set(["-o", "--output", "--out"]);

interface Token {
	text: string;
	/** True when produced by quote stripping (still a single token either way). */
	quoted: boolean;
}

/** Quote-aware whitespace tokenizer for bash command strings. */
function tokenize(command: string): Token[] {
	const tokens: Token[] = [];
	let cur = "";
	let quoted = false;
	let hasContent = false;
	let inSingle = false;
	let inDouble = false;
	for (const ch of command) {
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			hasContent = true;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			hasContent = true;
			continue;
		}
		if (ch === " " && !inSingle && !inDouble) {
			if (hasContent || cur.length > 0) tokens.push({ text: cur, quoted: hasContent });
			cur = "";
			hasContent = false;
			continue;
		}
		cur += ch;
	}
	if (hasContent || cur.length > 0) tokens.push({ text: cur, quoted: hasContent });
	return tokens;
}

function extensionOf(path: string): string {
	const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const base = slash === -1 ? path : path.slice(slash + 1);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** Which enabled format does this path carry, if any? */
function formatOf(path: string, config: DataprofilerConfig): FileFormat | null {
	const ext = extensionOf(path);
	if (config.formats.json && (ext === ".json" || ext === ".jsonl")) return "json";
	if (config.formats.tsv && (ext === ".tsv" || ext === ".tab")) return "tsv";
	if (config.formats.csv && ext === ".csv") return "csv";
	return null;
}

function isTabularBinary(path: string): boolean {
	return (BINARY_TABULAR_EXTENSIONS as readonly string[]).includes(extensionOf(path));
}

/** Structured-tool argument keys that may hold a file path, in priority order. */
const PATH_KEYS = ["file_path", "path", "filename", "file"] as const;

function pathFromArgs(args: Record<string, unknown>): string | null {
	for (const key of PATH_KEYS) {
		const v = args[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return null;
}

/** Content a `write`-style call carried in its arguments, if any. */
function contentFromArgs(args: Record<string, unknown>): string | null {
	const v = args["content"];
	if (typeof v === "string" && v.length > 0) return v;
	return null;
}

interface RawResultEntry {
	toolCallId: string;
	isError: boolean;
}

/** Parse a stored `tool_results` JSON envelope, tolerating malformed rows. */
function parseResultEntries(json: string): RawResultEntry[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: RawResultEntry[] = [];
	for (const raw of parsed) {
		if (!raw || typeof raw !== "object") continue;
		const tr = raw as Record<string, unknown>;
		out.push({
			toolCallId: typeof tr["toolCallId"] === "string" ? tr["toolCallId"] : "",
			isError: Boolean(tr["isError"]),
		});
	}
	return out;
}

/**
 * Resolve the content captured for one invocation, or null.
 *
 * Priority: a `write` call's own `content` argument (the transcript's record
 * of what was written), then the paired tool result's text — only when the
 * result row holds exactly one non-errored result, so attribution is honest.
 */
function capturedContent(
	inv: ToolInvocation,
	messagesById: Map<string, MessageRow>,
): string | null {
	if (WRITE_TOOLS.has(inv.name)) {
		const fromArgs = contentFromArgs(inv.args);
		if (fromArgs !== null) return fromArgs;
	}
	const outcome = inv.outcome;
	if (!outcome || outcome.isError) return null;
	const row = messagesById.get(outcome.messageId);
	if (!row || typeof row.tool_results !== "string") return null;
	const entries = parseResultEntries(row.tool_results);
	if (entries.length !== 1) return null; // ambiguous join: claim nothing
	return typeof row.content_text === "string" && row.content_text.length > 0
		? row.content_text
		: null;
}

/** Extract candidate path tokens from a bash command, classified by direction. */
function bashPathTargets(command: string): Array<{ path: string; direction: TouchDirection }> {
	const targets: Array<{ path: string; direction: TouchDirection }> = [];
	const tokens = tokenize(command);
	const base = tokens[0]?.text ?? "";
	const teeMode = base === "tee";

	let afterRedirect = false;
	let afterOutputFlag = false;
	for (let i = 1; i < tokens.length; i++) {
		const tok = tokens[i]!;
		const t = tok.text;
		if (!tok.quoted && (t === ">" || t === ">>" || t === "&>" || t === ">|" )) {
			afterRedirect = true;
			continue;
		}
		if (!tok.quoted && OUTPUT_FLAGS.has(t)) {
			afterOutputFlag = true;
			continue;
		}
		if (t.includes(" ") || t.includes("\n")) continue; // heredoc bodies etc.
		const isWriteTarget = afterRedirect || afterOutputFlag || teeMode;
		afterRedirect = false;
		afterOutputFlag = false;
		targets.push({ path: t, direction: isWriteTarget ? "write" : "read" });
	}
	return targets;
}

/**
 * Detect every tabular-file touch in a session's messages. Pure and
 * deterministic; touches come back in tool-stream order.
 *
 * @param messages the session's message rows, in order
 * @param config the resolved analyzer config (format toggles honoured)
 */
export function detectFileTouches(
	messages: readonly MessageRow[],
	config: DataprofilerConfig,
): FileTouchScan {
	const stream = buildToolStream([...messages]);
	const messagesById = new Map(messages.map((m) => [m.id, m]));
	const touches: FileTouch[] = [];
	let skippedBinary = 0;
	let skippedOtherExtension = 0;

	function consider(rawPath: string, direction: TouchDirection, inv: ToolInvocation): void {
		const path = rawPath.trim();
		if (path.length === 0) return;
		if (isTabularBinary(path)) {
			skippedBinary++;
			return;
		}
		const format = formatOf(path, config);
		if (format === null) {
			skippedOtherExtension++;
			return;
		}
		touches.push({
			path,
			direction,
			format,
			tool: inv.name,
			callId: inv.callId,
			callMessageId: inv.messageId,
			resultMessageId: inv.outcome?.messageId ?? null,
			content: capturedContent(inv, messagesById),
		});
	}

	for (const inv of stream.invocations) {
		if (inv.name === "bash") {
			const command = typeof inv.args["command"] === "string" ? inv.args["command"] : "";
			if (command.length === 0) continue;
			for (const target of bashPathTargets(command)) {
				consider(target.path, target.direction, inv);
			}
			continue;
		}
		const path = pathFromArgs(inv.args);
		if (path === null) continue;
		const direction: TouchDirection = WRITE_TOOLS.has(inv.name)
			? "write"
			: EDIT_TOOLS.has(inv.name)
				? "write"
				: READ_TOOLS.has(inv.name)
					? "read"
					: // Unknown structured tool with a path argument: judge by nothing,
						// treat as a read (the conservative direction for evidence).
						"read";
		consider(path, direction, inv);
	}

	return { touches, skippedBinary, skippedOtherExtension };
}
