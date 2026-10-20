import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { CodexFileSource, codexSessionRowId } from "../../src/sync/sources/codex-file.js";
import { tempDb } from "./helpers.js";
import {
	codexCommandExecutionLine,
	codexCustomToolCallLine,
	codexFunctionCallLine,
	codexFunctionCallOutputLine,
	codexItemCompletedLine,
	codexMessageLine,
	codexMetaLine,
	codexReasoningLine,
	codexRolloutFileName,
	codexSessionId,
	codexTaskCompleteLine,
	codexTaskStartedLine,
	codexTurnAbortedLine,
	codexTurnContextLine,
	codexUsageRecordLine,
} from "../fixtures/codex-rollout.js";

/**
 * The Codex source, end to end through the real sync loop and a real SQLite
 * database. The fixtures are hand-written synthetic rollout files.
 */
describe("Codex session sync", () => {
	/**
	 * A Codex sessions root holding one rollout file, in the layout Codex
	 * writes: `<root>/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
	 */
	function codexRoot(files: Array<{ label: string; lines: string[]; day?: string }>): { root: string; cleanup: () => void } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-codex-"));
		for (const f of files) {
			const dir = path.join(root, f.day ?? "2026", "03", "04");
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, codexRolloutFileName(f.label)), f.lines.join("\n") + "\n");
		}
		return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
	}

	it("indexes a Codex session as its own source", async () => {
		const { db, close } = await tempDb();
		const label = "codex-basic";
		const turn = "turn-basic";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label, { cwd: "/home/tester/workspace/notes-app" }),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "add a note titled groceries", { kinds: ["user.text"], turnId: turn }),
					codexReasoningLine("The user wants a note titled groceries.", turn),
					codexMessageLine("assistant", "I will create the note.", { turnId: turn }),
					codexUsageRecordLine(turn, "resp-1", { input: 900, output: 120 }),
				],
			},
		]);
		try {
			const result = await runSync(db, [new CodexFileSource(root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(result.sessionsProcessed, 1);

			const session = (await db
				.prepare("SELECT id, source, cwd, project, started_at, message_count FROM sessions")
				.get()) as Record<string, unknown>;
			assert.equal(session.id, codexSessionRowId(codexSessionId(label), codexRolloutFileName(label)));
			assert.equal(session.source, "codex");
			assert.equal(session.cwd, "/home/tester/workspace/notes-app");
			assert.equal(session.project, "notes-app");
			assert.equal(session.started_at, "2026-03-04T09:15:00.000Z");
			// The human's turn, the model's thinking and what it said: the
			// thinking and the words share one row, as they do for the other
			// harnesses.
			assert.equal(session.message_count, 2);
		} finally {
			cleanup();
			await close();
		}
	});

	it("indexes the human's turn and the agent's answer, and no host context", async () => {
		const { db, close } = await tempDb();
		const label = "codex-turns";
		const turn = "turn-1";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "# AGENTS.md instructions for /home/tester/workspace/notes-app", {
						kinds: ["agents_md.instructions", "environments.environment_context"],
						turnId: turn,
					}),
					codexMessageLine("developer", "collaboration mode instructions", { turnId: turn }),
					codexMessageLine("user", "add a note titled groceries", { kinds: ["user.text"], turnId: turn }),
					codexMessageLine("assistant", "Created the note.", { turnId: turn }),
					codexUsageRecordLine(turn, "resp-1"),
				],
			},
		]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const rows = (await db
				.prepare("SELECT role, content_text FROM messages WHERE session_id = ? ORDER BY rowid")
				.all(codexSessionRowId(codexSessionId(label), codexRolloutFileName(label)))) as Array<{ role: string; content_text: string | null }>;
			// The AGENTS.md body and the developer block are the host's own context:
			// neither opens a turn, so neither becomes a message row.
			assert.deepEqual(rows, [
				{ role: "user", content_text: "add a note titled groceries" },
				{ role: "assistant", content_text: "Created the note." },
			]);
		} finally {
			cleanup();
			await close();
		}
	});

	it("indexes a tool call and its result, paired by the call id", async () => {
		const { db, close } = await tempDb();
		const label = "codex-tools";
		const turn = "turn-1";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "list the notes", { kinds: ["user.text"], turnId: turn }),
					codexFunctionCallLine("exec_command", "call-1", { cmd: "ls notes" }, turn),
					codexUsageRecordLine(turn, "resp-1"),
					codexFunctionCallOutputLine("call-1", "groceries\nwork\n", turn),
					codexFunctionCallLine("exec_command", "call-2", { cmd: "cat notes/groceries" }, turn),
					codexUsageRecordLine(turn, "resp-2"),
					codexFunctionCallOutputLine("call-2", "Process exited with code 1\n", turn),
					codexTaskCompleteLine(turn),
				],
			},
		]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const calls = (await db
				.prepare("SELECT tool_calls FROM messages WHERE role = 'assistant' AND tool_calls IS NOT NULL ORDER BY rowid")
				.all()) as Array<{ tool_calls: string }>;
			assert.equal(calls.length, 2);
			assert.deepEqual(JSON.parse(calls[0]!.tool_calls), [
				{ id: "call-1", name: "bash", arguments: { cmd: "ls notes" } },
			]);

			const results = (await db
				.prepare("SELECT role, tool_results, content_text FROM messages WHERE role = 'toolResult' ORDER BY rowid")
				.all()) as Array<{ role: string; tool_results: string; content_text: string | null }>;
			assert.equal(results.length, 2);
			assert.deepEqual(JSON.parse(results[0]!.tool_results), [
				{ toolCallId: "call-1", toolName: "bash", isError: false, textLength: 15 },
			]);
			// A non-zero exit is a failed tool call, and the failure's cause is
			// classified at ingest so an analyzer can tell it from a success.
			const failed = JSON.parse(results[1]!.tool_results)[0] as { isError: boolean; errorClass?: string };
			assert.equal(failed.isError, true);
			assert.equal(failed.errorClass, "unclassified");
		} finally {
			cleanup();
			await close();
		}
	});

	it("records the serving model and the token usage of each generation", async () => {
		const { db, close } = await tempDb();
		const label = "codex-usage";
		const turn = "turn-1";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "write a note", { kinds: ["user.text"], turnId: turn }),
					codexMessageLine("assistant", "Writing it now.", { turnId: turn }),
					codexUsageRecordLine(turn, "resp-1", { input: 1000, output: 200, cachedInput: 300, cacheWrite: 50 }),
				],
			},
		]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const assistant = (await db
				.prepare("SELECT model, usage, cost_usd FROM messages WHERE role = 'assistant'")
				.get()) as { model: string | null; usage: string | null; cost_usd: number | null };
			assert.equal(assistant.model, "gpt-5-codex");
			const usage = JSON.parse(assistant.usage!) as Record<string, number>;
			assert.equal(usage.input, 1000);
			assert.equal(usage.output, 200);
			assert.equal(usage.cacheRead, 300);
			assert.equal(usage.cacheWrite, 50);
			assert.equal(usage.totalTokens, 1200);
			// Codex records no per-message dollar cost, so the cost stays unknown.
			assert.equal(assistant.cost_usd, null);
		} finally {
			cleanup();
			await close();
		}
	});

	it("records an aborted turn as a turn failure", async () => {
		const { db, close } = await tempDb();
		const label = "codex-abort";
		const turn = "turn-1";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "start something long", { kinds: ["user.text"], turnId: turn }),
					codexMessageLine("assistant", "On it.", { turnId: turn }),
					codexUsageRecordLine(turn, "resp-1"),
					codexTurnAbortedLine(turn),
				],
			},
		]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const rows = (await db
				.prepare("SELECT stop_reason FROM messages WHERE role = 'assistant'")
				.all()) as Array<{ stop_reason: string | null }>;
			assert.ok(rows.length >= 1);
			assert.ok(rows.some((r) => r.stop_reason === "aborted"), "the aborted turn is recorded as a failure");
		} finally {
			cleanup();
			await close();
		}
	});

	it("re-syncs incrementally: an unchanged file is skipped, a grown file resumes", async () => {
		const { db, close } = await tempDb();
		const label = "codex-incremental";
		const turn = "turn-1";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "first question", { kinds: ["user.text"], turnId: turn }),
					codexMessageLine("assistant", "first answer", { turnId: turn }),
					codexUsageRecordLine(turn, "resp-1"),
				],
			},
		]);
		try {
			const first = await runSync(db, [new CodexFileSource(root)]);
			assert.equal(first.sessionsProcessed, 1);
			assert.equal(first.messagesInserted, 2);

			const second = await runSync(db, [new CodexFileSource(root)]);
			assert.equal(second.sessionsProcessed, 0, "an unchanged file is skipped");
			assert.equal(second.sessionsSkipped, 1);
			assert.equal(second.messagesInserted, 0);

			// The file grows: the new turn is indexed, the old one is not repeated.
			const file = path.join(root, "2026", "03", "04", codexRolloutFileName(label));
			fs.appendFileSync(
				file,
				[
					codexMessageLine("user", "second question", { kinds: ["user.text"], turnId: turn }),
					codexMessageLine("assistant", "second answer", { turnId: turn }),
					codexUsageRecordLine(turn, "resp-2"),
					"",
				].join("\n"),
			);
			// The cursor keys on mtime, so a grown file must look newer.
			const future = new Date(Date.now() + 5000);
			fs.utimesSync(file, future, future);

			const third = await runSync(db, [new CodexFileSource(root)]);
			assert.equal(third.sessionsProcessed, 1);
			assert.equal(third.messagesInserted, 2, "only the new turn's rows are inserted");

			const rows = (await db
				.prepare("SELECT content_text FROM messages ORDER BY rowid")
				.all()) as Array<{ content_text: string }>;
			assert.deepEqual(rows.map((r) => r.content_text), [
				"first question",
				"first answer",
				"second question",
				"second answer",
			]);
		} finally {
			cleanup();
			await close();
		}
	});

	it("advances the cursor past the file's last record, not past its trailing newline", async () => {
		// A rollout file always ends with a newline, so `split("\n")` leaves a
		// trailing empty element that holds no record. Counting it would put
		// the cursor one past the last record, and the next record the host
		// appends would land exactly on that index and be skipped.
		const { db, close } = await tempDb();
		const label = "codex-cursor";
		const turn = "turn-1";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "first question", { kinds: ["user.text"], turnId: turn }),
					codexMessageLine("assistant", "first answer", { turnId: turn }),
					codexUsageRecordLine(turn, "resp-1"),
				],
			},
		]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const file = path.join(root, "2026", "03", "04", codexRolloutFileName(label));
			const content = fs.readFileSync(file, "utf-8");
			assert.ok(content.endsWith("\n"), "the fixture ends with a newline, as a real rollout file does");

			const cursor = (await db
				.prepare("SELECT last_line FROM sessions")
				.get()) as { last_line: number };
			const recordCount = content.split("\n").length - 1;
			assert.equal(cursor.last_line, recordCount, "the cursor points at the first line that holds no record");
		} finally {
			cleanup();
			await close();
		}
	});

	it("claims only the files Codex names, and never another source's", async () => {
		const { db, close } = await tempDb();
		const label = "codex-discovery";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [codexMetaLine(label), codexTurnContextLine("turn-1", "gpt-5-codex")],
			},
		]);
		try {
			// A file in the same tree that Codex does not name: it belongs to
			// whoever wrote it and must never be read as a session.
			const stray = path.join(root, "2026", "03", "04", "not-a-rollout.jsonl");
			fs.writeFileSync(stray, JSON.stringify({ type: "session", id: "not-codex" }) + "\n");

			const found = await new CodexFileSource(root).discover();
			assert.equal(found.length, 1);
			assert.equal(path.basename(found[0]!.filePath), codexRolloutFileName(label));
			assert.equal(found[0]!.source, "codex");

			const result = await runSync(db, [new CodexFileSource(root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(result.sessionsProcessed, 1);
		} finally {
			cleanup();
			await close();
		}
	});

	it("indexes a custom tool call and a compaction boundary", async () => {
		const { db, close } = await tempDb();
		const label = "codex-patch";
		const turn = "turn-1";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexMessageLine("user", "add a file", { kinds: ["user.text"], turnId: turn }),
					codexCustomToolCallLine("apply_patch", "call-1", "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch", turn),
					codexUsageRecordLine(turn, "resp-1"),
					codexFunctionCallOutputLine("call-1", "Exit code: 0\nSuccess. Updated the following files:\n", turn),
				],
			},
		]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const calls = (await db
				.prepare("SELECT tool_calls FROM messages WHERE tool_calls IS NOT NULL")
				.all()) as Array<{ tool_calls: string }>;
			assert.equal(calls.length, 1);
			const call = JSON.parse(calls[0]!.tool_calls)[0] as { name: string; arguments: Record<string, unknown> };
			assert.equal(call.name, "edit");
			assert.match(String(call.arguments["input"]), /^\*\*\* Begin Patch/);
		} finally {
			cleanup();
			await close();
		}
	});

	it("indexes the older rollout format, whose conversation lives in events", async () => {
		// The older format records the conversation in `item_completed` events
		// rather than in response items, and its response items are a sample of
		// the same conversation. Reading both would double every message.
		const { db, close } = await tempDb();
		const label = "codex-older";
		const turn = "turn-old";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					// The human's turn, as an event.
					codexItemCompletedLine(turn, "UserMessage", "add a note titled groceries", "item-1"),
					// The model's answer, as an event.
					codexItemCompletedLine(turn, "AgentMessage", "Created the note.", "item-2"),
					// A command the host ran, and its result.
					codexCommandExecutionLine(turn, "cmd-1", "ls notes", 0, "groceries\nwork\n"),
					// The sampled response item, which the events already carry.
					codexMessageLine("user", "add a note titled groceries"),
				],
			},
		]);
		try {
			const result = await runSync(db, [new CodexFileSource(root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(result.sessionsProcessed, 1);

			const rows = (await db
				.prepare("SELECT role, content_text FROM messages WHERE session_id = ? ORDER BY rowid")
				.all(codexSessionRowId(codexSessionId(label), codexRolloutFileName(label)))) as Array<{ role: string; content_text: string | null }>;
			// The human's turn and the model's answer — once each, read from the
			// events rather than from the sampled item that repeats one of them.
			assert.deepEqual(rows, [
				{ role: "user", content_text: "add a note titled groceries" },
				{ role: "assistant", content_text: "Created the note." },
				{ role: "toolResult", content_text: "groceries\nwork\n" },
			]);

			const results = (await db
				.prepare("SELECT tool_results FROM messages WHERE role = 'toolResult'")
				.all()) as Array<{ tool_results: string }>;
			assert.deepEqual(JSON.parse(results[0]!.tool_results), [
				{ toolCallId: "cmd-1", toolName: "bash", isError: false, textLength: 15 },
			]);
		} finally {
			cleanup();
			await close();
		}
	});

	it("records a failed command as a failed tool result", async () => {
		const { db, close } = await tempDb();
		const label = "codex-older-fail";
		const turn = "turn-old";
		const { root, cleanup } = codexRoot([
			{
				label,
				lines: [
					codexMetaLine(label),
					codexTaskStartedLine(turn),
					codexTurnContextLine(turn, "gpt-5-codex"),
					codexCommandExecutionLine(turn, "cmd-1", "cat missing.txt", 1, "cat: missing.txt: No such file or directory\n"),
				],
			},
		]);
		try {
			await runSync(db, [new CodexFileSource(root)]);
			const results = (await db
				.prepare("SELECT tool_results FROM messages WHERE role = 'toolResult'")
				.all()) as Array<{ tool_results: string }>;
			const result = JSON.parse(results[0]!.tool_results)[0] as { isError: boolean; errorClass?: string };
			assert.equal(result.isError, true, "a non-zero exit is a failure");
			assert.equal(result.errorClass, "not_found");
		} finally {
			cleanup();
			await close();
		}
	});
});
