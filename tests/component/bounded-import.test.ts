/**
 * A session is imported in batches, so memory does not grow with the file.
 *
 * Every transcript here is generated. The peak-heap test runs the import in a child
 * process with a low `--max-old-space-size`, so an import that holds a whole file fails
 * by running out of memory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { runSync, type FileEvent } from "../../src/sync/index.js";
import { collectBatches, type SessionSourceAdapter, type ParsedSession } from "../../src/sync/adapter.js";
import type { DiscoveredSession } from "../../src/types.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude/index.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import { PiSubagentSource } from "../../src/sync/sources/pi-subagent/index.js";
import { CodexFileSource } from "../../src/sync/sources/codex/index.js";
import { setReadLimitsForTests } from "../../src/sync/read-lines.js";
import { setBatchLimitsForTests } from "../../src/sync/line-batches.js";
import { exportClaudeSession, getExportableSession } from "../../src/sync/claude-export.js";
import { codexMessageLine, codexMetaLine, codexRolloutFileName } from "../fixtures/codex-rollout.js";
import { claudeSessionFileName, claudeSessionId, makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine } from "./helpers.js";

const SID = "11111111-2222-4333-a444-555555555555";
const PARENT = "aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHILD = path.resolve(import.meta.dirname, "bounded-import-child.mts");

/** A Claude Code transcript of about `bytes` bytes: user and assistant turns with a tool call and its result. */
function claudeTranscript(bytes: number): string[] {
	const text = "lorem ipsum dolor sit amet ".repeat(30);
	const out: string[] = [];
	let size = 0;
	for (let i = 1; size < bytes; i++) {
		const assistant = i % 2 === 0;
		const line = JSON.stringify(
			assistant
				? { type: "assistant", uuid: `a${i}`, parentUuid: `u${i - 1}`, timestamp: "2026-02-01T09:00:01.000Z", cwd: "/tmp/p", gitBranch: "main", message: { id: `m${i}`, role: "assistant", model: "m", content: [{ type: "text", text }, { type: "tool_use", id: `t${i}`, name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 1, output_tokens: 2 } } }
				: { type: "user", uuid: `u${i}`, parentUuid: i > 1 ? `a${i - 1}` : null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", gitBranch: "main", message: { role: "user", content: i > 2 ? [{ type: "tool_result", tool_use_id: `t${i - 1}`, content: text }] : text } },
		);
		out.push(line);
		size += line.length + 1;
	}
	return out;
}

async function openDb(root: string): Promise<AsyncDatabase> {
	const db = openAsyncDatabase(path.join(root, "t.db"));
	await migrate(db);
	return db;
}

describe("memory does not grow with the file", () => {
	it("imports a file many times the heap budget within a bound, and an unbatched import runs out of memory", { timeout: 240_000 }, () => {
		const { root, cleanup } = makeTempRoot("prospect-bounded-");
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			const lines = claudeTranscript(48_000_000);
			fs.writeFileSync(path.join(dir, claudeSessionFileName("big")), lines.join("\n") + "\n");
			const run = (maxLines: string, maxBytes: string, db: string) =>
				spawnSync(process.execPath, ["--import", "tsx", "--max-old-space-size=64", CHILD, path.join(root, "projects"), path.join(root, db), maxLines, maxBytes], { encoding: "utf-8", timeout: 200_000 });
			const batched = run("500", "2000000", "batched.db");
			assert.equal(batched.status, 0, batched.stderr.slice(0, 500));
			const report = JSON.parse(batched.stdout.trim().split("\n").pop()!) as { peakHeapMB: number; errors: string[]; messages: number };
			assert.deepEqual(report.errors, []);
			assert.equal(report.messages, lines.length);
			// The file is 48 MB and the heap limit 64 MB: the whole file in memory alone would not fit.
			assert.ok(report.peakHeapMB < 56, `peak heap ${report.peakHeapMB} MB`);

			const unbatched = run("1000000000", "1000000000000", "unbatched.db");
			// Out of memory, by its own signature: not a timeout, and not any other failure.
			assert.equal(unbatched.error, undefined, "the child must not time out or fail to start");
			assert.ok(unbatched.status === 134 || unbatched.signal === "SIGABRT", `exit ${unbatched.status}, signal ${unbatched.signal}`);
			assert.match(unbatched.stderr, /JavaScript heap out of memory/);
		} finally {
			cleanup();
		}
	});
});

/** Every table's rows, in a stable order, with the root made anonymous. */
async function dump(db: AsyncDatabase, root: string, skip: string[]): Promise<string> {
	const names = ((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) as Array<{ name: string }>).map((t) => t.name);
	const out: Record<string, unknown[]> = {};
	for (const n of names) if (!skip.includes(n) && !n.startsWith("messages_")) out[n] = await db.prepare(`SELECT * FROM "${n}"`).all();
	return JSON.stringify(out).split(root).join("<root>");
}

describe("the batched import gives the same rows as the whole one", () => {
	interface Shape {
		name: string;
		adapter: (root: string) => SessionSourceAdapter;
		file: (root: string) => string;
		lines: string[];
	}
	const claudeLines = claudeTranscript(30_000).slice(0, 12).concat([JSON.stringify({ type: "attachment", attachment: { type: "date", date: "2026-02-01" } }), JSON.stringify({ type: "ai-title", aiTitle: "A title" })]);
	const piLines = [sessionHeaderLine(SID), ...[1, 2, 3, 4, 5, 6, 7].map((n) => messageLine(SID, n, n % 2 ? "user" : "assistant", `turn ${n} café`, `2026-08-19T01:0${n}:00Z`)), JSON.stringify({ type: "session_info", name: "A name", timestamp: "2026-08-19T01:09:00Z" })];
	const shapes: Shape[] = [
		{ name: "Claude Code", adapter: (r) => new ClaudeFileSource(r), file: (r) => path.join(r, "-tmp-p", claudeSessionFileName("same")), lines: claudeLines },
		{ name: "Pi", adapter: (r) => new PiFileSource(r), file: (r) => path.join(r, "--tmp-p--", piSessionFileName(SID)), lines: piLines },
		{ name: "Pi subagent", adapter: (r) => new PiSubagentSource(r), file: (r) => path.join(r, "--tmp-p--", `2026-03-01T09-59-00Z_${PARENT}`, "2b83bd26", "run-0", "session.jsonl"), lines: piLines },
		{ name: "Codex", adapter: (r) => new CodexFileSource(r), file: (r) => path.join(r, "2026", "03", "04", codexRolloutFileName("same")), lines: [codexMetaLine("same"), codexMessageLine("user", "hello"), codexMessageLine("assistant", "hi")] },
	];

	for (const shape of shapes) {
		it(`${shape.name}: every table is equal, and a Claude Code export is the same transcript`, async () => {
			const results: string[] = [];
			const exports: string[] = [];
			for (const batched of [false, true]) {
				const { root, cleanup } = makeTempRoot("prospect-same-");
				const db = await openDb(root);
				try {
					const sessions = path.join(root, "sessions");
					const target = shape.file(sessions);
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.writeFileSync(target, shape.lines.join("\n") + "\n");
					fs.utimesSync(target, 1_800_000_000, 1_800_000_000);
					if (batched) setBatchLimitsForTests({ maxLines: 3, maxBytes: 400, chunkBytes: 64 });
					const result = await runSync(db, [shape.adapter(sessions)], {});
					assert.deepEqual(result.errors, []);
					// A Claude Code extras row names its sticky keys per batch, so the rows are compared through the export.
					results.push(await dump(db, root, shape.name === "Claude Code" ? ["message_extras"] : []));
					if (shape.name === "Claude Code") {
						fs.rmSync(target);
						const s = (await getExportableSession(db, "11111111-2222-4333-a444-555555555555".replace(/.*/, claudeSessionId("same"))))!;
						await exportClaudeSession(db, s, path.join(root, "out"), sessions);
						exports.push(fs.readFileSync(path.join(root, "out", "-tmp-p", claudeSessionFileName("same")), "utf-8"));
					}
				} finally {
					setBatchLimitsForTests(null);
					await db.close();
					cleanup();
				}
			}
			assert.equal(results[1], results[0]);
			if (exports.length === 2) assert.equal(exports[1], exports[0]);
		});
	}
});

/** A Claude Code adapter that fails after `after` batches, to show what a failed file leaves behind. */
class FailingAfter extends ClaudeFileSource {
	constructor(root: string, private readonly after: number) {
		super(root);
	}
	override async *readBatches(disc: DiscoveredSession, resumeLine: number): AsyncGenerator<ParsedSession> {
		let n = 0;
		for await (const b of super.readBatches(disc, resumeLine)) {
			if (n++ === this.after) throw new Error("the disk went away");
			yield b;
		}
	}
}

describe("a failed file", () => {
	it("keeps the batches it wrote, resumes from its cursor, and ends with the rows of a clean import", async () => {
		const lines = claudeTranscript(30_000).slice(0, 14);
		const rowsOf = async (db: AsyncDatabase): Promise<string> => JSON.stringify(await db.prepare("SELECT id, content_text FROM messages ORDER BY rowid").all());
		const { root, cleanup } = makeTempRoot("prospect-resume-");
		const clean = makeTempRoot("prospect-resume-clean-");
		const db = await openDb(root);
		try {
			const write = (r: string) => {
				const dir = path.join(r, "projects", "-tmp-p");
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, claudeSessionFileName("resume")), lines.join("\n") + "\n");
			};
			write(root);
			write(clean.root);
			setBatchLimitsForTests({ maxLines: 4, maxBytes: 1e9, chunkBytes: 64 });
			const failed = await runSync(db, [new FailingAfter(path.join(root, "projects"), 2)], {});
			assert.equal(failed.errors.length, 1);
			assert.deepEqual(failed.bySource["claude"]!.errors, { Error: 1 });
			const partial = (await db.prepare("SELECT last_line, last_modified FROM sessions").get()) as { last_line: number; last_modified: number };
			assert.equal(partial.last_line, 8, "the cursor is at the end of the last batch written");
			assert.equal(partial.last_modified, 0, "the file is not marked read, so the next sync picks it up");
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM messages").get()) as { n: number }).n, 8);

			const resumed = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			assert.deepEqual(resumed.errors, []);
			const cleanDb = await openDb(clean.root);
			try {
				await runSync(cleanDb, [new ClaudeFileSource(path.join(clean.root, "projects"))], {});
				assert.equal(await rowsOf(db), await rowsOf(cleanDb));
				const a = (await db.prepare("SELECT last_line, message_count FROM sessions").get()) as object;
				const b = (await cleanDb.prepare("SELECT last_line, message_count FROM sessions").get()) as object;
				assert.deepEqual(a, b);
			} finally {
				await cleanDb.close();
			}
		} finally {
			setBatchLimitsForTests(null);
			await db.close();
			cleanup();
			clean.cleanup();
		}
	});

	it("ends as a classified heap-budget error when the heap passes its budget, with what it wrote kept", async () => {
		const { root, cleanup } = makeTempRoot("prospect-budget-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, claudeSessionFileName("budget")), claudeTranscript(30_000).slice(0, 14).join("\n") + "\n");
			setBatchLimitsForTests({ maxLines: 4, maxBytes: 1e9, chunkBytes: 64 });
			const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { heapBudgetBytes: 1 });
			assert.deepEqual(result.bySource["claude"]!.errors, { "heap-budget": 1 });
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM messages").get()) as { n: number }).n, 4);
			const next = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			assert.deepEqual(next.errors, []);
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM messages").get()) as { n: number }).n, 14);
		} finally {
			setBatchLimitsForTests(null);
			await db.close();
			cleanup();
		}
	});

	it("a source that reads whole files skips one past its limit with a classified error", async () => {
		const { root, cleanup } = makeTempRoot("prospect-whole-");
		const db = await openDb(root);
		try {
			const file = path.join(root, "sessions", "2026", "03", "04", codexRolloutFileName("whole"));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, [codexMetaLine("whole"), codexMessageLine("user", "hello")].join("\n") + "\n");
			const result = await runSync(db, [new CodexFileSource(path.join(root, "sessions"))], { maxWholeFileBytes: 10 });
			assert.deepEqual(result.bySource["codex"]!.errors, { "file-too-large-for-adapter": 1 });
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM sessions").get()) as { n: number }).n, 0);
		} finally {
			await db.close();
			cleanup();
		}
	});
});

