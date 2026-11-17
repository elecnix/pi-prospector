/**
 * The extras a Claude Code sync stores and the export that rebuilds a transcript from them (#400).
 *
 * Every transcript here is invented. Nothing reads a real session or the real database.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { runSync } from "../../src/sync/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude/index.js";
import { exportClaudeSession, getExportableSession, insideOut, listMissingClaudeSessions, relPathUnderRoot } from "../../src/sync/claude-export.js";
import { rebuildClaudeRecords, type StoredMessage } from "../../src/sync/claude-rebuild.js";
import { parseClaudeLine } from "../../src/sync/parser.js";
import { claudeSessionFileName, claudeSessionId, fixtureUuid, mockFramework } from "./helpers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { prospectExportSession } from "../../src/commands/export-session.js";

interface Env {
	db: AsyncDatabase;
	root: string;
	out: string;
	dir: string;
	cleanup: () => Promise<void>;
}

async function setup(): Promise<Env> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-raw-"));
	const db = openAsyncDatabase(path.join(dir, "test.db"));
	await migrate(db);
	const root = path.join(dir, "projects");
	fs.mkdirSync(root, { recursive: true });
	return { db, root, out: path.join(dir, "restored"), dir, cleanup: async () => { await db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const PROJECT = "-tmp-sample-project";

/** A session holding every record type the issue lists, in a deliberately awkward order. */
function richLines(label: string): string[] {
	const sid = claudeSessionId(label);
	return [
		JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: sid }),
		JSON.stringify({ type: "file-history-snapshot", messageId: "m0", snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false }),
		JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/sample", gitBranch: "main", version: "9.9.9", message: { role: "user", content: "Add a retry to the fetch helper" } }),
		JSON.stringify({ type: "user", uuid: "u1m", parentUuid: "u1", isMeta: true, timestamp: "2026-02-01T09:00:01.000Z", message: { role: "user", content: "<command-caveat>Caveat: generated</command-caveat>" } }),
		JSON.stringify({ type: "system", subtype: "info", content: "hook ran", timestamp: "2026-02-01T09:00:02.000Z" }),
		JSON.stringify({
			type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-02-01T09:00:05.000Z", requestId: "req_1",
			message: {
				id: "msg_1", type: "message", role: "assistant", model: "model-x", stop_reason: "tool_use",
				content: [
					{ type: "thinking", thinking: "Look at the helper first", signature: "c2lnbmF0dXJl" },
					{ type: "text", text: "Reading the file." },
					{ type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "/tmp/sample/fetch.ts" } },
					{ type: "tool_use", id: "toolu_02", name: "Bash", input: { command: "ls" } },
				],
				usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, service_tier: "standard" },
			},
		}),
		"this line is not json at all",
		JSON.stringify({
			type: "user", uuid: "u2", parentUuid: "a1", timestamp: "2026-02-01T09:00:06.000Z", toolUseResult: { ok: true },
			message: { role: "user", content: [
				{ type: "tool_result", tool_use_id: "toolu_01", content: "export const f = 1;" },
				{ type: "tool_result", tool_use_id: "toolu_02", content: [{ type: "text", text: "fetch.ts\nREADME" }], is_error: false },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
			] },
		}),
		JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-02-01T09:00:07.000Z", content: "later" }),
		JSON.stringify({ type: "attachment", attachment: { type: "diagnostics", files: [] } }),
		JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-02-01T09:00:09.000Z", message: { id: "msg_2", role: "assistant", model: "model-x", stop_reason: "end_turn", content: [{ type: "text", text: "Done: häppy ünïcode ✓ 😀" }], usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
		JSON.stringify({ type: "ai-title", aiTitle: "Add retry to the fetch helper", sessionId: sid }),
		JSON.stringify({ type: "pr-link", prNumber: 12, prUrl: "https://example.invalid/pr/12", prRepository: "example/repo" }),
		JSON.stringify({ type: "last-prompt", leafUuid: "a2", sessionId: sid }),
	];
}

function sessionPath(env: Env, label: string): string {
	return path.join(env.root, PROJECT, claudeSessionFileName(label));
}

function write(file: string, content: string | Buffer): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function bump(file: string): void {
	// A strictly later modification time, so the sync reads the file again.
	const t = fs.statSync(file).mtimeMs / 1000 + 5;
	fs.utimesSync(file, t, t);
}

async function sync(env: Env, opts: { reread?: boolean } = {}) {
	return runSync(env.db, [new ClaudeFileSource(env.root)], opts);
}

