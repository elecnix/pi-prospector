/**
 * Synthetic OpenCode databases.
 *
 * OpenCode 1.x keeps every session in one SQLite database, `opencode.db`, under
 * its data directory (`~/.local/share/opencode/`). A session is a row of the
 * `session` table; each of its messages is a row of `message`, and each piece of
 * a message (text, reasoning, a tool call and its result) is a row of `part`.
 * The message and part rows keep the payload as JSON in a `data` column, with
 * the ids that the columns already carry stripped out.
 *
 * The tables below copy the columns that OpenCode v1.19.3 creates
 * (packages/core/src/session/sql.ts and project/sql.ts at that tag). Every id,
 * path, model name and prompt here is invented: the shapes are OpenCode's, the
 * content is not. Nothing is copied from a real session.
 */
import Database from "better-sqlite3";
import { Type, type Static } from "typebox";

const SCHEMA = [
	`CREATE TABLE project (
		id text PRIMARY KEY,
		worktree text NOT NULL,
		vcs text,
		name text,
		icon_url text,
		icon_url_override text,
		icon_color text,
		time_created integer NOT NULL,
		time_updated integer NOT NULL,
		time_initialized integer,
		sandboxes text NOT NULL,
		commands text
	)`,
	`CREATE TABLE session (
		id text PRIMARY KEY,
		project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
		workspace_id text,
		parent_id text,
		slug text NOT NULL,
		directory text NOT NULL,
		path text,
		title text NOT NULL,
		version text NOT NULL,
		share_url text,
		summary_additions integer,
		summary_deletions integer,
		summary_files integer,
		summary_diffs text,
		metadata text,
		cost real DEFAULT 0 NOT NULL,
		tokens_input integer DEFAULT 0 NOT NULL,
		tokens_output integer DEFAULT 0 NOT NULL,
		tokens_reasoning integer DEFAULT 0 NOT NULL,
		tokens_cache_read integer DEFAULT 0 NOT NULL,
		tokens_cache_write integer DEFAULT 0 NOT NULL,
		revert text,
		permission text,
		agent text,
		model text,
		time_created integer NOT NULL,
		time_updated integer NOT NULL,
		time_compacting integer,
		time_archived integer
	)`,
	`CREATE TABLE message (
		id text PRIMARY KEY,
		session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
		time_created integer NOT NULL,
		time_updated integer NOT NULL,
		data text NOT NULL
	)`,
	`CREATE TABLE part (
		id text PRIMARY KEY,
		message_id text NOT NULL REFERENCES message(id) ON DELETE CASCADE,
		session_id text NOT NULL,
		time_created integer NOT NULL,
		time_updated integer NOT NULL,
		data text NOT NULL
	)`,
	"CREATE INDEX message_session_time_created_id_idx ON message (session_id, time_created, id)",
	"CREATE INDEX part_message_id_id_idx ON part (message_id, id)",
	"CREATE INDEX part_session_idx ON part (session_id)",
];

/** The working directory every fixture session ran in unless a test names another. */
export const OPENCODE_FIXTURE_DIR = "/home/tester/workspace/notes-app";

const JsonObject = Type.Record(Type.String(), Type.Unknown());

/** A fixture session: the columns a test sets, the rest defaulted. */
export const OpenCodeSessionOptions = Type.Object({
	id: Type.String(),
	title: Type.Optional(Type.String()),
	directory: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	timeCreated: Type.Optional(Type.Number()),
	timeUpdated: Type.Optional(Type.Number()),
});
export type OpenCodeSessionOptions = Static<typeof OpenCodeSessionOptions>;

/** One message and its parts, in the order OpenCode writes them. */
export const OpenCodeMessageFixture = Type.Object({
	id: Type.String(),
	timeCreated: Type.Number(),
	data: JsonObject,
	parts: Type.Array(Type.Object({ id: Type.String(), data: JsonObject })),
});
export type OpenCodeMessageFixture = Static<typeof OpenCodeMessageFixture>;

/** A writable synthetic OpenCode database. */
export class OpenCodeFixtureDb {
	readonly db: Database.Database;

	constructor(readonly path: string, schema: readonly string[] = SCHEMA) {
		this.db = new Database(path);
		this.db.pragma("journal_mode = WAL");
		for (const statement of schema) this.db.exec(statement);
		this.db
			.prepare("INSERT INTO project (id, worktree, vcs, time_created, time_updated, sandboxes) VALUES (?, ?, 'git', ?, ?, '[]')")
			.run("prj_fixture", OPENCODE_FIXTURE_DIR, 1772611200000, 1772611200000);
	}

	addSession(options: OpenCodeSessionOptions): void {
		const created = options.timeCreated ?? 1772615700000;
		this.db
			.prepare(
				"INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) " +
					"VALUES (?, 'prj_fixture', ?, ?, ?, ?, '1.19.3', ?, ?)",
			)
			.run(
				options.id,
				options.parentId ?? null,
				`slug-${options.id}`,
				options.directory ?? OPENCODE_FIXTURE_DIR,
				options.title ?? "Add a groceries note",
				created,
				options.timeUpdated ?? created,
			);
	}

