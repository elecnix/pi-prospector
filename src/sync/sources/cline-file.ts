/**
 * ClineFileSource — discovers and parses Cline sessions.
 *
 * Cline 4.x runs every task through the Cline SDK, which keeps each session in
 * a directory of its own under its sessions root (`~/.cline/data/sessions/` by
 * default, moved by `CLINE_DIR`, `CLINE_DATA_DIR` or `CLINE_SESSION_DATA_DIR`):
 *
 *   <root>/<sessionId>/<sessionId>.json           the manifest: cwd, title, start
 *   <root>/<sessionId>/<sessionId>.messages.json  the conversation
 *   <root>/<sessionId>/<agentId>.messages.json    a child agent's conversation
 *
 * The messages file is one JSON document the SDK rewrites whole after every
 * agent iteration. Targets the format Cline v4.1.25 writes (cline/cline, tag
 * v4.1.25, commit 01b8a9724da905423e636396d7fb4acdf47796bb):
 * sdk/packages/core/src/services/session-artifacts.ts for the layout,
 * sdk/packages/core/src/services/session-data.ts for the file's envelope, and
 * sdk/packages/shared/src/llms/messages.ts for a message. The pre-SDK
 * `tasks/<id>/api_conversation_history.json` store, which 4.x only reads to
 * migrate, is not read.
 *
 * Discovery claims a `.messages.json` file only inside a session directory:
 * one named after the file, or one holding the root session's manifest for a
 * child agent. The compaction sidecar and the store's index files sit in the
 * same tree and are never read.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { SessionSourceAdapter, ParsedSession } from "../adapter.js";
import type { DiscoveredSession } from "../../types.js";
import type { SessionInsert, MessageInsert } from "../../db/queries.js";
import { classifyToolError } from "../tool-errors.js";
import { projectFromCwd } from "../project.js";

const MESSAGES_SUFFIX = ".messages.json";

const JsonObject = Type.Record(Type.String(), Type.Unknown());

const Manifest = Type.Object({
	session_id: Type.String(),
	started_at: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
	workspace_root: Type.Optional(Type.String()),
	metadata: Type.Optional(JsonObject),
});
type Manifest = Static<typeof Manifest>;

const ContentBlock = Type.Object({
	type: Type.String(),
	text: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	id: Type.Optional(Type.String()),
	name: Type.Optional(Type.String()),
	input: Type.Optional(Type.Unknown()),
	tool_use_id: Type.Optional(Type.String()),
	content: Type.Optional(Type.Unknown()),
	is_error: Type.Optional(Type.Boolean()),
});
type ContentBlock = Static<typeof ContentBlock>;

const Message = Type.Object({
	id: Type.Optional(Type.String()),
	role: Type.String(),
	content: Type.Union([Type.String(), Type.Array(Type.Unknown())]),
	ts: Type.Optional(Type.Number()),
	metadata: Type.Optional(JsonObject),
	modelInfo: Type.Optional(Type.Object({ id: Type.String(), provider: Type.Optional(Type.String()) })),
	metrics: Type.Optional(
		Type.Object({
			inputTokens: Type.Optional(Type.Number()),
			outputTokens: Type.Optional(Type.Number()),
			cacheReadTokens: Type.Optional(Type.Number()),
			cacheWriteTokens: Type.Optional(Type.Number()),
			cost: Type.Optional(Type.Number()),
		}),
	),
});
type Message = Static<typeof Message>;

const MessagesFile = Type.Object({
	version: Type.Literal(1),
	sessionId: Type.Optional(Type.String()),
	origin: Type.Optional(JsonObject),
	messages: Type.Array(Type.Unknown()),
});

/**
 * Cline's tool names, mapped onto the names the rest of the index uses, so the
 * analyzers that understand a shell command, a read or an edit understand
 * Cline's. A name this table does not know keeps its own.
 */