/** A database as it was before the extras existed: the messages are there, the extras are not. */
async function syncOld(env: Env) {
	const result = await sync(env);
	await env.db.exec("DELETE FROM message_extras; DELETE FROM session_events;");
	return result;
}

/** Every row the sync writes for the index, minus the columns that only record the sync itself. */
async function snapshot(db: AsyncDatabase): Promise<string> {
	const sessions = await db.prepare("SELECT id, file_path, project, cwd, name, started_at, message_count FROM sessions ORDER BY id").all();
	const messages = await db.prepare("SELECT rowid, * FROM messages ORDER BY rowid").all();
	const nodes = await db.prepare("SELECT * FROM analysis_nodes ORDER BY id").all();
	return JSON.stringify({ sessions, messages, nodes });
}

async function extrasSnapshot(db: AsyncDatabase): Promise<string> {
	return JSON.stringify({
		extras: await db.prepare("SELECT * FROM message_extras ORDER BY message_id").all(),
		events: await db.prepare("SELECT * FROM session_events ORDER BY session_id, line").all(),
	});
}

/** The lines of a transcript as objects, without the provenance mark a rebuilt record carries. */
function linesOf(file: string): unknown[] {
	return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l !== "").map((l) => {
		try {
			const o = JSON.parse(l) as Record<string, unknown>;
			delete o["restoredFrom"];
			return o;
		} catch {
			return l;
		}
	});
}


