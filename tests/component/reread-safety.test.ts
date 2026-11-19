/**
 * What a re-read may and may not overwrite (rehearsal of `prospect sync --reread`).
 *
 * 1. A field the adapter does not provide never replaces a stored value.
 * 2. A rebuilt transcript is never a source of extras, events or session fields.
 * 3. A file too large for one string is read as a stream of lines.
 * Every transcript here is invented.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { upsertSession, type SessionInsert } from "../../src/db/queries.js";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import { CodexFileSource } from "../../src/sync/sources/codex/index.js";
import { codexMessageLine, codexMetaLine, codexRolloutFileName } from "../fixtures/codex-rollout.js";
import type { SessionSourceAdapter } from "../../src/sync/adapter.js";
import { PiSubagentSource } from "../../src/sync/sources/pi-subagent/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude/index.js";
import { exportClaudeSession, getExportableSession } from "../../src/sync/claude-export.js";
import { setBatchLimitsForTests } from "../../src/sync/line-batches.js";
import { readSessionLines, setReadLimitsForTests } from "../../src/sync/read-lines.js";
import { claudeSessionFileName, claudeSessionId, makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine } from "./helpers.js";

const SID = "11111111-2222-4333-a444-555555555555";
const PARENT = "aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee";

async function openDb(root: string): Promise<AsyncDatabase> {
	const db = openAsyncDatabase(path.join(root, "t.db"));
	await migrate(db);
	return db;
}

async function sessionRow(db: AsyncDatabase): Promise<Record<string, unknown>> {
	return (await db.prepare("SELECT * FROM sessions").get()) as Record<string, unknown>;
}

const base: SessionInsert = {
	id: "s1", file_path: "/x/s1.jsonl", project: "proj", source: "pi", cwd: "", parent_session: null, started_at: "",
	last_line: 3, last_modified: 100, analyzed_at: null, message_count: 0, branch_count: 0, name: null, tool_inventory: null,
};

describe("an upsert of an existing session keeps what the adapter does not provide", () => {
	// What each source's adapter leaves empty on a read, from its `read()`.
	const sources: Array<[string, Partial<SessionInsert>]> = [
		["pi", { source: "pi", parent_session: null, name: null, tool_inventory: null }],
		["pi-subagent", { source: "pi-subagent", parent_session: null, tool_inventory: null }],
		["claude", { source: "claude", cwd: "", started_at: "", name: null, tool_inventory: null }],
		["codex", { source: "codex", name: null, tool_inventory: null, parent_session: null }],
		["cline", { source: "cline", parent_session: null, name: null, tool_inventory: null }],
		["opencode", { source: "opencode", parent_session: null, name: null, tool_inventory: null }],
	];
	for (const [name, empty] of sources) {
		it(`${name}: a second read with those fields empty leaves the stored row whole`, async () => {
			const { root, cleanup } = makeTempRoot("prospect-upsert-");
			const db = await openDb(root);
			try {
				const known: SessionInsert = { ...base, source: name, cwd: "/work/proj", parent_session: "parent-1", started_at: "2026-01-01T00:00:00Z", name: "A name", tool_inventory: "[]", host: "host-a" };
				await upsertSession(db, known);
				const before = await sessionRow(db);
				await upsertSession(db, { ...base, ...empty, source: name, last_line: 5, last_modified: 200 });
				const after = await sessionRow(db);
				// Only the cursor moves.
				assert.deepEqual({ ...after, last_line: before["last_line"], last_modified: before["last_modified"] }, before);
				assert.equal(after["last_line"], 5);
			} finally {
				await db.close();
				cleanup();
			}
		});
	}

	it("still replaces a stored value with one the adapter provides", async () => {
		const { root, cleanup } = makeTempRoot("prospect-upsert-");
		const db = await openDb(root);
		try {
			await upsertSession(db, { ...base, cwd: "/old", name: "old", parent_session: "p1", tool_inventory: "[]" });
			await upsertSession(db, { ...base, cwd: "/new", name: "new", parent_session: "p2", tool_inventory: '[{"name":"x"}]' });
			const row = await sessionRow(db);
			assert.deepEqual([row["cwd"], row["name"], row["parent_session"], row["tool_inventory"]], ["/new", "new", "p2", '[{"name":"x"}]']);
		} finally {
			await db.close();
			cleanup();
		}
	});
});

describe("a text column the adapter leaves empty or blank keeps the stored value", () => {
	const columns = ["project", "cwd", "parent_session", "started_at", "name", "tool_inventory", "host"] as const;
	for (const column of columns) {
		for (const blank of ["", "   "]) {
			it(`${column} read as ${JSON.stringify(blank)}`, async () => {
				const { root, cleanup } = makeTempRoot("prospect-blank-");
				const db = await openDb(root);
				try {
					const known: SessionInsert = { ...base, project: "proj", cwd: "/work", parent_session: "p1", started_at: "2026-01-01T00:00:00Z", name: "A name", tool_inventory: "[]", host: "host-a" };
					await upsertSession(db, known);
					await upsertSession(db, { ...known, [column]: blank, last_line: 9 });
					const row = await sessionRow(db);
					assert.equal(row[column], known[column], `${column} was replaced by ${JSON.stringify(blank)}`);
				} finally {
					await db.close();
					cleanup();
				}
			});
		}
	}

	it("a real adapter path: a Claude Code title of only spaces does not replace the stored title", async () => {
		const { root, cleanup } = makeTempRoot("prospect-blank-title-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, claudeSessionFileName("blank-title"));
			const user = JSON.stringify({ type: "user", uuid: "a", parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: "a" } });
			fs.writeFileSync(file, [user, JSON.stringify({ type: "ai-title", aiTitle: "Real title" })].join("\n") + "\n");
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			fs.writeFileSync(file, [user, JSON.stringify({ type: "ai-title", aiTitle: "   " })].join("\n") + "\n");
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { reread: true });
			assert.equal((await sessionRow(db))["name"], "Real title");
		} finally {
			await db.close();
			cleanup();
		}
	});
});

describe("a re-read of a child run keeps its parent", () => {
	it("pi-subagent sets the parent, and a later read by the pi adapter keeps it", async () => {
		const { root, cleanup } = makeTempRoot("prospect-child-");
		const db = await openDb(root);
		try {
			const sessions = path.join(root, "sessions");
			const dir = path.join(sessions, "--tmp-p--", `2026-03-01T09-59-00Z_${PARENT}`, "2b83bd26", "run-0");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, "session.jsonl"), [sessionHeaderLine(SID), messageLine(SID, 1, "user", "child turn", "2026-03-01T10:00:05Z")].join("\n") + "\n");
			await runSync(db, [new PiSubagentSource(sessions)], {});
			const before = await sessionRow(db);
			assert.equal(before["parent_session"], PARENT);
			const result = await runSync(db, [new PiFileSource(sessions)], { reread: true });
			assert.deepEqual(result.errors, []);
			const after = await sessionRow(db);
			assert.equal(after["parent_session"], PARENT);
			// The adapter that claims the file names the source; that is not a value it failed to provide.
			assert.deepEqual({ ...after, source: before["source"] }, before);
		} finally {
			await db.close();
			cleanup();
		}
	});

	it("claude: a reread leaves the whole sessions row as it was", async () => {
		const { root, cleanup } = makeTempRoot("prospect-claude-row-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			const line = (id: string) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: id } });
			fs.writeFileSync(path.join(dir, claudeSessionFileName("row")), [line("a"), JSON.stringify({ type: "ai-title", aiTitle: "A title" })].join("\n") + "\n");
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			await db.exec("UPDATE sessions SET tool_inventory = '[]'");
			const before = await sessionRow(db);
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { reread: true });
			assert.deepEqual(await sessionRow(db), before);
			assert.equal(claudeSessionId("row"), before["id"]);
		} finally {
			await db.close();
			cleanup();
		}
	});
});

describe("a file too large for one string", () => {
	it("reads the same lines as a split, across chunk boundaries and multi-byte characters", async () => {
		const { root, cleanup } = makeTempRoot("prospect-stream-");
		try {
			const body = ["line one", "café ✓ \u{1F600}", "", "crlf line\r", "last line"].join("\n");
			for (const content of [body, body + "\n", "", "\n"]) {
				const file = path.join(root, "f.jsonl");
				fs.writeFileSync(file, content);
				setReadLimitsForTests({ wholeReadBytes: 0, chunkBytes: 3 });
				try {
					assert.deepEqual(await readSessionLines(file), content.split("\n"));
				} finally {
					setReadLimitsForTests(null);
				}
			}
		} finally {
			cleanup();
		}
	});

	it("syncs a Claude Code file past the whole-read limit with the same rows as a whole read", async () => {
		const { root, cleanup } = makeTempRoot("prospect-stream-sync-");
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			const line = (id: string) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", message: { role: "user", content: `${id} é✓` } });
			fs.writeFileSync(path.join(dir, claudeSessionFileName("big")), [line("a"), line("b"), line("c")].join("\n") + "\n");
			const rows: string[] = [];
			for (const stream of [false, true]) {
				const db = await openDb(root);
				try {
					if (stream) setReadLimitsForTests({ wholeReadBytes: 10, chunkBytes: 7 });
					const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
					assert.deepEqual(result.errors, []);
					rows.push(JSON.stringify([await db.prepare("SELECT id, content_text FROM messages ORDER BY rowid").all(), await db.prepare("SELECT last_line FROM sessions").all()]));
				} finally {
					setReadLimitsForTests(null);
					await db.close();
					fs.rmSync(path.join(root, "t.db"), { force: true });
					fs.rmSync(path.join(root, "t.db-wal"), { force: true });
					fs.rmSync(path.join(root, "t.db-shm"), { force: true });
				}
			}
			assert.equal(rows[1], rows[0]);
			assert.match(rows[0]!, /"last_line":3/);
		} finally {
			cleanup();
		}
	});
});

/** Every table's rows, for a comparison of the whole database. */
async function everyTable(db: AsyncDatabase): Promise<Record<string, unknown[]>> {
	const names = ((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) as Array<{ name: string }>).map((t) => t.name);
	const out: Record<string, unknown[]> = {};
	for (const n of names) out[n] = await db.prepare(`SELECT * FROM "${n}"`).all();
	return out;
}

