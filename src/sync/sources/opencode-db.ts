/**
 * OpenCodeDbSource — discovers and parses OpenCode sessions.
 *
 * OpenCode 1.x keeps every session in one SQLite database, `opencode.db`, in
 * its data directory (`$XDG_DATA_HOME/opencode/`, `~/.local/share/opencode/` by
 * default). A session is a row of `session`; its messages are rows of
 * `message`, and each piece of a message — a text, a reasoning block, one tool
 * call with its result — is a row of `part`. Both keep their payload as JSON in
 * a `data` column.
 *
 * Targets the schema OpenCode v1.19.3 writes (sst/opencode, tag v1.19.3, commit
 * e3c4eb242585dcd77be1a867391b7c25fd47ce52): packages/core/src/session/sql.ts
 * for the tables, packages/schema/src/v1/session.ts for the message and part
 * payloads, and packages/core/src/session/projector.ts for how they are written.
 * The `session_v2` / `session_message` tables on OpenCode's main branch are not
 * released and are not read.
 *
 * A database holds many sessions, so one discovered unit is one session, and
 * its `filePath` is `<db path>#<session id>`: the cursor is keyed by it. The
 * unit's mtime is the latest `time_updated` of the session, its messages and
 * their parts. The session row alone is not enough: OpenCode moves it when a
 * prompt arrives, and writes it back unchanged when a reply's usage is added
 * (projector.ts, `applyUsage`), so a reply never moves it.
 *
 * The database is opened read-only and never written: it belongs to OpenCode.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import type { SessionSourceAdapter, ParsedSession } from "../adapter.js";
import type { DiscoveredSession } from "../../types.js";
import type { SessionInsert, MessageInsert } from "../../db/queries.js";
import { classifyToolError } from "../tool-errors.js";
import { projectFromCwd } from "../project.js";

/** The file OpenCode's stable channel writes. Other channels name theirs `opencode-<channel>.db`. */
const OPENCODE_DB_FILE_RE = /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/;

/** Separates the database path from the session id in a discovered unit's `filePath`. */
const UNIT_SEPARATOR = "#";

const JsonObject = Type.Record(Type.String(), Type.Unknown());

const SessionRow = Type.Object({
	id: Type.String(),
	parent_id: Type.Union([Type.String(), Type.Null()]),
	directory: Type.String(),
	title: Type.String(),
	time_created: Type.Number(),
	time_updated: Type.Number(),
});

/** A session row with the latest change to anything it holds. */
const SessionChangeRow = Type.Object({
	id: Type.String(),
	directory: Type.String(),
	changed: Type.Number(),
});
type SessionChangeRow = Static<typeof SessionChangeRow>;

/**
 * The latest `time_updated` across a session, its messages and their parts.
 * Message and part rows carry their own, which OpenCode sets on every write.
 */
const SESSION_CHANGES_SQL =
	"SELECT s.id AS id, s.directory AS directory, max(s.time_updated, " +
	"coalesce((SELECT max(m.time_updated) FROM message m WHERE m.session_id = s.id), 0), " +
	"coalesce((SELECT max(p.time_updated) FROM part p WHERE p.session_id = s.id), 0)) AS changed " +
	"FROM session s ORDER BY s.time_created, s.id";
type SessionRow = Static<typeof SessionRow>;

const MessageRow = Type.Object({
	id: Type.String(),
	time_created: Type.Number(),
	data: Type.String(),
});
type MessageRow = Static<typeof MessageRow>;

const PartRow = Type.Object({
	message_id: Type.String(),
	data: Type.String(),
});
type PartRow = Static<typeof PartRow>;