describe("session extras", () => {
	it("rebuilds a deleted session line for line, including records the sync does not turn into messages", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "round-trip");
			const lines = richLines("round-trip");
			write(file, lines.join("\n") + "\n");
			const result = await sync(env);
			assert.equal(result.errors.length, 0, result.errors.join("; "));
			const original = linesOf(file);
			fs.rmSync(file);

			const s = (await getExportableSession(env.db, claudeSessionId("round-trip")))!;
			const outcome = await exportClaudeSession(env.db, s, env.out, env.root);
			assert.equal(outcome.kind, "rebuilt");
			if (outcome.kind === "rebuilt") {
				assert.equal(outcome.fromProjection, 0);
				assert.equal(outcome.omittedStrings, 0);
			}
			assert.deepEqual(linesOf(path.join(env.out, PROJECT, claudeSessionFileName("round-trip"))), original);
		} finally {
			await env.cleanup();
		}
	});

	it("keeps the shape of a record the columns cannot: block order, tool-name casing, usage extras and fields that change", async () => {
		const env = await setup();
		try {
			write(sessionPath(env, "shape"), richLines("shape").join("\n") + "\n");
			await sync(env);
			const row = (await env.db.prepare("SELECT extras FROM message_extras WHERE message_id = 'a1'").get()) as { extras: string };
			const x = JSON.parse(row.extras) as { b: Array<{ t: string; x?: Record<string, unknown> }>; f?: Record<string, unknown> };
			assert.deepEqual(x.b.map((b) => b.t), ["thinking", "text", "tool_use", "tool_use"]);
			assert.equal(x.f?.["usage.service_tier"], "standard");
			assert.equal(x.f?.["requestId"], "req_1");
			assert.equal(x.f?.["message.type"], "message");
			// Values a column holds are not stored again.
			assert.equal(JSON.stringify(x).includes("Reading the file."), false);
			assert.equal(JSON.stringify(x).includes("export const f"), false);
		} finally {
			await env.cleanup();
		}
	});

	it("writes a field that repeats from record to record once, and one that differs every time on every record", async () => {
		const env = await setup();
		try {
			const lines = [1, 2, 3, 4, 5].map((n) => JSON.stringify({ type: "user", uuid: `u${n}`, parentUuid: n === 1 ? null : `u${n - 1}`, timestamp: "2026-02-01T09:00:00.000Z", gitBranch: "main", version: "9.9.9", promptId: `p${n}`, message: { role: "user", content: `hi ${n}` } }));
			const file = sessionPath(env, "sticky");
			write(file, lines.join("\n") + "\n");
			await sync(env);
			const rows = (await env.db.prepare("SELECT extras FROM message_extras ORDER BY line").all()) as Array<{ extras: string }>;
			const f = rows.map((r) => (JSON.parse(r.extras) as { f?: Record<string, unknown> }).f ?? {});
			assert.equal(f[0]!["gitBranch"], "main");
			for (const later of f.slice(1)) assert.equal("gitBranch" in later, false);
			f.forEach((fields, i) => assert.equal(fields["promptId"], `p${i + 1}`));
			const original = linesOf(file);
			fs.rmSync(file);
			await exportClaudeSession(env.db, (await getExportableSession(env.db, claudeSessionId("sticky")))!, env.out, env.root);
			assert.deepEqual(linesOf(path.join(env.out, PROJECT, claudeSessionFileName("sticky"))), original);
		} finally {
			await env.cleanup();
		}
	});

	it("stores a string over the limit as its size and hash, and the export says it could not restore it", async () => {
		const env = await setup();
		try {
			const big = "A".repeat(5000);
			const lines = [
				JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/sample", message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: big } }] } }),
				JSON.stringify({ type: "attachment", attachment: { type: "file", content: big } }),
			];
			const file = sessionPath(env, "heavy");
			write(file, lines.join("\n") + "\n");
			await sync(env);
			const stored = (await env.db.prepare("SELECT extras FROM message_extras").get()) as { extras: string };
			assert.equal(stored.extras.includes(big), false);
			assert.match(stored.extras, /\$omitted/);
			assert.ok(stored.extras.length < 400);
			fs.rmSync(file);
			const outcome = await exportClaudeSession(env.db, (await getExportableSession(env.db, claudeSessionId("heavy")))!, env.out, env.root);
			assert.equal(outcome.kind === "rebuilt" && outcome.omittedStrings, 2);
			const out = path.join(env.out, PROJECT, claudeSessionFileName("heavy"));
			assert.equal(fs.readFileSync(out, "utf-8").includes(big), false);
			const report = JSON.parse(fs.readFileSync(out.replace(/\.jsonl$/, ".restore.json"), "utf-8")) as { omittedStrings: { count: number; bytes: number } };
			assert.equal(report.omittedStrings.count, 2);
			assert.ok(report.omittedStrings.bytes >= 10000 && report.omittedStrings.bytes < 10300);
		} finally {
			await env.cleanup();
		}
	});

	it("adds only the new lines of a growing file, and a record never changes once stored", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "growth");
			const lines = richLines("growth");
			write(file, lines.slice(0, 6).join("\n") + "\n");
			await sync(env);
			const first = await extrasSnapshot(env.db);
			const again = await sync(env);
			assert.equal(again.sessionsProcessed, 0);
			assert.equal(await extrasSnapshot(env.db), first);

			fs.appendFileSync(file, lines.slice(6).join("\n") + "\n");
			bump(file);
			await sync(env);
			const original = linesOf(file);
			fs.rmSync(file);
			await exportClaudeSession(env.db, (await getExportableSession(env.db, claudeSessionId("growth")))!, env.out, env.root);
			assert.deepEqual(linesOf(path.join(env.out, PROJECT, claudeSessionFileName("growth"))), original);
		} finally {
			await env.cleanup();
		}
	});

	it("stores a child agent's meta file as a session event and replaces it when it changes", async () => {
		const env = await setup();
		try {
			const parent = claudeSessionId("parent-session");
			const dir = path.join(env.root, PROJECT, parent, "subagents");
			const agentFile = path.join(dir, "agent-a1b2c3.jsonl");
			write(agentFile, richLines("agent").join("\n") + "\n");
			write(path.join(dir, "agent-a1b2c3.meta.json"), '{"agentType":"explore","description":"find the retry helper"}\n');
			await sync(env);
			const row = (await env.db.prepare("SELECT kind, ref, payload FROM session_events WHERE session_id = 'agent-a1b2c3' AND line = -1").get()) as { kind: string; ref: string; payload: string };
			assert.equal(row.kind, "sidecar");
			assert.equal(row.ref, `${PROJECT}/${parent}/subagents/agent-a1b2c3.meta.json`);
			write(path.join(dir, "agent-a1b2c3.meta.json"), '{"agentType":"plan"}\n');
			bump(agentFile);
			await sync(env);
			assert.equal(((await env.db.prepare("SELECT COUNT(*) AS n FROM session_events WHERE line = -1").get()) as { n: number }).n, 1);
			fs.rmSync(path.join(env.root, PROJECT, parent), { recursive: true });
			await exportClaudeSession(env.db, (await getExportableSession(env.db, "agent-a1b2c3"))!, env.out, env.root);
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.out, PROJECT, parent, "subagents", "agent-a1b2c3.meta.json"), "utf-8")), { agentType: "plan" });
		} finally {
			await env.cleanup();
		}
	});

	it("gains extras for an already indexed session on --reread, and no existing row changes", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "backfill");
			write(file, richLines("backfill").join("\n") + "\n");
			await syncOld(env);
			const before = await snapshot(env.db);
			const skipped = await sync(env);
			assert.equal(skipped.sessionsProcessed, 0, "an unchanged file is not read again");
			assert.equal(await extrasSnapshot(env.db), JSON.stringify({ extras: [], events: [] }));

			const reread = await sync(env, { reread: true });
			assert.equal(reread.sessionsProcessed, 1);
			assert.equal(await snapshot(env.db), before);
			assert.ok((JSON.parse(await extrasSnapshot(env.db)) as { extras: unknown[] }).extras.length > 0);
			// A second reread adds nothing.
			const stored = await extrasSnapshot(env.db);
			await sync(env, { reread: true });
			assert.equal(await extrasSnapshot(env.db), stored);
		} finally {
			await env.cleanup();
		}
	});

	it("adds the tables to an existing database without touching a row", async () => {
		const env = await setup();
		try {
			write(sessionPath(env, "migrate"), richLines("migrate").join("\n") + "\n");
			await syncOld(env);
			await env.db.exec("DROP TABLE message_extras; DROP TABLE session_events;");
			const before = await snapshot(env.db);
			await migrate(env.db);
			await migrate(env.db);
			assert.equal(await snapshot(env.db), before);
			assert.equal(await extrasSnapshot(env.db), JSON.stringify({ extras: [], events: [] }));
		} finally {
			await env.cleanup();
		}
	});

	it("names no harness in its tables or columns", async () => {
		const env = await setup();
		try {
			const rows = (await env.db.prepare("SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.name IN ('message_extras', 'session_events')").all()) as Array<{ t: string; c: string }>;
			assert.ok(rows.length >= 7);
			for (const r of rows) assert.doesNotMatch(`${r.t} ${r.c}`, /claude|pi|codex|cline|opencode/i);
		} finally {
			await env.cleanup();
		}
	});

	it("stores a tool call's id and the title written after the first cwd", async () => {
		const env = await setup();
		try {
			write(sessionPath(env, "ids"), richLines("ids").join("\n") + "\n");
			await sync(env);
			const row = (await env.db.prepare("SELECT tool_calls FROM messages WHERE id = 'a1'").get()) as { tool_calls: string };
			assert.deepEqual((JSON.parse(row.tool_calls) as Array<{ id: string }>).map((c) => c.id), ["toolu_01", "toolu_02"]);
			const s = (await env.db.prepare("SELECT name FROM sessions WHERE id = ?").get(claudeSessionId("ids"))) as { name: string };
			assert.equal(s.name, "Add retry to the fetch helper");
		} finally {
			await env.cleanup();
		}
	});
});