describe("a rebuilt transcript in the sessions root", () => {
	const claudeLine = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: id }, ...extra });

	async function counts(db: AsyncDatabase): Promise<string> {
		return JSON.stringify({
			sessions: await db.prepare("SELECT * FROM sessions").all(),
			messages: await db.prepare("SELECT * FROM messages ORDER BY rowid").all(),
			extras: await db.prepare("SELECT * FROM message_extras ORDER BY message_id").all(),
			events: await db.prepare("SELECT * FROM session_events ORDER BY line, ref").all(),
		});
	}

	for (const [label, mark] of [["a restoredFrom field on its records", "field"], ["a .restore.json report beside it", "report"]] as const) {
		it(`is skipped for extras, events and session fields, and counted: ${label}`, async () => {
			const { root, cleanup } = makeTempRoot("prospect-rebuilt-");
			const db = await openDb(root);
			try {
				const dir = path.join(root, "projects", "-tmp-p");
				fs.mkdirSync(dir, { recursive: true });
				const file = path.join(dir, claudeSessionFileName("rebuilt"));
				// The original, synced first.
				fs.writeFileSync(file, [claudeLine("a"), JSON.stringify({ type: "attachment", attachment: { type: "date", date: "2026-02-01" } }), claudeLine("b")].join("\n") + "\n");
				await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
				await db.exec("UPDATE sessions SET name = 'A title', tool_inventory = '[]'");
				const before = await counts(db);
				const tablesBefore = await everyTable(db);
				// The original is deleted and a rebuild takes its place: other bytes, other lines, newer time.
				fs.rmSync(file);
				const rebuilt = [claudeLine("a", mark === "field" ? { restoredFrom: "pi-prospector" } : {}), JSON.stringify({ type: "ai-title", aiTitle: "Other", ...(mark === "field" ? { restoredFrom: "pi-prospector" } : {}) }), claudeLine("b", mark === "field" ? { restoredFrom: "pi-prospector" } : {}), claudeLine("c", mark === "field" ? { restoredFrom: "pi-prospector" } : {})];
				fs.writeFileSync(file, rebuilt.join("\n") + "\n");
				if (mark === "report") fs.writeFileSync(file.replace(/\.jsonl$/, ".restore.json"), "{}\n");
				const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { reread: true });
				assert.deepEqual(result.errors, []);
				assert.equal(result.bySource["claude"]?.rebuiltSkipped, 1);
				// A message the index does not have yet still inserts; nothing else changes.
				const after = JSON.parse(await counts(db)) as { messages: Array<{ id: string }>; extras: unknown; events: unknown; sessions: unknown };
				const was = JSON.parse(before) as typeof after;
				assert.deepEqual(after.extras, was.extras);
				assert.deepEqual(after.events, was.events);
				// No session field and no cursor moved; the message count follows the stored rows.
				const rows = (await db.prepare("SELECT COUNT(*) AS n FROM messages").get()) as { n: number };
				assert.equal(rows.n, 3);
				const strip = (list: unknown): unknown => (list as Array<Record<string, unknown>>).map(({ message_count: _m, ...rest }) => rest);
				assert.deepEqual(strip(after.sessions), strip(was.sessions));
				assert.equal((after.sessions as Array<{ message_count: number }>)[0]!.message_count, 3, "the count matches the stored rows");
				// Every other table is as it was: the new message is the only new row, and the count the only changed field.
				const tablesAfter = await everyTable(db);
				for (const t of Object.keys(tablesBefore)) {
					if (t === "messages" || t === "sessions" || t.startsWith("messages_")) continue;
					assert.deepEqual(tablesAfter[t], tablesBefore[t], `table ${t} changed`);
				}
				assert.equal((tablesAfter["messages"] as unknown[]).length, (tablesBefore["messages"] as unknown[]).length + 1);
				assert.deepEqual(after.messages.map((m) => m.id), ["a", "b", "c"]);
			} finally {
				await db.close();
				cleanup();
			}
		});
	}

	it("is not mistaken for a rebuild when an original transcript mentions the marker in its text", async () => {
		const { root, cleanup } = makeTempRoot("prospect-notrebuilt-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, claudeSessionFileName("mention")), [claudeLine("a"), JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "a", timestamp: "2026-02-01T09:00:01.000Z", message: { id: "m", role: "assistant", content: [{ type: "text", text: 'records carry a "restoredFrom" field' }] } })].join("\n") + "\n");
			const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			assert.equal(result.bySource["claude"]?.rebuiltSkipped, 0);
			assert.ok(((await db.prepare("SELECT COUNT(*) AS n FROM message_extras").get()) as { n: number }).n >= 2);
		} finally {
			await db.close();
			cleanup();
		}
	});

	it("re-importing the export of a session changes no row", async () => {
		const { root, cleanup } = makeTempRoot("prospect-roundtrip-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, claudeSessionFileName("again"));
			fs.writeFileSync(file, [claudeLine("a"), JSON.stringify({ type: "attachment", attachment: { type: "date", date: "2026-02-01" } }), claudeLine("b")].join("\n") + "\n");
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			const before = await counts(db);
			const session = (await getExportableSession(db, claudeSessionId("again")))!;
			fs.rmSync(file);
			await exportClaudeSession(db, session, path.join(root, "projects"), path.join(root, "projects"));
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { reread: true });
			assert.equal(await counts(db), before);
		} finally {
			await db.close();
			cleanup();
		}
	});
});