const CLINE_TOOL_NAMES: Record<string, string> = {
	run_commands: "bash",
	read_files: "read",
	search_codebase: "grep",
	editor: "edit",
	apply_patch: "edit",
	fetch_web_content: "webFetch",
};

/** The index-wide name for a Cline tool. */
export function clineToolName(name: string): string {
	return CLINE_TOOL_NAMES[name] ?? name;
}

/**
 * The arguments a Cline tool call is stored with.
 *
 * `run_commands` takes a list of commands; the analyzers that read a shell
 * call read one `command` string, so the list is joined into one beside the
 * host's own field. `read_files` names its files in a list; the first is copied
 * to `path`, where the analyzers that look for a path read it.
 */
export function clineToolArguments(name: string, input: unknown): Record<string, unknown> {
	const args: Record<string, unknown> = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : { input };
	if (name === "run_commands" && args["command"] === undefined) {
		const commands = Array.isArray(args["commands"]) ? args["commands"] : typeof args["commands"] === "string" ? [args["commands"]] : [];
		const text = commands.map(commandText).filter((c) => c.length > 0);
		if (text.length > 0) return { command: text.join("\n"), ...args };
	}
	if (name === "read_files" && args["path"] === undefined) {
		const first = Array.isArray(args["files"]) ? args["files"][0] : undefined;
		const p = typeof first === "string" ? first : first && typeof first === "object" ? (first as Record<string, unknown>)["path"] : undefined;
		if (typeof p === "string" && p) return { ...args, path: p };
	}
	return args;
}

/** One command of a `run_commands` call: a shell string, or `{ command, args }`. */
function commandText(entry: unknown): string {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object") {
		const e = entry as Record<string, unknown>;
		const argv = Array.isArray(e["args"]) ? e["args"].filter((a): a is string => typeof a === "string") : [];
		return typeof e["command"] === "string" ? [e["command"], ...argv].join(" ") : "";
	}
	return "";
}

/**
 * A user message's text without the wrapper Cline adds: the SDK sends a prompt
 * as `<user_input mode="act">…</user_input>` so the model knows the mode.
 */
export function clineUserText(text: string): string {
	const wrapped = /^\s*<user_input\b[^>]*>([\s\S]*)<\/user_input>\s*$/.exec(text);
	return (wrapped ? wrapped[1]! : text).trim();
}

function parseJson<S extends TSchema>(schema: S, raw: string): Static<S> | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	return Check(schema, value) ? (value as Static<S>) : null;
}

export class ClineFileSource implements SessionSourceAdapter {
	readonly source = "cline";

	/** @param sessionsDir Cline's sessions root, which holds one directory per session. */
	constructor(private sessionsDir: string) {}