describe("rebuild from the reduced projection", () => {
	async function syncedWithoutRaw(env: Env, label: string) {
		const file = sessionPath(env, label);
		write(file, richLines(label).join("\n") + "\n");
		await syncOld(env);
		return file;
	}

	async function storedMessages(env: Env, id: string): Promise<StoredMessage[]> {
		return (await env.db
			.prepare("SELECT id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, usage, model, provider_message_id, stop_reason, error_message FROM messages WHERE session_id = ? ORDER BY rowid")
			.all(id)) as StoredMessage[];
	}

	it("writes records that the parser reads back into the stored rows", async () => {
		const env = await setup();
		try {
			await syncedWithoutRaw(env, "reparse");
			const id = claudeSessionId("reparse");
			const s = (await getExportableSession(env.db, id))!;
			const stored = await storedMessages(env, id);
			const { records } = rebuildClaudeRecords(s, stored, `${PROJECT}/${claudeSessionFileName("reparse")}`);
			const names = new Map<string, string>();
			for (const r of records) {
				const content = (r["message"] as { content?: unknown } | undefined)?.content;
				if (Array.isArray(content)) for (const b of content) if (b?.type === "tool_use") names.set(b.id, String(b.name).toLowerCase());
			}
			const reparsed = records.map((r) => parseClaudeLine(JSON.stringify(r), names)).filter((p) => p?.kind === "message");
			assert.equal(reparsed.length, stored.length);
			reparsed.forEach((p, i) => {
				const e = p!.kind === "message" ? p!.entry : null;
				const m = stored[i]!;
				assert.equal(e!.id, m.id);
				assert.equal(e!.parentId, m.parent_id);
				assert.equal(e!.text, m.content_text);
				assert.equal(e!.thinking, m.content_thinking);
				assert.equal(e!.tool_calls ? JSON.stringify(e!.tool_calls) : null, m.tool_calls);
				assert.equal(e!.tool_results ? JSON.stringify(e!.tool_results) : null, m.tool_results);
				assert.equal(e!.usage ? JSON.stringify(e!.usage) : null, m.usage);
				assert.equal(e!.model, m.model);
				assert.equal(e!.providerMessageId, m.provider_message_id);
				assert.equal(e!.stopReason, m.stop_reason);
			});
			assert.ok(records.every((r) => r["restoredFrom"] === "pi-prospector"));
		} finally {
			await env.cleanup();
		}
	});

	it("infers the id of a call a row stored without one, and says so", async () => {
		const stored: StoredMessage[] = [
			{ id: "a", parent_id: null, timestamp: null, role: "assistant", content_text: null, content_thinking: null, tool_calls: JSON.stringify([{ name: "read", arguments: { file_path: "/x" } }]), tool_results: null, usage: null, model: null, provider_message_id: null, stop_reason: null, error_message: null },
			{ id: "b", parent_id: "a", timestamp: null, role: "toolResult", content_text: "ok", content_thinking: null, tool_calls: null, tool_results: JSON.stringify([{ toolCallId: "toolu_x", toolName: "read", isError: false, textLength: 2 }]), usage: null, model: null, provider_message_id: null, stop_reason: null, error_message: null },
		];
		const { records, notes } = rebuildClaudeRecords({ id: "s", cwd: "/tmp", name: null }, stored, "p/s.jsonl");
		assert.equal(notes["tool_use_id_inferred"], 1);
		const block = ((records[0]!["message"] as { content: Array<Record<string, unknown>> }).content)[0]!;
		assert.equal(block["id"], "toolu_x");
		assert.equal(block["name"], "Read");
	});

	it("exports a pre-capture session with a restore report, and re-importing it changes no row", async () => {
		const env = await setup();
		try {
			const file = await syncedWithoutRaw(env, "restore-in-place");
			const id = claudeSessionId("restore-in-place");
			// An analysis node over the session, so the test can see one go stale.
			const fw = mockFramework(env.db as never);
			await fw.register(turnPairCoreAnalyzer);
			assert.equal((await fw.run(id, {})).errors.length, 0);
			const before = await snapshot(env.db);
			assert.ok(JSON.parse(before).nodes.length > 0, "expected analysis nodes to protect");
			fs.rmSync(file);

			const missing = await listMissingClaudeSessions(env.db);
			assert.deepEqual(missing.map((m) => m.id), [id]);
			// Restore into the sessions root itself: the strictest test of re-import.
			const outcome = await exportClaudeSession(env.db, missing[0]!, env.root, env.root);
			assert.equal(outcome.kind, "rebuilt");
			const report = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, ".restore.json"), "utf-8")) as { notRestored: string[]; restoredFrom: string };
			assert.equal(report.restoredFrom, "pi-prospector");
			assert.ok(report.notRestored.length > 0);

			// 1. The file's modification time is not newer than the stored one: nothing is read.
			const skipped = await sync(env);
			assert.equal(skipped.sessionsProcessed, 0);
			assert.equal(await snapshot(env.db), before);

			// 2. Forced newer, the file is parsed again; every message row is kept as it was.
			bump(file);
			const reread = await sync(env);
			assert.equal(reread.sessionsProcessed, 1);
			const after = JSON.parse(await snapshot(env.db)) as { sessions: unknown; messages: unknown; nodes: unknown };
			const was = JSON.parse(before) as typeof after;
			assert.deepEqual(after.messages, was.messages);
			assert.deepEqual(after.nodes, was.nodes);
			assert.deepEqual(after.sessions, was.sessions);
			// No analysis unit became stale or missing.
			const units = await fw.scan(id);
			assert.deepEqual([...new Set(units.map((u) => u.status))], ["current"]);
		} finally {
			await env.cleanup();
		}
	});

	it("skips a file that already exists in the output directory", async () => {
		const env = await setup();
		try {
			const file = await syncedWithoutRaw(env, "no-overwrite");
			fs.rmSync(file);
			const s = (await getExportableSession(env.db, claudeSessionId("no-overwrite")))!;
			assert.equal((await exportClaudeSession(env.db, s, env.out, env.root)).kind, "rebuilt");
			assert.equal((await exportClaudeSession(env.db, s, env.out, env.root)).kind, "skipped");
		} finally {
			await env.cleanup();
		}
	});
});