describe("the sync summary", () => {
	it("reports a pi file with no header by class, and counts per source", async () => {
		const { root, cleanup } = makeTempRoot("prospect-summary-");
		const db = await openDb(root);
		try {
			const sessions = path.join(root, "sessions");
			const good = path.join(sessions, "--tmp-p--", piSessionFileName(SID));
			const bad = path.join(sessions, "--tmp-p--", piSessionFileName("22222222-2222-4333-a444-555555555555"));
			fs.mkdirSync(path.dirname(good), { recursive: true });
			fs.writeFileSync(good, [sessionHeaderLine(SID), messageLine(SID, 1, "user", "hi", "2026-08-19T01:03:00Z")].join("\n") + "\n");
			fs.writeFileSync(bad, "not a header\n");
			const result = await runSync(db, [new PiFileSource(sessions)], {});
			const pi = result.bySource["pi"]!;
			// visited counts files examined: the good file and the one that failed its header check.
			assert.equal(pi.visited, 2);
			assert.equal(pi.sessionsAdded, 1);
			assert.equal(pi.messagesAdded, 1);
			assert.deepEqual(pi.errors, { "no-session-header": 1 });
			const again = await runSync(db, [new PiFileSource(sessions)], { reread: true });
			assert.equal(again.bySource["pi"]!.messagesAdded, 0);
			assert.equal(again.bySource["pi"]!.sessionFieldsChanged, 0);
			assert.equal(again.bySource["pi"]!.extrasAdded, 0);
		} finally {
			await db.close();
			cleanup();
		}
	});

	it("counts extras and events added, and none on a second reread", async () => {
		const { root, cleanup } = makeTempRoot("prospect-summary2-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, claudeSessionFileName("sum")), [JSON.stringify({ type: "user", uuid: "a", parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", message: { role: "user", content: "a" } }), JSON.stringify({ type: "attachment", attachment: { type: "date", date: "2026-02-01" } })].join("\n") + "\n");
			const first = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			assert.deepEqual([first.bySource["claude"]!.extrasAdded, first.bySource["claude"]!.eventsAdded], [1, 1]);
			const reread = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { reread: true });
			assert.deepEqual([reread.bySource["claude"]!.extrasAdded, reread.bySource["claude"]!.eventsAdded, reread.bySource["claude"]!.messagesAdded], [0, 0, 0]);
		} finally {
			await db.close();
			cleanup();
		}
	});
});

