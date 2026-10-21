import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { ClineFileSource } from "../../src/sync/sources/cline-file.js";
import { makeTempRoot, tempDb } from "./helpers.js";
import {
	clineAssistant,
	clineManifest,
	clineToolResults,
	clineToolUse,
	clineUser,
	writeClineSession,
} from "../fixtures/cline-session.js";

/**
 * The Cline source, end to end through the real sync loop and a real SQLite
 * database. The fixtures are hand-written synthetic Cline session directories.
 */

const T0 = 1772615700000;
const SESSION = "1772615700000_ab12c";

type Row = Record<string, unknown>;

/** One turn: a request, a step that runs a command and edits a file, and an answer. */
function basicMessages(): Array<Record<string, unknown>> {
	return [
		clineUser("msg_u1", "add a note titled groceries", T0),
		clineAssistant(
			"msg_a1",
			[
				{ type: "thinking", thinking: "The note goes in notes/groceries.md." },
				{ type: "text", text: "I will create the note." },
				clineToolUse("toolu_1", "run_commands", { commands: ["ls notes", "mkdir -p notes"] }),
				clineToolUse("toolu_2", "editor", { path: "/home/tester/workspace/notes-app/notes/groceries.md", new_text: "milk" }),
			],
			T0 + 1000,
			{ metrics: { inputTokens: 900, outputTokens: 120, cacheReadTokens: 400, cacheWriteTokens: 50, cost: 0.0125 } },
		),
		clineToolResults(
			"msg_r1",
			[
				{ callId: "toolu_1", name: "run_commands", text: "ls: notes: No such file or directory", isError: true },
				{ callId: "toolu_2", name: "editor", text: "File created" },
			],
			T0 + 1500,
		),
		clineAssistant("msg_a2", [{ type: "text", text: "The note is saved." }], T0 + 2000, {
			metrics: { inputTokens: 1200, outputTokens: 40 },
		}),
	];
}

