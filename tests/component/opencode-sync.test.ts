import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { OpenCodeDbSource } from "../../src/sync/sources/opencode-db.js";
import { makeTempRoot, tempDb } from "./helpers.js";
import {
	OpenCodeFixtureDb,
	openCodeAssistant,
	openCodeDbWithoutMessages,
	openCodeReasoning,
	openCodeStepFinish,
	openCodeText,
	openCodeTool,
	openCodeUser,
} from "../fixtures/opencode-db.js";

/**
 * The OpenCode source, end to end through the real sync loop and a real SQLite
 * database. The OpenCode store is a hand-written synthetic `opencode.db`.
 */

const T0 = 1772615700000;

/** An OpenCode data directory holding one `opencode.db`. */
function openCodeRoot(): { root: string; db: OpenCodeFixtureDb; cleanup: () => void } {
	const { root, cleanup } = makeTempRoot("prospect-opencode-");
	const db = new OpenCodeFixtureDb(path.join(root, "opencode.db"));
	return {
		root,
		db,
		cleanup: () => {
			try {
				db.close();
			} catch {
				/* already closed */
			}
			cleanup();
		},
	};
}

/** One turn: a request, a step that edits a file, and a step that answers. */
function writeBasicSession(db: OpenCodeFixtureDb, sessionId = "ses_basic"): void {
	db.addSession({ id: sessionId, title: "Add a groceries note", timeCreated: T0, timeUpdated: T0 + 5000 });
	db.addMessage(sessionId, {
		id: `msg_${sessionId}_u1`,
		timeCreated: T0,
		data: openCodeUser(T0),
		parts: [{ id: `prt_${sessionId}_u1`, data: openCodeText("add a note titled groceries") }],
	});
	db.addMessage(sessionId, {
		id: `msg_${sessionId}_a1`,
		timeCreated: T0 + 1000,
		data: openCodeAssistant(T0 + 1000, {
			parentId: `msg_${sessionId}_u1`,
			cost: 0.0125,
			tokens: { input: 900, output: 120, reasoning: 30, cacheRead: 400, cacheWrite: 50 },
			finish: "tool-calls",
		}),
		parts: [
			{ id: `prt_${sessionId}_a1_1r`, data: openCodeReasoning("The note goes in notes/groceries.md.", T0 + 1000) },
			{ id: `prt_${sessionId}_a1_2t`, data: openCodeText("I will create the note.") },
			{
				id: `prt_${sessionId}_a1_3w`,
				data: openCodeTool("call_write", "write", { filePath: "/home/tester/workspace/notes-app/notes/groceries.md", content: "milk" }, { output: "Wrote file" }),
			},
			{
				id: `prt_${sessionId}_a1_4b`,
				data: openCodeTool("call_bash", "bash", { command: "ls notes", description: "list notes" }, { error: "ls: notes: No such file or directory" }),
			},
			{ id: `prt_${sessionId}_a1_5f`, data: openCodeStepFinish() },
		],
	});
	db.addMessage(sessionId, {
		id: `msg_${sessionId}_a2`,
		timeCreated: T0 + 2000,
		data: openCodeAssistant(T0 + 2000, { parentId: `msg_${sessionId}_u1`, cost: 0.004, tokens: { input: 1200, output: 40 }, finish: "stop" }),
		parts: [{ id: `prt_${sessionId}_a2_t`, data: openCodeText("The note is saved.") }],
	});
}

type Row = Record<string, unknown>;