describe("prospect export-session", () => {
	it("restores every session whose file is gone and leaves the others alone", async () => {
		const env = await setup();
		let dbClosed = false;
		const saved = { db: process.env["PROSPECTOR_DB_PATH"], root: process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] };
		try {
			const gone = sessionPath(env, "gone");
			const kept = sessionPath(env, "kept");
			const original = Buffer.from(richLines("gone").join("\n") + "\n");
			write(gone, original);
			const originalLines = linesOf(gone);
			write(kept, richLines("kept").join("\n") + "\n");
			await sync(env);
			fs.rmSync(gone);
			await env.db.close();
			dbClosed = true;

			process.env["PROSPECTOR_DB_PATH"] = path.join(env.dir, "test.db");
			process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = env.root;
			const notes: string[] = [];
			const ctx = { ui: { notify: (m: string) => notes.push(m) }, cwd: env.dir, hasUI: false } as never;
			await prospectExportSession(`--all-missing --out ${env.out}`, ctx);
			assert.match(notes.join("\n"), /Rebuilt:\s+1 sessions/);
			assert.deepEqual(linesOf(path.join(env.out, PROJECT, claudeSessionFileName("gone"))), originalLines);
			assert.equal(fs.existsSync(path.join(env.out, PROJECT, claudeSessionFileName("kept"))), false);

			notes.length = 0;
			await prospectExportSession("", ctx);
			assert.match(notes.join("\n"), /Usage: prospect export-session/);
			notes.length = 0;
			await prospectExportSession(`--session ${fixtureUuid("unknown")} --out ${env.out}`, ctx);
			assert.match(notes.join("\n"), /No Claude Code session/);
		} finally {
			if (saved.db === undefined) delete process.env["PROSPECTOR_DB_PATH"]; else process.env["PROSPECTOR_DB_PATH"] = saved.db;
			if (saved.root === undefined) delete process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"]; else process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = saved.root;
			if (!dbClosed) await env.db.close();
			fs.rmSync(env.dir, { recursive: true, force: true });
		}
	});
});