/** The message payload fields this source reads. OpenCode writes more. */
const MessageData = Type.Object({
	role: Type.String(),
	time: Type.Optional(Type.Object({ created: Type.Optional(Type.Number()), completed: Type.Optional(Type.Number()) })),
	parentID: Type.Optional(Type.String()),
	modelID: Type.Optional(Type.String()),
	providerID: Type.Optional(Type.String()),
	summary: Type.Optional(Type.Unknown()),
	cost: Type.Optional(Type.Number()),
	tokens: Type.Optional(
		Type.Object({
			total: Type.Optional(Type.Number()),
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			reasoning: Type.Optional(Type.Number()),
			cache: Type.Optional(Type.Object({ read: Type.Optional(Type.Number()), write: Type.Optional(Type.Number()) })),
		}),
	),
	error: Type.Optional(Type.Object({ name: Type.String(), data: Type.Optional(JsonObject) })),
	finish: Type.Optional(Type.String()),
});
type MessageData = Static<typeof MessageData>;

const ToolState = Type.Object({
	status: Type.String(),
	input: Type.Optional(JsonObject),
	output: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});

/** The part payload fields this source reads, across every part type. */
const PartData = Type.Object({
	type: Type.String(),
	text: Type.Optional(Type.String()),
	synthetic: Type.Optional(Type.Boolean()),
	ignored: Type.Optional(Type.Boolean()),
	callID: Type.Optional(Type.String()),
	tool: Type.Optional(Type.String()),
	state: Type.Optional(ToolState),
});
type PartData = Static<typeof PartData>;

/** A tool call is settled once its state is final; until then it has no result. */
const SETTLED_TOOL_STATES = new Set(["completed", "error"]);

/**
 * OpenCode's error names that mean someone stopped the generation. Recorded as
 * `aborted`, the stop reason the failure catalogue reads as an operator's stop.
 */
const ABORT_ERRORS = new Set(["MessageAbortedError"]);

/** A JSON payload checked against its schema, or null when it is not one. */
function parseJson<S extends TSchema>(schema: S, raw: string): Static<S> | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	return Check(schema, value) ? (value as Static<S>) : null;
}

/** The database path and session id a discovered unit names. */
export function openCodeUnit(filePath: string): { dbPath: string; sessionId: string } {
	const at = filePath.lastIndexOf(UNIT_SEPARATOR);
	if (at <= 0) throw new Error(`not an OpenCode session unit: ${filePath}`);
	return { dbPath: filePath.slice(0, at), sessionId: filePath.slice(at + 1) };
}

/**
 * The arguments a tool call is stored with.
 *
 * OpenCode's file tools name the path `filePath`; the analyzers that look for a
 * path read `path` or `file_path`. The path is copied to `path` so those
 * analyzers see it, and the host's own key is kept beside it.
 */
export function openCodeToolArguments(input: Record<string, unknown>): Record<string, unknown> {
	const filePath = input["filePath"];
	if (typeof filePath === "string" && filePath && input["path"] === undefined) return { ...input, path: filePath };
	return { ...input };
}

export class OpenCodeDbSource implements SessionSourceAdapter {
	readonly source = "opencode";

	/** @param dataDir OpenCode's data directory, which holds `opencode.db`. */
	constructor(private dataDir: string) {}