describe("state that crosses a batch boundary or a sync run", () => {
	const rec = (o: Record<string, unknown>) => JSON.stringify({ timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", ...o });
	const lines = [
		rec({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "start a background job" } }),
		rec({ type: "ai-title", aiTitle: "A background job" }),
		rec({ type: "assistant", uuid: "a2", parentUuid: "u1", message: { id: "m2", role: "assistant", model: "m", content: [{ type: "tool_use", id: "bg1", name: "Bash", input: { command: "sleep 1", run_in_background: true } }] } }),
		rec({ type: "user", uuid: "u3", parentUuid: "a2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bg1", content: "started" }] } }),
		rec({ type: "assistant", uuid: "a4", parentUuid: "u3", message: { id: "m4", role: "assistant", model: "m", content: [{ type: "text", text: "waiting" }] } }),
		// Everything above is before the cursor of the second run; the completion and a result come after it.
		rec({ type: "queue-operation", operation: "enqueue", content: "<task-notification>\n<task-id>x1</task-id>\n<tool-use-id>bg1</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>" }),
		rec({ type: "assistant", uuid: "a6", parentUuid: "a4", message: { id: "m6", role: "assistant", model: "m", content: [{ type: "tool_use", id: "t6", name: "Read", input: {} }] } }),
		rec({ type: "user", uuid: "u7", parentUuid: "a6", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bg1", content: "late result for the early call" }] } }),
	];

	for (const batchLines of [2, 3, 100]) {
		it(`a completion after the cursor is recorded, and a result names its early call, with ${batchLines} lines per batch and two runs`, async () => {
			const { root, cleanup } = makeTempRoot("prospect-cross-");
			const db = await openDb(root);
			try {
				const file = path.join(root, "projects", "-tmp-p", claudeSessionFileName("cross"));
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, lines.slice(0, 5).join("\n") + "\n");
				setBatchLimitsForTests({ maxLines: batchLines, maxBytes: 1e9, chunkBytes: 64 });
				await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
				fs.appendFileSync(file, lines.slice(5).join("\n") + "\n");
				const later = fs.statSync(file).mtimeMs / 1000 + 5;
				fs.utimesSync(file, later, later);
				const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
				assert.deepEqual(result.errors, []);
				const tasks = (await db.prepare("SELECT tool_use_id, task_id, status FROM background_tasks").all()) as Array<{ tool_use_id: string; status: string }>;
				assert.deepEqual(tasks.map((t) => [t.tool_use_id, t.status]), [["bg1", "completed"]]);
				// The result after the cursor still resolves the tool of a call made before it.
				const late = (await db.prepare("SELECT tool_results FROM messages WHERE id = 'u7'").get()) as { tool_results: string };
				assert.equal((JSON.parse(late.tool_results) as Array<{ toolName: string }>)[0]!.toolName, "bash");
				// The title written before the cursor is kept.
				assert.equal(((await db.prepare("SELECT name FROM sessions").get()) as { name: string }).name, "A background job");
			} finally {
				setBatchLimitsForTests(null);
				await db.close();
				cleanup();
			}
		});
	}
});