describe("rebuild of a user record with text around its tool results", () => {
	it("parses back into the stored text and results when text comes before, between and after them", () => {
		const original = {
			type: "user", uuid: "u9", parentUuid: "a9", timestamp: "2026-02-01T09:10:00.000Z",
			message: { role: "user", content: [
				{ type: "text", text: "before" },
				{ type: "tool_result", tool_use_id: "toolu_a", content: "first result" },
				{ type: "text", text: "between the two" },
				{ type: "tool_result", tool_use_id: "toolu_b", content: "second" },
				{ type: "text", text: "after" },
			] },
		};
		const names = new Map([["toolu_a", "read"], ["toolu_b", "bash"]]);
		const parsed = parseClaudeLine(JSON.stringify(original), names);
		assert.ok(parsed && parsed.kind === "message");
		const e = parsed.entry;
		const stored: StoredMessage = {
			id: e.id, parent_id: e.parentId, timestamp: e.timestamp, role: e.role, content_text: e.text, content_thinking: null,
			tool_calls: null, tool_results: JSON.stringify(e.tool_results), usage: null, model: null, provider_message_id: null, stop_reason: null, error_message: null,
		};
		const { records } = rebuildClaudeRecords({ id: "s", cwd: "/tmp", name: null }, [stored], "p/s.jsonl");
		const again = parseClaudeLine(JSON.stringify(records[0]), names);
		assert.ok(again && again.kind === "message");
		assert.equal(again.entry.text, e.text);
		assert.deepEqual(again.entry.tool_results, e.tool_results);
	});
});

describe("relative paths under the sessions root", () => {
	it("keeps a directory whose name starts with two dots inside the root", () => {
		const root = path.join(os.tmpdir(), "prospect-root");
		assert.equal(relPathUnderRoot(root, path.join(root, "..cache", "s.jsonl"), "proj"), "..cache/s.jsonl");
		assert.equal(relPathUnderRoot(root, path.join(os.tmpdir(), "elsewhere", "s.jsonl"), "proj"), "proj/s.jsonl");
	});
});

describe("rebuild with an empty tool result", () => {
	it("parses back into the stored text and results when a zero-length result sits between two others", () => {
		const original = {
			type: "user", uuid: "u7", parentUuid: "a7", timestamp: "2026-02-01T09:20:00.000Z",
			message: { role: "user", content: [
				{ type: "tool_result", tool_use_id: "toolu_a", content: "abc" },
				{ type: "tool_result", tool_use_id: "toolu_b", content: "" },
				{ type: "tool_result", tool_use_id: "toolu_c", content: "defg" },
			] },
		};
		const names = new Map([["toolu_a", "read"], ["toolu_b", "bash"], ["toolu_c", "grep"]]);
		const parsed = parseClaudeLine(JSON.stringify(original), names);
		assert.ok(parsed && parsed.kind === "message");
		const e = parsed.entry;
		assert.equal(e.text, "abc\ndefg");
		const stored: StoredMessage = {
			id: e.id, parent_id: e.parentId, timestamp: e.timestamp, role: e.role, content_text: e.text, content_thinking: null,
			tool_calls: null, tool_results: JSON.stringify(e.tool_results), usage: null, model: null, provider_message_id: null, stop_reason: null, error_message: null,
		};
		const { records, notes } = rebuildClaudeRecords({ id: "s", cwd: "/tmp", name: null }, [stored], "p/s.jsonl");
		assert.equal(notes["tool_result_layout_unrecoverable"], undefined);
		const again = parseClaudeLine(JSON.stringify(records[0]), names);
		assert.ok(again && again.kind === "message");
		assert.equal(again.entry.text, e.text);
		assert.deepEqual(again.entry.tool_results, e.tool_results);
	});
});