	/** Write a message and its parts, as OpenCode's projector does. */
	addMessage(sessionId: string, message: OpenCodeMessageFixture, timeUpdated = message.timeCreated): void {
		this.db
			.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
			.run(message.id, sessionId, message.timeCreated, timeUpdated, JSON.stringify(message.data));
		for (const part of message.parts) {
			this.db
				.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
				.run(part.id, message.id, sessionId, message.timeCreated, timeUpdated, JSON.stringify(part.data));
		}
	}

	/** Replace a message's payload, as OpenCode does when a generation finishes. */
	updateMessage(messageId: string, data: Record<string, unknown>, timeUpdated: number): void {
		this.db.prepare("UPDATE message SET data = ?, time_updated = ? WHERE id = ?").run(JSON.stringify(data), timeUpdated, messageId);
	}

	/** Replace a part's payload, as OpenCode does when a tool call settles. */
	updatePart(partId: string, data: Record<string, unknown>, timeUpdated: number): void {
		this.db.prepare("UPDATE part SET data = ?, time_updated = ? WHERE id = ?").run(JSON.stringify(data), timeUpdated, partId);
	}

	/** Delete a message and its parts, as a revert does. */
	removeMessage(messageId: string): void {
		this.db.prepare("DELETE FROM part WHERE message_id = ?").run(messageId);
		this.db.prepare("DELETE FROM message WHERE id = ?").run(messageId);
	}

	close(): void {
		this.db.close();
	}
}

/** A database with only a `session` table: the shape of a store this source does not read. */
export function openCodeDbWithoutMessages(path: string): void {
	const db = new Database(path);
	db.exec("CREATE TABLE session (id text PRIMARY KEY, directory text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL)");
	db.close();
}

/** A user message's `data`, as OpenCode stores it (id and session id stripped). */
export function openCodeUser(created: number): Record<string, unknown> {
	return {
		role: "user",
		time: { created },
		agent: "build",
		model: { providerID: "fixture-provider", modelID: "fixture-model-1" },
	};
}

export const OpenCodeAssistantOptions = Type.Object({
	parentId: Type.String(),
	/** When the generation finished; null for one still streaming. */
	completed: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	cost: Type.Optional(Type.Number()),
	tokens: Type.Optional(
		Type.Object({
			input: Type.Optional(Type.Number()),
			output: Type.Optional(Type.Number()),
			reasoning: Type.Optional(Type.Number()),
			cacheRead: Type.Optional(Type.Number()),
			cacheWrite: Type.Optional(Type.Number()),
			total: Type.Optional(Type.Number()),
		}),
	),
	finish: Type.Optional(Type.String()),
	error: Type.Optional(Type.Object({ name: Type.String(), data: JsonObject })),
	summary: Type.Optional(Type.Boolean()),
	modelId: Type.Optional(Type.String()),
});
export type OpenCodeAssistantOptions = Static<typeof OpenCodeAssistantOptions>;

/** An assistant message's `data`, as OpenCode stores it. */
export function openCodeAssistant(created: number, options: OpenCodeAssistantOptions): Record<string, unknown> {
	const t = options.tokens ?? {};
	const data: Record<string, unknown> = {
		role: "assistant",
		time: options.completed === null ? { created } : { created, completed: options.completed ?? created + 900 },
		parentID: options.parentId,
		modelID: options.modelId ?? "fixture-model-1",
		providerID: "fixture-provider",
		mode: options.summary ? "compaction" : "build",
		agent: options.summary ? "compaction" : "build",
		path: { cwd: OPENCODE_FIXTURE_DIR, root: OPENCODE_FIXTURE_DIR },
		cost: options.cost ?? 0,
		tokens: {
			...(t.total !== undefined ? { total: t.total } : {}),
			input: t.input ?? 0,
			output: t.output ?? 0,
			reasoning: t.reasoning ?? 0,
			cache: { read: t.cacheRead ?? 0, write: t.cacheWrite ?? 0 },
		},
	};
	if (options.finish) data["finish"] = options.finish;
	if (options.error) data["error"] = options.error;
	if (options.summary) data["summary"] = true;
	return data;
}

export function openCodeText(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "text", text, ...extra };
}

export function openCodeReasoning(text: string, start: number): Record<string, unknown> {
	return { type: "reasoning", text, time: { start, end: start + 50 } };
}

export function openCodeStepFinish(): Record<string, unknown> {
	return {
		type: "step-finish",
		reason: "tool-calls",
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	};
}

/** A settled tool call: `completed` with its output, or `error` with its error text. */
export function openCodeTool(
	callId: string,
	tool: string,
	input: Record<string, unknown>,
	outcome: { output: string } | { error: string } | { pending: true },
	start = 1772615710000,
): Record<string, unknown> {
	if ("pending" in outcome) {
		return { type: "tool", callID: callId, tool, state: { status: "running", input, time: { start } } };
	}
	const state =
		"output" in outcome
			? { status: "completed", input, output: outcome.output, title: tool, metadata: {}, time: { start, end: start + 120 } }
			: { status: "error", input, error: outcome.error, time: { start, end: start + 120 } };
	return { type: "tool", callID: callId, tool, state };
}