describe("the in-memory and the streamed read agree", () => {
	interface Shape {
		name: string;
		adapter: (root: string) => SessionSourceAdapter;
		file: (root: string) => string;
		lines: string[];
	}
	const claudeUser = (id: string) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: `${id} café ✓` } });
	const shapes: Shape[] = [
		{ name: "Claude Code", adapter: (r) => new ClaudeFileSource(r), file: (r) => path.join(r, "-tmp-p", claudeSessionFileName("agree")), lines: [claudeUser("a"), JSON.stringify({ type: "attachment", attachment: { type: "date", date: "2026-02-01" } }), claudeUser("b")] },
		{ name: "Pi", adapter: (r) => new PiFileSource(r), file: (r) => path.join(r, "--tmp-p--", piSessionFileName(SID)), lines: [sessionHeaderLine(SID), messageLine(SID, 1, "user", "one café", "2026-08-19T01:03:00Z"), messageLine(SID, 2, "assistant", "two", "2026-08-19T01:04:00Z")] },
		{ name: "Pi subagent", adapter: (r) => new PiSubagentSource(r), file: (r) => path.join(r, "--tmp-p--", `2026-03-01T09-59-00Z_${PARENT}`, "2b83bd26", "run-0", "session.jsonl"), lines: [sessionHeaderLine(SID), messageLine(SID, 1, "user", "one", "2026-08-19T01:03:00Z"), messageLine(SID, 2, "assistant", "two", "2026-08-19T01:04:00Z")] },
		{ name: "Codex", adapter: (r) => new CodexFileSource(r), file: (r) => path.join(r, "2026", "03", "04", codexRolloutFileName("agree")), lines: [codexMetaLine("agree"), codexMessageLine("user", "hello café"), codexMessageLine("assistant", "hi")] },
	];
	const contents = (lines: string[]): Array<[string, string]> => [
		["a final newline", lines.join("\n") + "\n"],
		["no final newline", lines.join("\n")],
		["a half-written last line", lines.slice(0, -1).join("\n") + "\n" + lines[lines.length - 1]!.slice(0, 12)],
		["an empty file", ""],
	];

	async function run(shape: Shape, content: string, streamed: boolean): Promise<string> {
		const { root, cleanup } = makeTempRoot("prospect-agree-");
		const db = await openDb(root);
		try {
			const sessions = path.join(root, "sessions");
			const target = shape.file(sessions);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
			fs.utimesSync(target, 1_800_000_000, 1_800_000_000);
			if (streamed) setReadLimitsForTests({ wholeReadBytes: 0, chunkBytes: 5 });
			const first = await runSync(db, [shape.adapter(sessions)], {});
			// Append a whole line afterwards: the cursor decides whether it is read.
			const extra = shape.lines[shape.lines.length - 1]!;
			const grown = content === "" ? "" : (content.endsWith("\n") ? content : content + "\n") + extra + "\n";
			fs.writeFileSync(target, grown);
			fs.utimesSync(target, 1_800_000_100, 1_800_000_100);
			const second = await runSync(db, [shape.adapter(sessions)], {});
			const names = ((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'messages', 'message_extras', 'session_events')").all()) as Array<{ name: string }>).map((t) => t.name).sort();
			const dump: Record<string, unknown> = { errors: [first.errors, second.errors] };
			for (const n of names) dump[n] = await db.prepare(`SELECT * FROM "${n}"`).all();
			// The temporary root differs between the two runs; nothing else may.
			return JSON.stringify(dump).split(root).join("<root>");
		} finally {
			setReadLimitsForTests(null);
			await db.close();
			cleanup();
		}
	}

	for (const shape of shapes) {
		for (const [label, content] of contents(shape.lines)) {
			it(`${shape.name}, ${label}: same line count, cursor and parsed records`, async () => {
				const whole = await run(shape, content, false);
				const streamed = await run(shape, content, true);
				assert.equal(streamed, whole);
			});
		}
	}
});