describe("rebuild of a synced user record with empty tool results", () => {
	const ids = ["toolu_a", "toolu_b", "toolu_c"];
	const use = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });
	const shapes: Record<string, unknown[]> = {
		"an empty string in the middle": [
			{ type: "tool_result", tool_use_id: "toolu_a", content: "a" },
			{ type: "tool_result", tool_use_id: "toolu_b", content: "" },
			{ type: "tool_result", tool_use_id: "toolu_c", content: "b" },
		],
		"an empty content array in the middle": [
			{ type: "tool_result", tool_use_id: "toolu_a", content: "a" },
			{ type: "tool_result", tool_use_id: "toolu_b", content: [] },
			{ type: "tool_result", tool_use_id: "toolu_c", content: "b" },
		],
		"empty first and last": [
			{ type: "tool_result", tool_use_id: "toolu_a", content: "" },
			{ type: "tool_result", tool_use_id: "toolu_b", content: "mid" },
			{ type: "tool_result", tool_use_id: "toolu_c", content: [] },
		],
		"an empty text block beside an empty result": [
			{ type: "tool_result", tool_use_id: "toolu_a", content: "a" },
			{ type: "tool_result", tool_use_id: "toolu_b", content: "" },
			{ type: "text", text: "" },
			{ type: "tool_result", tool_use_id: "toolu_c", content: "b" },
		],
		"text around an empty result": [
			{ type: "text", text: "before" },
			{ type: "tool_result", tool_use_id: "toolu_a", content: "a" },
			{ type: "tool_result", tool_use_id: "toolu_b", content: "" },
			{ type: "text", text: "after" },
			{ type: "tool_result", tool_use_id: "toolu_c", content: "b" },
		],
	};

	for (const [label, content] of Object.entries(shapes)) {
		it(`rebuilds into the stored row from a real sync: ${label}`, async () => {
			const env = await setup();
			try {
				const name = label.replace(/\W+/g, "-");
				const lines = [
					JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/sample", message: { role: "user", content: "go" } }),
					JSON.stringify({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-02-01T09:00:01.000Z", message: { id: "m1", role: "assistant", model: "m", content: [use(ids[0]!, "Read"), use(ids[1]!, "Bash"), use(ids[2]!, "Grep")] } }),
					JSON.stringify({ type: "user", uuid: "u2", parentUuid: "a1", timestamp: "2026-02-01T09:00:02.000Z", message: { role: "user", content } }),
				];
				write(sessionPath(env, name), lines.join("\n") + "\n");
				await syncOld(env);
				const id = claudeSessionId(name);
				const stored = (await env.db
					.prepare("SELECT id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, usage, model, provider_message_id, stop_reason, error_message FROM messages WHERE session_id = ? ORDER BY rowid")
					.all(id)) as StoredMessage[];
				const row = stored.find((m) => m.id === "u2")!;
				const { records, notes } = rebuildClaudeRecords({ id, cwd: "/tmp/sample", name: null }, stored, `${PROJECT}/${name}.jsonl`);
				assert.equal(notes["tool_result_layout_unrecoverable"], undefined);
				const names = new Map([["toolu_a", "read"], ["toolu_b", "bash"], ["toolu_c", "grep"]]);
				const rec = records.find((r) => r["uuid"] === "u2")!;
				const again = parseClaudeLine(JSON.stringify(rec), names);
				assert.ok(again && again.kind === "message");
				assert.equal(again.entry.text, row.content_text);
				assert.deepEqual(again.entry.tool_results, JSON.parse(row.tool_results!));
			} finally {
				await env.cleanup();
			}
		});
	}
});