	async discover(): Promise<DiscoveredSession[]> {
		let dirs: string[];
		try {
			dirs = await fs.readdir(this.sessionsDir);
		} catch {
			return [];
		}
		const results: DiscoveredSession[] = [];
		for (const dir of dirs.sort()) {
			const sessionDir = path.join(this.sessionsDir, dir);
			let entries: string[];
			try {
				entries = await fs.readdir(sessionDir);
			} catch {
				continue;
			}
			// A session directory is named after its session, and holds that
			// session's manifest or messages. Anything else is not Cline's.
			const isSession = entries.includes(`${dir}.json`) || entries.includes(`${dir}${MESSAGES_SUFFIX}`);
			if (!isSession) continue;
			for (const entry of entries.sort()) {
				if (!entry.endsWith(MESSAGES_SUFFIX)) continue;
				const filePath = path.join(sessionDir, entry);
				let stat: Awaited<ReturnType<typeof fs.stat>>;
				try {
					stat = await fs.stat(filePath);
				} catch {
					continue;
				}
				if (!stat.isFile()) continue;
				results.push({ filePath, project: "", mtime: stat.mtimeMs, size: stat.size, source: this.source });
			}
		}
		return results;
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		const file = parseJson(MessagesFile, await fs.readFile(disc.filePath, "utf-8"));
		if (!file) throw new Error(`not a Cline messages file: ${disc.filePath}`);
		const sessionDir = path.dirname(disc.filePath);
		const rootSessionId = path.basename(sessionDir);
		const stem = path.basename(disc.filePath, MESSAGES_SUFFIX);
		const isRoot = stem === rootSessionId;
		// A child agent's file is named after the agent; its session id is the
		// root's joined to it, as the SDK names sub-sessions.
		const sessionId = file.sessionId ?? (isRoot ? rootSessionId : `${rootSessionId}__${stem}`);
		const manifest = await readManifest(path.join(sessionDir, `${rootSessionId}.json`));
		const cwd = manifest?.cwd ?? manifest?.workspace_root ?? "";
		const title = isRoot ? manifest?.metadata?.["title"] : undefined;

		const messages = file.messages.filter((m): m is Message => Check(Message, m));
		// The cursor is the number of messages already read. The SDK rewrites the
		// file whole and only appends between rewrites, except when compaction
		// replaces history with a summary: then the file holds fewer messages
		// than the cursor, and the whole file is read again. Row ids are the
		// host's message ids, scoped by session, so a row already indexed is
		// ignored by the store.
		const from = resumeLine <= messages.length ? resumeLine : 0;
		const rows = this.rowsFor(messages, sessionId)
			.filter((r) => r.index >= from)
			.map((r) => r.row);

		const session: SessionInsert = {
			id: sessionId,
			file_path: disc.filePath,
			project: cwd ? projectFromCwd(cwd) : "workspace",
			source: this.source,
			cwd,
			parent_session: isRoot ? null : rootSessionId,
			started_at: (isRoot ? manifest?.started_at : undefined) ?? firstTimestamp(messages) ?? "",
			last_line: resumeLine,
			last_modified: disc.mtime,
			analyzed_at: null,
			message_count: 0,
			branch_count: 0,
			name: typeof title === "string" && title.trim() ? title.trim() : null,
			// The session files record no tool manifest, so the inventory is UNKNOWN.
			tool_inventory: null,
		};

		return {
			session,
			messages: rows,
			processedCount: messages.length,
			processedTimestamp: disc.mtime,
			forksResolved: 0,
		};
	}