describe("a fork whose parent has a line past the limit", () => {
	it("ends the child file as its classified error, names the parent, and leaves the run and the other files alone", async () => {
		const { root, cleanup } = makeTempRoot("prospect-fork-long-");
		const db = await openDb(root);
		try {
			const sessions = path.join(root, "sessions");
			const dir = path.join(sessions, "--tmp-p--");
			fs.mkdirSync(dir, { recursive: true });
			const parentId = "33333333-3333-4333-a444-555555555555";
			const parent = path.join(root, "elsewhere", piSessionFileName(parentId));
			fs.mkdirSync(path.dirname(parent), { recursive: true });
			// Short lines first, so the header read finishes before the long line is reached; the long line fails the count.
			fs.writeFileSync(parent, [sessionHeaderLine(parentId), messageLine(parentId, 1, "user", "a", "2026-08-19T01:03:00Z"), messageLine(parentId, 2, "user", "b", "2026-08-19T01:03:10Z"), messageLine(parentId, 3, "user", "c", "2026-08-19T01:03:20Z"), messageLine(parentId, 4, "user", "x".repeat(600), "2026-08-19T01:03:30Z")].join("\n") + "\n");
			const child = path.join(dir, piSessionFileName(SID));
			fs.writeFileSync(child, [JSON.stringify({ type: "session", version: 3, id: SID, timestamp: "2026-08-19T01:05:00Z", cwd: "/tmp", parentSession: parent }), messageLine(SID, 1, "user", "hi", "2026-08-19T01:06:00Z")].join("\n") + "\n");
			const other = "44444444-4444-4333-a444-555555555555";
			fs.writeFileSync(path.join(dir, piSessionFileName(other)), [sessionHeaderLine(other), messageLine(other, 1, "user", "fine", "2026-08-19T01:07:00Z")].join("\n") + "\n");
			setReadLimitsForTests({ wholeReadBytes: 1e12, chunkBytes: 64, maxLineChars: 300 });
			setBatchLimitsForTests({ maxLines: 2, maxBytes: 1e9, chunkBytes: 64 });
			let result;
			try {
				result = await runSync(db, [new PiFileSource(sessions)], {});
			} finally {
				setReadLimitsForTests(null);
				setBatchLimitsForTests(null);
			}
			assert.deepEqual(result.bySource["pi"]!.errors, { "line-too-large": 1 });
			assert.match(result.errors.join("\n"), /parent session/, "the message says the fault is in the parent");
			assert.ok(result.errors[0]!.includes(piSessionFileName(SID)), "and names the child file");
			const ids = ((await db.prepare("SELECT id FROM sessions").all()) as Array<{ id: string }>).map((s) => s.id);
			assert.ok(ids.includes(other));
			assert.equal(ids.includes(SID), false);
		} finally {
			await db.close();
			cleanup();
		}
	});
});
