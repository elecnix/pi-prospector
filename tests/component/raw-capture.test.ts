/**
 * Lossless capture of Claude Code sessions and the export that writes them back (#400).
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
import { exportClaudeSession, getExportableSession, insideOut, listMissingClaudeSessions } from "../../src/sync/claude-export.js";
import { rebuildClaudeRecords, type StoredMessage } from "../../src/sync/claude-rebuild.js";
import { parseClaudeLine } from "../../src/sync/parser.js";
import { getRawChunks, getRawFiles } from "../../src/db/raw-queries.js";
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
		JSON.stringify({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-02-01T09:00:09.000Z", message: { id: "msg_2", role: "assistant", model: "model-x", stop_reason: "end_turn", content: [{ type: "text", text: "Done: häppy ünïcode ✓ 😀" }], usage: { input_tokens: 3, output_tokens: 4 } } }),
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

async function sync(env: Env, captureRaw = true) {
	return runSync(env.db, [new ClaudeFileSource(env.root)], { captureRaw });
}

/** Every row the sync writes for the index, minus the columns that only record the sync itself. */
async function snapshot(db: AsyncDatabase): Promise<string> {
	const sessions = await db.prepare("SELECT id, file_path, project, cwd, name, started_at, message_count FROM sessions ORDER BY id").all();
	const messages = await db.prepare("SELECT rowid, * FROM messages ORDER BY rowid").all();
	const nodes = await db.prepare("SELECT * FROM analysis_nodes ORDER BY id").all();
	return JSON.stringify({ sessions, messages, nodes });
}

async function rawRowCount(db: AsyncDatabase): Promise<number> {
	const a = (await db.prepare("SELECT COUNT(*) AS n FROM session_raw_chunks").get()) as { n: number };
	const b = (await db.prepare("SELECT COUNT(*) AS n FROM session_raw_files").get()) as { n: number };
	return a.n + b.n;
}