	/**
	 * The index rows of a whole conversation, each with the position of the
	 * message it came from. The whole file is read even on a resume, because a
	 * result names its tool only through the call that precedes it.
	 */
	private rowsFor(messages: Message[], sessionId: string): Array<{ index: number; row: MessageInsert }> {
		const out: Array<{ index: number; row: MessageInsert }> = [];
		const toolNames = new Map<string, string>();
		let lastUserId: string | null = null;
		messages.forEach((m, index) => {
			const rows = { push: (row: MessageInsert) => out.push({ index, row }) };
			const id = `${sessionId}:${m.id ?? `msg-${index}`}`;
			const blocks = blocksOf(m.content);
			const base = {
				id,
				session_id: sessionId,
				source: this.source,
				parent_id: null as string | null,
				timestamp: typeof m.ts === "number" ? new Date(m.ts).toISOString() : null,
				content_text: null as string | null,
				content_thinking: null as string | null,
				tool_calls: null as string | null,
				tool_results: null as string | null,
				usage: null as string | null,
				model: null as string | null,
				cost_usd: null as number | null,
				provider_message_id: null as string | null,
				stop_reason: null as string | null,
				error_message: null as string | null,
			};
			const meta = m.metadata ?? {};
			const text = joined(blocks.filter((b) => b.type === "text").map((b) => b.text ?? ""));

			if (m.role === "assistant") {
				// The runtime's own notice of a failed run: shown to the user,
				// never sent to the model. It is the turn failure it records.
				if (meta["displayOnly"] === true) {
					if (meta["displayRole"] === "error") {
						rows.push({ ...base, role: "assistant", parent_id: lastUserId, stop_reason: "error", error_message: text ?? "" });
					}
					return;
				}
				const calls = blocks
					.filter((b) => b.type === "tool_use" && b.id && b.name)
					.map((b) => {
						toolNames.set(b.id!, b.name!);
						return { id: b.id!, name: clineToolName(b.name!), arguments: clineToolArguments(b.name!, b.input) };
					});
				const thinking = joined(blocks.filter((b) => b.type === "thinking").map((b) => b.thinking ?? ""));
				rows.push({
					...base,
					role: "assistant",
					parent_id: lastUserId,
					content_text: text,
					content_thinking: thinking,
					tool_calls: calls.length > 0 ? JSON.stringify(calls) : null,
					usage: usageOf(m),
					model: m.modelInfo ? (m.modelInfo.provider ? `${m.modelInfo.provider}/${m.modelInfo.id}` : m.modelInfo.id) : null,
					cost_usd: typeof m.metrics?.cost === "number" && m.metrics.cost > 0 ? m.metrics.cost : null,
					provider_message_id: m.id ?? null,
				});
				return;
			}
			if (m.role !== "user") return;

			const results = blocks.filter((b) => b.type === "tool_result" && b.tool_use_id);
			if (results.length > 0) {
				rows.push({
					...base,
					role: "toolResult",
					tool_results: JSON.stringify(
						results.map((b) => {
							const hostName = b.name ?? toolNames.get(b.tool_use_id!) ?? "";
							const resultText = resultTextOf(b.content);
							const isError = b.is_error === true;
							const errorClass = classifyToolError(isError, resultText || null);
							const entry = { toolCallId: b.tool_use_id!, toolName: clineToolName(hostName), isError, textLength: resultText.length };
							return errorClass ? { ...entry, errorClass } : entry;
						}),
					),
				});
				return;
			}
			// A compaction summary replaces the history it summarises; it is
			// context management, never a turn boundary.
			if (meta["kind"] === "compaction_summary") {
				rows.push({ ...base, role: "compactionSummary", content_text: text });
				return;
			}
			// Text the runtime injects for the model (hook output, a resume
			// reminder) is filed as a user message the user never wrote.
			if (meta["displayRole"] === "system") {
				rows.push({ ...base, role: "custom/system", content_text: text });
				return;
			}
			const userText = text === null ? null : clineUserText(text);
			if (!userText) return;
			rows.push({ ...base, role: "user", content_text: userText });
			lastUserId = id;
		});
		return out;
	}
}

async function readManifest(file: string): Promise<Manifest | null> {
	try {
		return parseJson(Manifest, await fs.readFile(file, "utf-8"));
	} catch {
		return null;
	}
}

function blocksOf(content: Message["content"]): ContentBlock[] {
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	return content.filter((b): b is ContentBlock => Check(ContentBlock, b));
}

function joined(parts: string[]): string | null {
	const kept = parts.filter((p) => p.length > 0);
	return kept.length > 0 ? kept.join("\n") : null;
}

function resultTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && typeof c === "object" && (c as Record<string, unknown>)["type"] === "text" ? String((c as Record<string, unknown>)["text"] ?? "") : ""))
		.filter((t) => t.length > 0)
		.join("\n");
}

function firstTimestamp(messages: Message[]): string | null {
	const ts = messages.find((m) => typeof m.ts === "number")?.ts;
	return ts === undefined ? null : new Date(ts).toISOString();
}

/**
 * The generation's token buckets, in the index's shape. Cline reports input
 * without the cached tokens. Cost is recorded per message, not per bucket, so
 * the bucket breakdown stays null.
 */
function usageOf(m: Message): string | null {
	const t = m.metrics;
	if (!t) return null;
	const input = t.inputTokens ?? 0;
	const output = t.outputTokens ?? 0;
	const cacheRead = t.cacheReadTokens ?? 0;
	const cacheWrite = t.cacheWriteTokens ?? 0;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null;
	return JSON.stringify({ input, output, cacheRead, cacheWrite, totalTokens: input + output, cost: null });
}