describe("OpenCode session sync", () => {
	it("indexes each OpenCode session as its own source", async () => {
		const { db, close } = await tempDb();
		const oc = openCodeRoot();
		try {
			writeBasicSession(oc.db);
			const result = await runSync(db, [new OpenCodeDbSource(oc.root)]);
			assert.deepEqual(result.errors, []);
			assert.equal(result.sessionsProcessed, 1);

			const session = (await db.prepare("SELECT * FROM sessions").get()) as Row;
			assert.equal(session["id"], "ses_basic");
			assert.equal(session["source"], "opencode");
			assert.equal(session["cwd"], "/home/tester/workspace/notes-app");
			assert.equal(session["project"], "notes-app");
			assert.equal(session["name"], "Add a groceries note");
			assert.equal(session["started_at"], new Date(T0).toISOString());
			assert.equal(session["parent_session"], null);
			assert.equal(session["tool_inventory"], null, "OpenCode records no tool manifest");
			// One request, two assistant steps, one row for the step's two tool results.
			assert.equal(session["message_count"], 4);
		} finally {
			oc.cleanup();
			await close();
		}
	});

	it("writes a turn as the request, its steps, and the results of each step's tools", async () => {
		const { db, close } = await tempDb();
		const oc = openCodeRoot();
		try {
			writeBasicSession(oc.db);
			await runSync(db, [new OpenCodeDbSource(oc.root)]);
			const rows = (await db.prepare("SELECT * FROM messages ORDER BY rowid").all()) as Row[];
			assert.deepEqual(
				rows.map((r) => r["role"]),
				["user", "assistant", "toolResult", "assistant"],
			);
			const [user, step, results, answer] = rows as [Row, Row, Row, Row];

			assert.equal(user["content_text"], "add a note titled groceries");
			assert.equal(user["timestamp"], new Date(T0).toISOString());

			assert.equal(step["id"], "msg_ses_basic_a1");
			assert.equal(step["parent_id"], "msg_ses_basic_u1");
			assert.equal(step["content_text"], "I will create the note.");
			assert.equal(step["content_thinking"], "The note goes in notes/groceries.md.");
			assert.equal(step["model"], "fixture-provider/fixture-model-1");
			assert.equal(step["cost_usd"], 0.0125);
			assert.equal(step["stop_reason"], "tool-calls");
			assert.equal(step["error_message"], null);
			// Reasoning tokens are billed as output, so they join that bucket.
			assert.deepEqual(JSON.parse(String(step["usage"])), {
				input: 900,
				output: 150,
				cacheRead: 400,
				cacheWrite: 50,
				totalTokens: 1050,
				cost: null,
			});
			// OpenCode's tool names already match the index's; `filePath` is
			// read where every analyzer looks for a path.
			assert.deepEqual(JSON.parse(String(step["tool_calls"])), [
				{
					id: "call_write",
					name: "write",
					arguments: {
						filePath: "/home/tester/workspace/notes-app/notes/groceries.md",
						content: "milk",
						path: "/home/tester/workspace/notes-app/notes/groceries.md",
					},
				},
				{ id: "call_bash", name: "bash", arguments: { command: "ls notes", description: "list notes" } },
			]);

			assert.deepEqual(JSON.parse(String(results["tool_results"])), [
				{ toolCallId: "call_write", toolName: "write", isError: false, textLength: "Wrote file".length },
				{
					toolCallId: "call_bash",
					toolName: "bash",
					isError: true,
					textLength: "ls: notes: No such file or directory".length,
					errorClass: "not_found",
				},
			]);
			assert.equal(results["content_text"], null, "result text is classified, never stored");

			assert.equal(answer["content_text"], "The note is saved.");
			assert.equal(answer["stop_reason"], "stop");
		} finally {
			oc.cleanup();
			await close();
		}
	});

	it("records a failed generation's error, and keeps synthetic and compaction parts out of the turn", async () => {
		const { db, close } = await tempDb();
		const oc = openCodeRoot();
		try {
			oc.db.addSession({ id: "ses_fail" });
			oc.db.addMessage("ses_fail", {
				id: "msg_fail_u1",
				timeCreated: T0,
				data: openCodeUser(T0),
				parts: [
					{ id: "prt_fail_u1_a", data: openCodeText("summarise the notes") },
					{ id: "prt_fail_u1_b", data: openCodeText("<system-reminder>plan mode</system-reminder>", { synthetic: true }) },
				],
			});
			oc.db.addMessage("ses_fail", {
				id: "msg_fail_a1",
				timeCreated: T0 + 1000,
				data: openCodeAssistant(T0 + 1000, {
					parentId: "msg_fail_u1",
					error: { name: "APIError", data: { message: "Overloaded", isRetryable: true } },
				}),
				parts: [],
			});
			oc.db.addMessage("ses_fail", {
				id: "msg_fail_u2",
				timeCreated: T0 + 2000,
				data: openCodeUser(T0 + 2000),
				parts: [{ id: "prt_fail_u2", data: { type: "compaction", auto: true } }],
			});
			oc.db.addMessage("ses_fail", {
				id: "msg_fail_a2",
				timeCreated: T0 + 3000,
				data: openCodeAssistant(T0 + 3000, { parentId: "msg_fail_u2", summary: true, finish: "stop" }),
				parts: [{ id: "prt_fail_a2", data: openCodeText("Summary: the user keeps notes.") }],
			});
			await runSync(db, [new OpenCodeDbSource(oc.root)]);
			const rows = (await db.prepare("SELECT id, role, content_text, stop_reason, error_message FROM messages ORDER BY rowid").all()) as Row[];
			assert.deepEqual(rows, [
				{ id: "msg_fail_u1", role: "user", content_text: "summarise the notes", stop_reason: null, error_message: null },
				{ id: "msg_fail_a1", role: "assistant", content_text: null, stop_reason: "error", error_message: "Overloaded" },
				// The compaction request and its summary are one context-management
				// entry, never a turn boundary.
				{ id: "msg_fail_a2", role: "compactionSummary", content_text: "Summary: the user keeps notes.", stop_reason: null, error_message: null },
			]);
		} finally {
			oc.cleanup();
			await close();
		}
	});

	it("records an aborted generation as aborted", async () => {
		const { db, close } = await tempDb();
		const oc = openCodeRoot();
		try {
			oc.db.addSession({ id: "ses_abort" });
			oc.db.addMessage("ses_abort", {
				id: "msg_abort_u1",
				timeCreated: T0,
				data: openCodeUser(T0),
				parts: [{ id: "prt_abort_u1", data: openCodeText("run the tests") }],
			});
			oc.db.addMessage("ses_abort", {
				id: "msg_abort_a1",
				timeCreated: T0 + 1000,
				data: openCodeAssistant(T0 + 1000, {
					parentId: "msg_abort_u1",
					error: { name: "MessageAbortedError", data: { message: "Aborted" } },
				}),
				parts: [],
			});
			await runSync(db, [new OpenCodeDbSource(oc.root)]);
			const row = (await db.prepare("SELECT stop_reason, error_message FROM messages WHERE id = 'msg_abort_a1'").get()) as Row;
			assert.deepEqual(row, { stop_reason: "aborted", error_message: "Aborted" });
		} finally {
			oc.cleanup();
			await close();
		}
	});

	it("attaches a child session to the session that spawned it", async () => {
		const { db, close } = await tempDb();
		const oc = openCodeRoot();
		try {
			writeBasicSession(oc.db, "ses_parent");
			oc.db.addSession({ id: "ses_child", parentId: "ses_parent", title: "Child session" });
			oc.db.addMessage("ses_child", {
				id: "msg_child_u1",
				timeCreated: T0,
				data: openCodeUser(T0),
				parts: [{ id: "prt_child_u1", data: openCodeText("find the notes directory") }],
			});
			await runSync(db, [new OpenCodeDbSource(oc.root)]);
			const child = (await db.prepare("SELECT parent_session FROM sessions WHERE id = 'ses_child'").get()) as Row;
			assert.equal(child["parent_session"], "ses_parent");
		} finally {
			oc.cleanup();
			await close();
		}
	});

	it("skips an unchanged session and indexes only what a session added", async () => {
		const { db, close } = await tempDb();
		const oc = openCodeRoot();
		try {
			writeBasicSession(oc.db, "ses_a");
			writeBasicSession(oc.db, "ses_b");
			const source = new OpenCodeDbSource(oc.root);
			const first = await runSync(db, [source]);
			assert.equal(first.sessionsProcessed, 2);

			const second = await runSync(db, [source]);
			assert.equal(second.sessionsProcessed, 0);
			assert.equal(second.sessionsSkipped, 2);
			assert.equal(second.messagesInserted, 0);

			// A new message in one session. The session row's own update time
			// does not move: OpenCode moves it on a prompt, not on a reply.
			oc.db.addMessage("ses_a", {
				id: "msg_ses_a_u2",
				timeCreated: T0 + 9000,
				data: openCodeUser(T0 + 9000),
				parts: [{ id: "prt_ses_a_u2", data: openCodeText("now add eggs") }],
			});
			const third = await runSync(db, [source]);
			assert.deepEqual(third.errors, []);
			assert.equal(third.sessionsProcessed, 1);
			assert.equal(third.sessionsSkipped, 1);
			assert.equal(third.messagesInserted, 1, "only the new request is inserted");
			const count = (await db.prepare("SELECT message_count FROM sessions WHERE id = 'ses_a'").get()) as Row;
			assert.equal(count["message_count"], 5);
		} finally {
			oc.cleanup();
			await close();
		}
	});

	it("indexes a step's results once they settle, even when the step was read while its tools ran", async () => {
		const { db, close } = await tempDb();
		const oc = openCodeRoot();
		try {
			oc.db.addSession({ id: "ses_live", timeUpdated: T0 + 1000 });
			oc.db.addMessage("ses_live", {
				id: "msg_live_u1",
				timeCreated: T0,
				data: openCodeUser(T0),
				parts: [{ id: "prt_live_u1", data: openCodeText("build the app") }],
			});
			oc.db.addMessage("ses_live", {
				id: "msg_live_a1",
				timeCreated: T0 + 1000,
				data: openCodeAssistant(T0 + 1000, { parentId: "msg_live_u1", completed: null }),
				parts: [{ id: "prt_live_a1", data: openCodeTool("call_build", "bash", { command: "npm run build" }, { pending: true }) }],
			});
			const source = new OpenCodeDbSource(oc.root);
			await runSync(db, [source]);
			let roles = (await db.prepare("SELECT role FROM messages ORDER BY rowid").all()) as Row[];
			assert.deepEqual(roles.map((r) => r["role"]), ["user"], "a step still streaming is not indexed yet");

			oc.db.updatePart(
				"prt_live_a1",
				openCodeTool("call_build", "bash", { command: "npm run build" }, { output: "built in 2s" }),
				T0 + 4000,
			);
			oc.db.updateMessage(
				"msg_live_a1",
				openCodeAssistant(T0 + 1000, { parentId: "msg_live_u1", completed: T0 + 4000, finish: "tool-calls" }),
				T0 + 4000,
			);
			await runSync(db, [source]);
			roles = (await db.prepare("SELECT role FROM messages ORDER BY rowid").all()) as Row[];
			assert.deepEqual(roles.map((r) => r["role"]), ["user", "assistant", "toolResult"]);
		} finally {
			oc.cleanup();
			await close();
		}
	});

	it("discovers nothing when there is no OpenCode database, or one without the session tables", async () => {
		const { root, cleanup } = makeTempRoot("prospect-opencode-empty-");
		try {
			assert.deepEqual(await new OpenCodeDbSource(path.join(root, "missing")).discover(), []);
			fs.writeFileSync(path.join(root, "opencode.json"), "{}");
			openCodeDbWithoutMessages(path.join(root, "opencode.db"));
			assert.deepEqual(await new OpenCodeDbSource(root).discover(), []);
		} finally {
			cleanup();
		}
	});
});