describe("one line limit", () => {
	it("the batched import ends a file with a line past the limit as line-too-large, keeping the batches before it", async () => {
		const { root, cleanup } = makeTempRoot("prospect-limit-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			// Normal lines are about 900 characters; the limit is 2,000, so only the long line fails.
			const lines = claudeTranscript(30_000).slice(0, 6);
			assert.ok(lines.every((l) => l.length < 1_500));
			lines.push(JSON.stringify({ type: "user", uuid: "huge", parentUuid: null, message: { role: "user", content: "y".repeat(3_000) } }));
			fs.writeFileSync(path.join(dir, claudeSessionFileName("limit")), lines.join("\n") + "\n");
			// The line limit is the whole-read reader's own; the batch reader honours it.
			setReadLimitsForTests({ wholeReadBytes: 0, chunkBytes: 64, maxLineChars: 2_000 });
			setBatchLimitsForTests({ maxLines: 2, maxBytes: 1e9, chunkBytes: 64 });
			const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			assert.deepEqual(result.bySource["claude"]!.errors, { "line-too-large": 1 });
			// The batches before the long line were written; the cursor is at the end of the last one, and the file is not marked read.
			const ids = ((await db.prepare("SELECT id FROM messages ORDER BY rowid").all()) as Array<{ id: string }>).map((m) => m.id);
			assert.deepEqual(ids, ["u1", "a2", "u3", "a4"]);
			const row = (await db.prepare("SELECT last_line, last_modified FROM sessions").get()) as { last_line: number; last_modified: number };
			assert.deepEqual(row, { last_line: 4, last_modified: 0 });
		} finally {
			setReadLimitsForTests(null);
			setBatchLimitsForTests(null);
			await db.close();
			cleanup();
		}
	});
});