	async discover(): Promise<DiscoveredSession[]> {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.dataDir);
		} catch {
			return [];
		}
		const results: DiscoveredSession[] = [];
		for (const entry of entries.sort()) {
			if (!OPENCODE_DB_FILE_RE.test(entry)) continue;
			const dbPath = path.join(this.dataDir, entry);
			for (const row of this.sessionRows(dbPath)) {
				results.push({
					filePath: `${dbPath}${UNIT_SEPARATOR}${row.id}`,
					project: projectFromCwd(row.directory),
					mtime: row.changed,
					size: 0,
					source: this.source,
				});
			}
		}
		return results;
	}

	/** Every session row of one database, or none when it is not one this source reads. */
	private sessionRows(dbPath: string): SessionChangeRow[] {
		const db = openReadOnly(dbPath);
		if (!db) return [];
		try {
			if (!hasTables(db, ["session", "message", "part"])) return [];
			const rows = db.prepare(SESSION_CHANGES_SQL).all() as unknown[];
			return rows.filter((r): r is SessionChangeRow => Check(SessionChangeRow, r));
		} finally {
			db.close();
		}
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		const { dbPath, sessionId } = openCodeUnit(disc.filePath);
		const db = openReadOnly(dbPath);
		if (!db) throw new Error(`cannot open OpenCode database ${dbPath}`);
		let session: SessionRow;
		let messageRows: MessageRow[];
		let partRows: PartRow[];
		try {
			const row: unknown = db
				.prepare("SELECT id, parent_id, directory, title, time_created, time_updated FROM session WHERE id = ?")
				.get(sessionId);
			if (!Check(SessionRow, row)) throw new Error(`no OpenCode session ${sessionId} in ${dbPath}`);
			session = row;
			messageRows = (db.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(sessionId) as unknown[]).filter(
				(r): r is MessageRow => Check(MessageRow, r),
			);
			partRows = (db.prepare("SELECT message_id, data FROM part WHERE session_id = ? ORDER BY message_id, id").all(sessionId) as unknown[]).filter(
				(r): r is PartRow => Check(PartRow, r),
			);
		} finally {
			db.close();
		}

		const partsByMessage = new Map<string, PartData[]>();
		for (const row of partRows) {
			const part = parseJson(PartData, row.data);
			if (!part) continue;
			const list = partsByMessage.get(row.message_id) ?? [];
			list.push(part);
			partsByMessage.set(row.message_id, list);
		}

		// The cursor is a time: every message created at or before it has been
		// written. A message still streaming holds the cursor below its own
		// creation time, so it is read again once it settles. A time, rather
		// than a count of rows, keeps working after a revert deletes messages:
		// the messages that replace them are created later, so they are past
		// the cursor wherever they sit.
		const messages: MessageInsert[] = [];
		let settledThrough = Number.MAX_SAFE_INTEGER;
		let latest = resumeLine;
		for (const row of messageRows) {
			const data = parseJson(MessageData, row.data);
			if (!data) continue;
			const rows = this.rowsFor(row, data, partsByMessage.get(row.id) ?? [], session.id);
			if (rows === null) {
				settledThrough = Math.min(settledThrough, row.time_created - 1);
				continue;
			}
			latest = Math.max(latest, row.time_created);
			if (row.time_created > resumeLine) messages.push(...rows);
		}
		const cursor = Math.max(resumeLine, Math.min(latest, settledThrough));

		const sessionInsert: SessionInsert = {
			id: session.id,
			file_path: disc.filePath,
			project: disc.project,
			source: this.source,
			cwd: session.directory,
			parent_session: session.parent_id,
			started_at: new Date(session.time_created).toISOString(),
			last_line: resumeLine,
			last_modified: disc.mtime,
			analyzed_at: null,
			message_count: 0,
			branch_count: 0,
			name: session.title || null,
			// OpenCode does not persist the tool set a session had, so UNKNOWN.
			tool_inventory: null,
		};

		// Row ids are the host's, so a message read twice writes the same rows,
		// and the store ignores the ones it already has.
		return {
			session: sessionInsert,
			messages,
			processedCount: cursor,
			processedTimestamp: disc.mtime,
			forksResolved: 0,
		};
	}

	/**
	 * The index rows one OpenCode message becomes, or null when the message is
	 * a generation still streaming, which is read once it settles.
	 */
	private rowsFor(row: MessageRow, data: MessageData, parts: PartData[], sessionId: string): MessageInsert[] | null {
		const timestamp = new Date(data.time?.created ?? row.time_created).toISOString();
		const base = {
			session_id: sessionId,
			source: this.source,
			timestamp,
			content_thinking: null,
			tool_calls: null,
			tool_results: null,
			usage: null,
			model: null,
			cost_usd: null,
			provider_message_id: null,
			stop_reason: null,
			error_message: null,
		} satisfies Omit<MessageInsert, "id" | "parent_id" | "role" | "content_text">;

		if (data.role === "user") {
			// A compaction request is OpenCode asking itself to summarise; the
			// summary that answers it is the context-management entry.
			if (parts.some((p) => p.type === "compaction")) return [];
			const text = joinText(parts.filter((p) => p.type === "text" && !p.synthetic && !p.ignored));
			if (text === null) return [];
			return [{ ...base, id: row.id, parent_id: null, role: "user", content_text: text }];
		}
		if (data.role !== "assistant") return [];

		const text = joinText(parts.filter((p) => p.type === "text" && !p.synthetic));
		if (data.summary === true) {
			return [{ ...base, id: row.id, parent_id: data.parentID ?? null, role: "compactionSummary", content_text: text }];
		}

		// A generation still streaming is read once it completes or fails, so
		// its row is written with its usage, its stop reason and its results.
		const failed = data.error !== undefined;
		if (data.time?.completed === undefined && !failed) return null;

		const tools = parts.filter((p) => p.type === "tool" && p.callID && p.tool);
		const settled = tools.filter((p) => p.state && SETTLED_TOOL_STATES.has(p.state.status));
		const thinking = joinText(parts.filter((p) => p.type === "reasoning"));
		const errorMessage = failed ? errorText(data.error) : null;
		const stopReason = failed ? (ABORT_ERRORS.has(data.error!.name) ? "aborted" : "error") : (data.finish ?? null);
		const model = data.modelID ? (data.providerID ? `${data.providerID}/${data.modelID}` : data.modelID) : null;

		const rows: MessageInsert[] = [
			{
				...base,
				id: row.id,
				parent_id: data.parentID ?? null,
				role: "assistant",
				content_text: text,
				content_thinking: thinking,
				tool_calls:
					tools.length > 0
						? JSON.stringify(tools.map((p) => ({ id: p.callID!, name: p.tool!, arguments: openCodeToolArguments(p.state?.input ?? {}) })))
						: null,
				usage: usageOf(data),
				model,
				// Cost is money: a generation OpenCode priced at zero carries no cost.
				cost_usd: typeof data.cost === "number" && data.cost > 0 ? data.cost : null,
				provider_message_id: row.id,
				stop_reason: stopReason,
				error_message: errorMessage,
			},
		];

		if (settled.length > 0) {
			rows.push({
				...base,
				id: `${row.id}:results`,
				parent_id: row.id,
				role: "toolResult",
				content_text: null,
				tool_results: JSON.stringify(
					settled.map((p) => {
						const isError = p.state!.status === "error";
						const resultText = (isError ? p.state!.error : p.state!.output) ?? "";
						const errorClass = classifyToolError(isError, resultText || null);
						const entry = { toolCallId: p.callID!, toolName: p.tool!, isError, textLength: resultText.length };
						return errorClass ? { ...entry, errorClass } : entry;
					}),
				),
			});
		}
		return rows;
	}
}