describe("Cline session sync", () => {
	it("indexes a Cline session as its own source", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = makeTempRoot("prospect-cline-");
		try {
			writeClineSession(root, { sessionId: SESSION, manifest: clineManifest(SESSION, { title: "Add a groceries note" }), messages: basicMessages() });
			const result = await runSync(db, [new ClineFileSource(root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(result.sessionsProcessed, 1);

			const session = (await db.prepare("SELECT * FROM sessions").get()) as Row;
			assert.equal(session["id"], SESSION);
			assert.equal(session["source"], "cline");
			assert.equal(session["cwd"], "/home/tester/workspace/notes-app");
			assert.equal(session["project"], "notes-app");
			assert.equal(session["name"], "Add a groceries note");
			assert.equal(session["started_at"], "2026-03-04T09:15:00.000Z");
			assert.equal(session["parent_session"], null);
			assert.equal(session["tool_inventory"], null, "Cline records no tool manifest in the session");
			assert.equal(session["message_count"], 4);
		} finally {
			cleanup();
			await close();
		}
	});

	it("writes the conversation with tool calls and results in the index's vocabulary", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = makeTempRoot("prospect-cline-");
		try {
			writeClineSession(root, { sessionId: SESSION, manifest: clineManifest(SESSION), messages: basicMessages() });
			await runSync(db, [new ClineFileSource(root)]);
			const rows = (await db.prepare("SELECT * FROM messages ORDER BY rowid").all()) as Row[];
			assert.deepEqual(
				rows.map((r) => [r["id"], r["role"]]),
				[
					[`${SESSION}:msg_u1`, "user"],
					[`${SESSION}:msg_a1`, "assistant"],
					[`${SESSION}:msg_r1`, "toolResult"],
					[`${SESSION}:msg_a2`, "assistant"],
				],
			);
			const [user, step, results] = rows as [Row, Row, Row, Row];
			assert.equal(user["content_text"], "add a note titled groceries");
			assert.equal(user["timestamp"], new Date(T0).toISOString());
			assert.equal(step["parent_id"], `${SESSION}:msg_u1`);
			assert.equal(step["content_text"], "I will create the note.");
			assert.equal(step["content_thinking"], "The note goes in notes/groceries.md.");
			assert.equal(step["model"], "fixture-provider/fixture-model-1");
			assert.equal(step["cost_usd"], 0.0125);
			assert.deepEqual(JSON.parse(String(step["usage"])), {
				input: 900,
				output: 120,
				cacheRead: 400,
				cacheWrite: 50,
				totalTokens: 1020,
				cost: null,
			});
			// `run_commands` runs a list of shell commands: one bash call each,
			// so every analyzer that reads a shell command sees them.
			assert.deepEqual(JSON.parse(String(step["tool_calls"])), [
				{ id: "toolu_1", name: "bash", arguments: { command: "ls notes\nmkdir -p notes", commands: ["ls notes", "mkdir -p notes"] } },
				{ id: "toolu_2", name: "edit", arguments: { path: "/home/tester/workspace/notes-app/notes/groceries.md", new_text: "milk" } },
			]);
			assert.deepEqual(JSON.parse(String(results["tool_results"])), [
				{
					toolCallId: "toolu_1",
					toolName: "bash",
					isError: true,
					textLength: "ls: notes: No such file or directory".length,
					errorClass: "not_found",
				},
				{ toolCallId: "toolu_2", toolName: "edit", isError: false, textLength: "File created".length },
			]);
			assert.equal(results["content_text"], null, "result text is classified, never stored");
		} finally {
			cleanup();
			await close();
		}
	});

	it("keeps display-only and system-injected entries out of the turns, and names a compaction summary", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = makeTempRoot("prospect-cline-");
		try {
			writeClineSession(root, {
				sessionId: SESSION,
				manifest: clineManifest(SESSION),
				messages: [
					clineUser("msg_u1", "run the tests", T0),
					clineUser("msg_hook", "<hook_context>lint passed</hook_context>", T0 + 10, { displayRole: "system", userRunSpan: 0 }),
					clineAssistant("error_1", [{ type: "text", text: "Provider overloaded" }], T0 + 500, {
						metadata: { displayOnly: true, displayRole: "error" },
					}),
					clineUser("msg_c1", "Summary: the user runs the tests.", T0 + 600, {
						kind: "compaction_summary",
						displayRole: "system",
						summary: "the user runs the tests",
					}),
					clineUser("msg_u2", "try again", T0 + 700),
				],
			});
			await runSync(db, [new ClineFileSource(root)]);
			const rows = (await db.prepare("SELECT id, role, content_text, stop_reason, error_message FROM messages ORDER BY rowid").all()) as Row[];
			assert.deepEqual(rows, [
				{ id: `${SESSION}:msg_u1`, role: "user", content_text: "run the tests", stop_reason: null, error_message: null },
				{ id: `${SESSION}:msg_hook`, role: "custom/system", content_text: "<hook_context>lint passed</hook_context>", stop_reason: null, error_message: null },
				// The runtime's terminal-error notice is the turn failure it records.
				{ id: `${SESSION}:error_1`, role: "assistant", content_text: null, stop_reason: "error", error_message: "Provider overloaded" },
				{ id: `${SESSION}:msg_c1`, role: "compactionSummary", content_text: "Summary: the user runs the tests.", stop_reason: null, error_message: null },
				{ id: `${SESSION}:msg_u2`, role: "user", content_text: "try again", stop_reason: null, error_message: null },
			]);
		} finally {
			cleanup();
			await close();
		}
	});

	it("indexes a child agent's conversation under the session that spawned it", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = makeTempRoot("prospect-cline-");
		try {
			writeClineSession(root, { sessionId: SESSION, manifest: clineManifest(SESSION), messages: basicMessages() });
			writeClineSession(root, {
				sessionId: `${SESSION}__explorer`,
				rootSessionId: SESSION,
				agentId: "explorer",
				messages: [clineUser("msg_u1", "find the notes directory", T0 + 100)],
			});
			await runSync(db, [new ClineFileSource(root)]);
			const child = (await db.prepare("SELECT cwd, project, parent_session FROM sessions WHERE id = ?").get(`${SESSION}__explorer`)) as Row;
			assert.deepEqual(child, { cwd: "/home/tester/workspace/notes-app", project: "notes-app", parent_session: SESSION });
			// Ids are scoped by session: both files have a message `msg_u1`.
			const ids = (await db.prepare("SELECT id FROM messages WHERE id LIKE '%:msg_u1' ORDER BY id").all()) as Row[];
			assert.equal(ids.length, 2);
		} finally {
			cleanup();
			await close();
		}
	});

	it("skips an unchanged session and indexes only the messages a rewrite added", async () => {
		const { db, close } = await tempDb();
		const { root, cleanup } = makeTempRoot("prospect-cline-");
		try {
			const fixture = { sessionId: SESSION, manifest: clineManifest(SESSION), messages: basicMessages() };
			const file = writeClineSession(root, fixture);
			const source = new ClineFileSource(root);
			assert.equal((await runSync(db, [source])).sessionsProcessed, 1);
			const again = await runSync(db, [source]);
			assert.equal(again.sessionsSkipped, 1);
			assert.equal(again.messagesInserted, 0);

			// Cline rewrites the whole file after every iteration.
			writeClineSession(root, { ...fixture, messages: [...basicMessages(), clineUser("msg_u2", "now add eggs", T0 + 9000)] });
			const later = new Date(Date.now() + 5000);
			fs.utimesSync(file, later, later);
			const third = await runSync(db, [source]);
			assert.deepEqual(third.errors, []);
			assert.equal(third.sessionsProcessed, 1);
			assert.equal(third.messagesInserted, 1, "only the new message is inserted");
		} finally {
			cleanup();
			await close();
		}
	});

	it("claims only the messages files Cline names", async () => {
		const { root, cleanup } = makeTempRoot("prospect-cline-");
		try {
			writeClineSession(root, { sessionId: SESSION, manifest: clineManifest(SESSION), messages: basicMessages() });
			// Files the same tree holds that are not conversations.
			fs.writeFileSync(path.join(root, SESSION, `${SESSION}.compaction.json`), "{}");
			fs.writeFileSync(path.join(root, "sessions.index.json"), "[]");
			fs.writeFileSync(path.join(root, "subagent-spawn-queue.json"), "[]");
			fs.mkdirSync(path.join(root, "stray"));
			fs.writeFileSync(path.join(root, "stray", "notes.messages.json"), "{}");
			const found = await new ClineFileSource(root).discover();
			assert.deepEqual(
				found.map((d) => path.relative(root, d.filePath)),
				[path.join(SESSION, `${SESSION}.messages.json`)],
			);
			assert.deepEqual(await new ClineFileSource(path.join(root, "missing")).discover(), []);
		} finally {
			cleanup();
		}
	});
});