describe("rebuild of stored rows with empty results next to an empty text part", () => {
	const cases: Array<[string, string, number[]]> = [
		["abc, empty text part, defg with results of length 3, 0 and 4", "abc\n\ndefg", [3, 0, 4]],
		["a, empty text part, b with results of length 1, 0 and 1", "a\n\nb", [1, 0, 1]],
		["a then a trailing empty text part with results of length 1 and 0", "a\n", [1, 0]],
	];
	for (const [label, text, lengths] of cases) {
		it(`parses back into the stored row: ${label}`, () => {
			const results = lengths.map((textLength, i) => ({ toolCallId: `toolu_${i}`, toolName: "read", isError: false, textLength }));
			const stored: StoredMessage = {
				id: "u", parent_id: null, timestamp: null, role: "toolResult", content_text: text, content_thinking: null,
				tool_calls: null, tool_results: JSON.stringify(results), usage: null, model: null, provider_message_id: null, stop_reason: null, error_message: null,
			};
			const { records, notes } = rebuildClaudeRecords({ id: "s", cwd: "/tmp", name: null }, [stored], "p/s.jsonl");
			assert.equal(notes["tool_result_layout_unrecoverable"], undefined);
			const names = new Map(results.map((r) => [r.toolCallId, "read"]));
			const again = parseClaudeLine(JSON.stringify(records[0]), names);
			assert.ok(again && again.kind === "message");
			assert.equal(again.entry.text, text);
			assert.deepEqual(again.entry.tool_results?.map((r) => r.textLength), lengths);
		});
	}
});

describe("export never replaces a file that appears mid-export", () => {
	for (const raw of [true, false]) {
		it(`leaves a file created after the early check untouched (${raw ? "original bytes" : "rebuild"})`, async () => {
			const env = await setup();
			try {
				const label = raw ? "race-raw" : "race-rebuilt";
				const file = sessionPath(env, label);
				write(file, richLines(label).join("\n") + "\n");
				if (raw) await sync(env); else await syncOld(env);
				fs.rmSync(file);
				const s = (await getExportableSession(env.db, claudeSessionId(label)))!;
				const target = path.join(env.out, PROJECT, claudeSessionFileName(label));
				const live = Buffer.from("a live session Claude Code is writing\n");
				const outcome = await exportClaudeSession(env.db, s, env.out, env.root, {
					beforeCommit: async (t) => { fs.writeFileSync(t, live); },
				});
				assert.equal(outcome.kind, "skipped");
				assert.ok(fs.readFileSync(target).equals(live), "the file created mid-export was overwritten");
				assert.deepEqual(fs.readdirSync(path.dirname(target)).filter((n) => n.includes(".tmp-")), []);
			} finally {
				await env.cleanup();
			}
		});
	}
});

describe("export path containment", () => {
	it("accepts a filesystem root as the output directory", () => {
		assert.equal(insideOut(path.parse(process.cwd()).root, "tmp/a.jsonl"), path.join(path.parse(process.cwd()).root, "tmp", "a.jsonl"));
	});

	it("refuses a stored path that climbs out of the output directory", async () => {
		const env = await setup();
		try {
			write(sessionPath(env, "contain"), richLines("contain").join("\n") + "\n");
			await sync(env);
			const s = (await getExportableSession(env.db, claudeSessionId("contain")))!;
			// A stored sidecar path that climbs out of the output directory.
			await env.db.prepare("INSERT INTO session_events (session_id, line, kind, ref, payload) VALUES (?, -1, 'sidecar', '../escape.json', '{}')").run(s.id);
			await assert.rejects(exportClaudeSession(env.db, s, env.out, env.root), /leaves the output directory/);
			assert.equal(fs.existsSync(path.join(env.dir, "escape.jsonl")), false);
		} finally {
			await env.cleanup();
		}
	});
});

describe("a file that grows between syncs", () => {
	const user = (id: string) => JSON.stringify({ type: "user", uuid: id, timestamp: "2026-02-01T09:00:00.000Z", message: { role: "user", content: id } });

	it("waits for a line the host has half written and reads it once it is whole", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "partial");
			const second = user("b");
			write(file, user("a") + "\n" + second.slice(0, 20));
			await sync(env);
			assert.deepEqual(((await env.db.prepare("SELECT id FROM messages").all()) as Array<{ id: string }>).map((r) => r.id), ["a"]);
			assert.equal(((await env.db.prepare("SELECT COUNT(*) AS n FROM session_events").get()) as { n: number }).n, 0, "a half-written line is not an event");
			fs.appendFileSync(file, second.slice(20) + "\n");
			bump(file);
			await sync(env);
			assert.deepEqual(((await env.db.prepare("SELECT id FROM messages ORDER BY rowid").all()) as Array<{ id: string }>).map((r) => r.id), ["a", "b"]);
		} finally {
			await env.cleanup();
		}
	});
});