describe("the run names the file it reads", () => {
	it("reports a start and a finish for each file", async () => {
		const { root, cleanup } = makeTempRoot("prospect-events-");
		const db = await openDb(root);
		try {
			const dir = path.join(root, "projects", "-tmp-p");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, claudeSessionFileName("events")), claudeTranscript(3_000).join("\n") + "\n");
			const events: FileEvent[] = [];
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { onFile: (e) => events.push(e) });
			assert.deepEqual(events.map((e) => e.phase), ["start", "finish"]);
			assert.ok(events[0]!.file.endsWith(claudeSessionFileName("events")));
			assert.equal(typeof collectBatches, "function");
		} finally {
			await db.close();
			cleanup();
		}
	});
});

describe("what belongs to the whole file survives the batch split", () => {
	const claudeRec = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: id }, ...extra });

	async function everyTable(db: AsyncDatabase, root: string): Promise<string> {
		const names = ((await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) as Array<{ name: string }>).map((t) => t.name);
		const out: Record<string, unknown[]> = {};
		for (const n of names) if (!n.startsWith("analy") && n !== "prompt_registry" && !n.startsWith("messages_")) out[n] = await db.prepare(`SELECT * FROM "${n}"`).all();
		return JSON.stringify(out).split(root).join("<root>");
	}

	it("a rebuilt transcript of three batches writes no extras, events, session field or cursor from any batch", async () => {
		const { root, cleanup } = makeTempRoot("prospect-rebuilt3-");
		const db = await openDb(root);
		try {
			const file = path.join(root, "projects", "-tmp-p", claudeSessionFileName("rebuilt3"));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, [claudeRec("a"), JSON.stringify({ type: "attachment", attachment: { type: "date", date: "2026-02-01" } })].join("\n") + "\n");
			await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			await db.exec("UPDATE sessions SET name = 'Kept'");
			const before = await everyTable(db, root);
			// A rebuild of nine records: three batches of four lines, marked on every record.
			const rebuilt = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => claudeRec(n === 1 ? "a" : `r${n}`, { restoredFrom: "pi-prospector" }));
			fs.writeFileSync(file, rebuilt.join("\n") + "\n");
			setBatchLimitsForTests({ maxLines: 4, maxBytes: 1e9, chunkBytes: 64 });
			const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], { reread: true });
			assert.deepEqual(result.errors, []);
			assert.equal(result.bySource["claude"]!.rebuiltSkipped, 1);
			const after = JSON.parse(await everyTable(db, root)) as Record<string, Array<Record<string, unknown>>>;
			const was = JSON.parse(before) as typeof after;
			for (const t of ["message_extras", "session_events", "background_tasks"]) assert.deepEqual(after[t], was[t], `${t} changed`);
			const strip = (rows: Array<Record<string, unknown>>) => rows.map(({ message_count: _m, ...r }) => r);
			assert.deepEqual(strip(after["sessions"]!), strip(was["sessions"]!), "no session field and no cursor moved");
			assert.equal(after["messages"]!.length, 9, "the messages the index lacked still insert");
		} finally {
			setBatchLimitsForTests(null);
			await db.close();
			cleanup();
		}
	});

	it("a rebuilt transcript of a session the index has not seen creates it, with no extras or events from any of its three batches", async () => {
		const { root, cleanup } = makeTempRoot("prospect-rebuilt-new-");
		const db = await openDb(root);
		try {
			const file = path.join(root, "projects", "-tmp-p", claudeSessionFileName("rebuilt-new"));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const rebuilt = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => claudeRec(`r${n}`, { restoredFrom: "pi-prospector" }));
			rebuilt.splice(4, 0, JSON.stringify({ type: "attachment", restoredFrom: "pi-prospector", attachment: { type: "date", date: "2026-02-01" } }));
			fs.writeFileSync(file, rebuilt.join("\n") + "\n");
			setBatchLimitsForTests({ maxLines: 4, maxBytes: 1e9, chunkBytes: 64 });
			const result = await runSync(db, [new ClaudeFileSource(path.join(root, "projects"))], {});
			assert.deepEqual(result.errors, []);
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM messages").get()) as { n: number }).n, 9);
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM message_extras").get()) as { n: number }).n, 0);
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM session_events").get()) as { n: number }).n, 0);
			assert.equal(((await db.prepare("SELECT COUNT(*) AS n FROM sessions").get()) as { n: number }).n, 1);
		} finally {
			setBatchLimitsForTests(null);
			await db.close();
			cleanup();
		}
	});

	it("an interrupted re-read leaves the file to be read again, and a plain sync completes it to the rows of an uninterrupted one", async () => {
		const lines = claudeTranscript(30_000).slice(0, 12);
		const build = async (interrupt: boolean): Promise<{ tables: string; cleanup: () => void }> => {
			const { root, cleanup } = makeTempRoot("prospect-reread-int-");
			const db = await openDb(root);
			try {
				const projects = path.join(root, "projects");
				const file = path.join(projects, "-tmp-p", claudeSessionFileName("int"));
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, lines.join("\n") + "\n");
				fs.utimesSync(file, 1_800_000_000, 1_800_000_000);
				// Indexed before the extras existed, so a re-read has something to add.
				await runSync(db, [new ClaudeFileSource(projects)], {});
				await db.exec("DELETE FROM message_extras; DELETE FROM session_events");
				setBatchLimitsForTests({ maxLines: 4, maxBytes: 1e9, chunkBytes: 64 });
				if (interrupt) {
					const failed = await runSync(db, [new FailingAfter(projects, 1)], { reread: true });
					assert.equal(failed.errors.length, 1);
					const row = (await db.prepare("SELECT last_line, last_modified FROM sessions").get()) as { last_line: number; last_modified: number };
					assert.ok(row.last_modified < 1_800_000_000_000, "the file is not marked current after an interrupted re-read");
					const plain = await runSync(db, [new ClaudeFileSource(projects)], {});
					assert.equal(plain.sessionsSkipped, 0, "a plain sync must not skip it");
				} else {
					await runSync(db, [new ClaudeFileSource(projects)], { reread: true });
				}
				return { tables: await everyTable(db, root), cleanup };
			} finally {
				setBatchLimitsForTests(null);
				await db.close();
			}
		};
		const clean = await build(false);
		const interrupted = await build(true);
		try {
			assert.equal(interrupted.tables, clean.tables);
		} finally {
			clean.cleanup();
			interrupted.cleanup();
		}
	});

	it("a Pi file whose first batch is all blank lines still finds its header, and a file of only blanks fails by class", async () => {
		const { root, cleanup } = makeTempRoot("prospect-pi-blank-");
		const db = await openDb(root);
		try {
			const sessions = path.join(root, "sessions");
			const good = path.join(sessions, "--tmp-p--", piSessionFileName(SID));
			const empty = path.join(sessions, "--tmp-p--", piSessionFileName("22222222-2222-4333-a444-555555555555"));
			fs.mkdirSync(path.dirname(good), { recursive: true });
			fs.writeFileSync(good, ["", "", "", "", "", sessionHeaderLine(SID), messageLine(SID, 1, "user", "hi", "2026-08-19T01:03:00Z"), messageLine(SID, 2, "assistant", "there", "2026-08-19T01:04:00Z")].join("\n") + "\n");
			fs.writeFileSync(empty, "\n\n\n\n\n\n");
			setBatchLimitsForTests({ maxLines: 2, maxBytes: 1e9, chunkBytes: 64 });
			const result = await runSync(db, [new PiFileSource(sessions)], {});
			const pi = result.bySource["pi"]!;
			assert.deepEqual(pi.errors, { "no-session-header": 1 });
			assert.equal(pi.messagesAdded, 2);
			assert.equal(pi.sessionsAdded, 1);
			assert.equal(result.forksResolved, 0);
		} finally {
			setBatchLimitsForTests(null);
			await db.close();
			cleanup();
		}
	});
});