describe("lossless Claude Code capture", () => {
	it("exports a deleted session byte for byte, including records the sync skips and a line it cannot parse", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "round-trip");
			const original = Buffer.from(richLines("round-trip").join("\n") + "\n");
			write(file, original);
			const result = await sync(env);
			assert.equal(result.errors.length, 0, result.errors.join("; "));
			assert.equal(result.rawSessionsCaptured, 1);

			fs.rmSync(file);
			const id = claudeSessionId("round-trip");
			const s = await getExportableSession(env.db, id);
			assert.ok(s);
			const outcome = await exportClaudeSession(env.db, s, env.out, env.root);
			assert.equal(outcome.kind, "exact");
			const restored = path.join(env.out, PROJECT, claudeSessionFileName("round-trip"));
			assert.ok(fs.readFileSync(restored).equals(original), "restored bytes differ from the original");

			const chunks = await getRawChunks(env.db, id);
			assert.equal(chunks.length, 1);
			assert.equal(chunks[0]!.line_start, 0);
			assert.equal(chunks[0]!.line_count, richLines("round-trip").length);
			assert.equal(chunks[0]!.rel_path, `${PROJECT}/${claudeSessionFileName("round-trip")}`);
		} finally {
			await env.cleanup();
		}
	});

	it("restores a file without a trailing newline, CRLF endings and bytes that are not valid UTF-8", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "odd-bytes");
			const first = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/sample", message: { role: "user", content: "hi" } });
			const original = Buffer.concat([Buffer.from(first + "\r\n"), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from('{"type":"mode","mode":"x"}')]);
			write(file, original);
			await sync(env);
			fs.rmSync(file);
			const s = await getExportableSession(env.db, claudeSessionId("odd-bytes"));
			await exportClaudeSession(env.db, s!, env.out, env.root);
			assert.ok(fs.readFileSync(path.join(env.out, PROJECT, claudeSessionFileName("odd-bytes"))).equals(original));
		} finally {
			await env.cleanup();
		}
	});

	it("stores only the new bytes of a growing file and nothing for an unchanged one", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "growth");
			const lines = richLines("growth");
			write(file, lines.slice(0, 6).join("\n") + "\n");
			await sync(env);
			const afterFirst = await rawRowCount(env.db);

			const again = await sync(env);
			assert.equal(again.rawSessionsCaptured, undefined, "an unchanged file must not be captured again");
			assert.equal(await rawRowCount(env.db), afterFirst);

			// The host is mid-write: the last line is cut off, then completed.
			const rest = lines.slice(6).join("\n") + "\n";
			fs.appendFileSync(file, rest.slice(0, 40));
			bump(file);
			await sync(env);
			fs.appendFileSync(file, rest.slice(40));
			bump(file);
			await sync(env);

			const id = claudeSessionId("growth");
			const chunks = await getRawChunks(env.db, id);
			assert.equal(chunks.length, 3);
			assert.deepEqual(chunks.map((c) => c.line_start), [0, 6, 6 + (chunks[1]!.line_count)]);
			assert.equal(chunks[0]!.byte_start, 0);
			assert.equal(chunks[1]!.byte_start, chunks[0]!.raw_bytes);

			const original = fs.readFileSync(file);
			fs.rmSync(file);
			await exportClaudeSession(env.db, (await getExportableSession(env.db, id))!, env.out, env.root);
			assert.ok(fs.readFileSync(path.join(env.out, PROJECT, claudeSessionFileName("growth"))).equals(original));
		} finally {
			await env.cleanup();
		}
	});

	it("keeps the stored copy and reports it when a file is rewritten instead of appended to", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "rewrite");
			const lines = richLines("rewrite");
			const original = Buffer.from(lines.join("\n") + "\n");
			write(file, original);
			await sync(env);
			write(file, Buffer.from(lines.map((l) => l.replace("Add a retry", "Add a TIMEOUT")).join("\n") + "\nextra\n"));
			bump(file);
			const result = await sync(env);
			assert.ok(result.errors.some((e) => /raw capture skipped/.test(e)), result.errors.join("; "));
			assert.equal((await getRawChunks(env.db, claudeSessionId("rewrite"))).length, 1);
		} finally {
			await env.cleanup();
		}
	});

	it("captures a subagent's .meta.json beside its transcript and restores it", async () => {
		const env = await setup();
		try {
			const parent = claudeSessionId("parent-session");
			const agentFile = path.join(env.root, PROJECT, parent, "subagents", "agent-a1b2c3.jsonl");
			const meta = '{"agentType":"explore","description":"find the retry helper"}\n';
			write(agentFile, richLines("agent").join("\n") + "\n");
			write(path.join(env.root, PROJECT, parent, "subagents", "agent-a1b2c3.meta.json"), meta);
			await sync(env);

			const files = await getRawFiles(env.db, "agent-a1b2c3");
			assert.equal(files.length, 1);
			assert.equal(files[0]!.rel_path, `${PROJECT}/${parent}/subagents/agent-a1b2c3.meta.json`);

			// An unchanged sidecar is not stored twice, and a changed one replaces its row.
			bump(agentFile);
			await sync(env);
			assert.equal((await getRawFiles(env.db, "agent-a1b2c3")).length, 1);
			write(path.join(env.root, PROJECT, parent, "subagents", "agent-a1b2c3.meta.json"), '{"agentType":"plan"}\n');
			bump(agentFile);
			await sync(env);
			assert.equal((await getRawFiles(env.db, "agent-a1b2c3")).length, 1);

			fs.rmSync(path.join(env.root, PROJECT, parent), { recursive: true });
			await exportClaudeSession(env.db, (await getExportableSession(env.db, "agent-a1b2c3"))!, env.out, env.root);
			assert.equal(fs.readFileSync(path.join(env.out, PROJECT, parent, "subagents", "agent-a1b2c3.meta.json"), "utf-8"), '{"agentType":"plan"}\n');
		} finally {
			await env.cleanup();
		}
	});

	it("fills in a session indexed before capture existed, without touching a row", async () => {
		const env = await setup();
		try {
			const file = sessionPath(env, "backfill");
			const original = Buffer.from(richLines("backfill").join("\n") + "\n");
			write(file, original);
			await sync(env, false);
			assert.equal(await rawRowCount(env.db), 0);
			const before = await snapshot(env.db);

			const result = await sync(env, true);
			assert.equal(result.sessionsProcessed, 0, "the session must not be re-parsed");
			assert.equal(result.rawSessionsCaptured, 1);
			assert.equal(await snapshot(env.db), before);

			fs.rmSync(file);
			await exportClaudeSession(env.db, (await getExportableSession(env.db, claudeSessionId("backfill")))!, env.out, env.root);
			assert.ok(fs.readFileSync(path.join(env.out, PROJECT, claudeSessionFileName("backfill"))).equals(original));
		} finally {
			await env.cleanup();
		}
	});

	it("writes nothing when capture is off", async () => {
		const env = await setup();
		try {
			write(sessionPath(env, "off"), richLines("off").join("\n") + "\n");
			const result = await sync(env, false);
			assert.equal(result.rawSessionsCaptured, undefined);
			assert.equal(await rawRowCount(env.db), 0);
		} finally {
			await env.cleanup();
		}
	});

	it("adds the capture tables to an existing database without touching a row", async () => {
		const env = await setup();
		try {
			write(sessionPath(env, "migrate"), richLines("migrate").join("\n") + "\n");
			await sync(env, false);
			await env.db.exec("DROP TABLE session_raw_chunks; DROP TABLE session_raw_files;");
			const before = await snapshot(env.db);
			await migrate(env.db);
			await migrate(env.db);
			assert.equal(await rawRowCount(env.db), 0);
			assert.equal(await snapshot(env.db), before);
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
		await sync(env, false);
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
			const skipped = await sync(env, true);
			assert.equal(skipped.sessionsProcessed, 0);
			assert.equal(await snapshot(env.db), before);

			// 2. Forced newer, the file is parsed again; every message row is kept as it was.
			bump(file);
			const reread = await sync(env, true);
			assert.equal(reread.sessionsProcessed, 1);
			const after = JSON.parse(await snapshot(env.db)) as { sessions: unknown; messages: unknown; nodes: unknown };
			const was = JSON.parse(before) as typeof after;
			assert.deepEqual(after.messages, was.messages);
			assert.deepEqual(after.nodes, was.nodes);
			assert.deepEqual(after.sessions, was.sessions);
			// No analysis unit became stale or missing.
			const units = await fw.scan(id);
			assert.deepEqual([...new Set(units.map((u) => u.status))], ["current"]);
			// The rebuilt file now exists on disk, so its bytes are captured like any other.
			assert.equal((await getRawChunks(env.db, id)).length, 1);
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
		const saved = { db: process.env["PROSPECTOR_DB_PATH"], root: process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] };
		try {
			const gone = sessionPath(env, "gone");
			const kept = sessionPath(env, "kept");
			const original = Buffer.from(richLines("gone").join("\n") + "\n");
			write(gone, original);
			write(kept, richLines("kept").join("\n") + "\n");
			await sync(env);
			fs.rmSync(gone);
			await env.db.close();

			process.env["PROSPECTOR_DB_PATH"] = path.join(env.dir, "test.db");
			process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = env.root;
			const notes: string[] = [];
			const ctx = { ui: { notify: (m: string) => notes.push(m) }, cwd: env.dir, hasUI: false } as never;
			await prospectExportSession(`--all-missing --out ${env.out}`, ctx);
			assert.match(notes.join("\n"), /Exact \(original bytes\): 1/);
			assert.ok(fs.readFileSync(path.join(env.out, PROJECT, claudeSessionFileName("gone"))).equals(original));
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
			// Writing into "/" would touch the real root, so the climbing case is the one run for real.
			await env.db.prepare("UPDATE session_raw_chunks SET rel_path = '../escape.jsonl' WHERE session_id = ?").run(s.id);
			await assert.rejects(exportClaudeSession(env.db, s, env.out, env.root), /leaves the output directory/);
			assert.equal(fs.existsSync(path.join(env.dir, "escape.jsonl")), false);
		} finally {
			await env.cleanup();
		}
	});
});