function openReadOnly(dbPath: string): Database.Database | null {
	try {
		return new Database(dbPath, { readonly: true, fileMustExist: true });
	} catch {
		return null;
	}
}

function hasTables(db: Database.Database, names: readonly string[]): boolean {
	const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: unknown }>;
	const present = new Set(rows.map((r) => r.name));
	return names.every((n) => present.has(n));
}

function joinText(parts: PartData[]): string | null {
	const texts = parts.map((p) => p.text ?? "").filter((t) => t.length > 0);
	return texts.length > 0 ? texts.join("\n") : null;
}

/** The host's error text, verbatim, or its name when it recorded no message. */
function errorText(error: MessageData["error"]): string {
	const message = error?.data?.["message"];
	return typeof message === "string" && message.length > 0 ? message : (error?.name ?? "");
}

/**
 * The generation's token buckets, in the index's shape.
 *
 * OpenCode reports `input` without the cached tokens and `output` without the
 * reasoning tokens, so the total is input plus output plus reasoning: the
 * tokens the model read fresh and wrote. Cost is recorded per message, not per
 * bucket, so the bucket breakdown stays null.
 */
function usageOf(data: MessageData): string | null {
	const t = data.tokens;
	if (!t) return null;
	const input = t.input ?? 0;
	const output = t.output ?? 0;
	const reasoning = t.reasoning ?? 0;
	const cacheRead = t.cache?.read ?? 0;
	const cacheWrite = t.cache?.write ?? 0;
	if (input === 0 && output === 0 && reasoning === 0 && cacheRead === 0 && cacheWrite === 0) return null;
	return JSON.stringify({ input, output: output + reasoning, cacheRead, cacheWrite, totalTokens: input + output + reasoning, cost: null });
}
