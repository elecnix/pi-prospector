/**
 * PiRpcSource — discovery, ingest through the real sync loop, identity, and
 * error accounting for the pi-rpc RPC event-stream transcripts (#263).
 *
 * Fixtures are hand-written synthetic out.jsonl lines shaped like the real
 * streams (extension_ui_request transport, message_end turns), with no real
 * session content. Exercises: discovery under <root>/<name>/out.jsonl,
 * message-row mapping through sync, cursor-based incremental skip, harness
 * scoping, and the empty/no-message error path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { PiRpcSource } from "../../src/sync/sources/pi-rpc.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { tempDb } from "./helpers.js";

function makeRoot(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-pi-rpc-"));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const UI = JSON.stringify({ type: "extension_ui_request", id: "u1", method: "setStatus", statusKey: "k" });

function rpcTranscript(frames: string[]): string {
	return [UI, ...frames].join("\n") + "\n";
}

function userEnd(text: string, ts = 1787594580235): string {
	return JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp: ts } });
}

function assistantEnd(text: string, ts = 1787594580900): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "ollama/deepseek-v4:0731-cloud",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: ts,
		},
	});
}

describe("PiRpcSource", () => {
	it("discovers <dir>/out.jsonl files and ingests message_end turns with a stable session id", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		try {
			fs.mkdirSync(path.join(fx.root, "pi-rpc", "agent-alpha"), { recursive: true });
			fs.writeFileSync(path.join(fx.root, "pi-rpc", "agent-alpha", "out.jsonl"), rpcTranscript([userEnd("run the checks"), assistantEnd("done")]));
			// A nested stray file must not be discovered: only <dir>/out.jsonl belongs to this source.
			fs.mkdirSync(path.join(fx.root, "pi-rpc", "agent-alpha", "nested"), { recursive: true });
			fs.writeFileSync(path.join(fx.root, "pi-rpc", "agent-alpha", "nested", "out.jsonl"), rpcTranscript([userEnd("decoy")]));

			const result = await runSync(db, [new PiRpcSource(fx.root)]);
			assert.equal(result.sessionsProcessed, 1);
			assert.equal(result.errors.length, 0);

			const sessions = (await db.prepare("SELECT id, source, name, project, parent_session, cwd, tool_inventory FROM sessions").all()) as Array<{
				id: string; source: string; name: string | null; project: string; parent_session: string | null; cwd: string; tool_inventory: string | null;
			}>;
			assert.equal(sessions.length, 1);
			assert.equal(sessions[0]!.id, "pi-rpc/agent-alpha");
			assert.equal(sessions[0]!.source, "pi-rpc");
			assert.equal(sessions[0]!.name, "agent-alpha");
			assert.equal(sessions[0]!.project, "pi-rpc");
			assert.equal(sessions[0]!.parent_session, null);
			assert.equal(sessions[0]!.cwd, "");
			// No tool manifest exists in the RPC stream: UNKNOWN, never empty.
			assert.equal(sessions[0]!.tool_inventory, null);

			const msgs = (await db.prepare("SELECT id, role, content_text, source FROM messages ORDER BY rowid").all()) as Array<{
				id: string; role: string; content_text: string | null; source: string;
			}>;
			assert.deepEqual(msgs, [
				{ id: "pi-rpc:agent-alpha:L2", role: "user", content_text: "run the checks", source: "pi-rpc" },
				{ id: "pi-rpc:agent-alpha:L3", role: "assistant", content_text: "done", source: "pi-rpc" },
			]);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("tool calls carry pi argument names and toolResults land as toolResult rows", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		try {
			fs.mkdirSync(path.join(fx.root, "pi-rpc", "agent-beta"), { recursive: true });
			const toolCall = JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_9", name: "read", arguments: { path: "/tmp/x.md" } }],
					model: "m", usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } }, stopReason: "toolUse", timestamp: 1787594580361,
				},
			});
			const toolResult = JSON.stringify({
				type: "message_end",
				message: { role: "toolResult", toolCallId: "call_9", toolName: "read", content: [{ type: "text", text: "body" }], isError: false, timestamp: 1787594580400 },
			});
			fs.writeFileSync(path.join(fx.root, "pi-rpc", "agent-beta", "out.jsonl"), rpcTranscript([userEnd("go"), toolCall, toolResult]));

			const result = await runSync(db, [new PiRpcSource(fx.root)]);
			assert.equal(result.errors.length, 0);
			const msgs = (await db.prepare("SELECT role, tool_calls, tool_results FROM messages WHERE role != 'user' ORDER BY rowid").all()) as Array<{
				role: string; tool_calls: string | null; tool_results: string | null;
			}>;
			assert.equal(msgs.length, 2);
			assert.deepEqual(JSON.parse(msgs[0]!.tool_calls!), [{ id: "call_9", name: "read", arguments: { path: "/tmp/x.md" } }]);
			assert.deepEqual(JSON.parse(msgs[1]!.tool_results!), [{ toolCallId: "call_9", toolName: "read", isError: false, textLength: 4 }]);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("re-sync skips unchanged transcripts (cursor contract)", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		try {
			fs.mkdirSync(path.join(fx.root, "pi-rpc", "agent-alpha"), { recursive: true });
			fs.writeFileSync(path.join(fx.root, "pi-rpc", "agent-alpha", "out.jsonl"), rpcTranscript([userEnd("go")]));
			await runSync(db, [new PiRpcSource(fx.root)]);

			const result2 = await runSync(db, [new PiRpcSource(fx.root)]);
			assert.equal(result2.sessionsProcessed, 0);
			assert.equal(result2.sessionsSkipped, 1);

			// A resume-safe reparse at line 0 yields the same message ids: identity
			// comes from the directory name + line number, not a frame id.
			const rows = (await db.prepare("SELECT id FROM messages ORDER BY rowid").all()) as Array<{ id: string }>;
			assert.deepEqual(rows, [{ id: "pi-rpc:agent-alpha:L2" }]);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("an --source claude scope selects nothing; mixed adapters stay segmented", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		try {
			fs.mkdirSync(path.join(fx.root, "pi-rpc", "agent-alpha"), { recursive: true });
			fs.writeFileSync(path.join(fx.root, "pi-rpc", "agent-alpha", "out.jsonl"), rpcTranscript([userEnd("go")]));

			const scoped = await runSync(
				db,
				[new PiFileSource(fx.root), new ClaudeFileSource(fx.root), new PiRpcSource(fx.root)],
				{ source: "claude" },
			);
			assert.equal(scoped.sessionsProcessed, 0);

			const unscoped = await runSync(db, [new PiRpcSource(fx.root)]);
			assert.equal(unscoped.sessionsProcessed, 1);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("a transcript with no message frames (transport only, or empty) reports an error and ingests nothing", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		try {
			fs.mkdirSync(path.join(fx.root, "pi-rpc", "agent-empty"), { recursive: true });
			fs.writeFileSync(path.join(fx.root, "pi-rpc", "agent-empty", "out.jsonl"), "");
			fs.mkdirSync(path.join(fx.root, "pi-rpc", "agent-ui-only"), { recursive: true });
			fs.writeFileSync(path.join(fx.root, "pi-rpc", "agent-ui-only", "out.jsonl"), rpcTranscript([]));

			const result = await runSync(db, [new PiRpcSource(fx.root)]);
			assert.equal(result.sessionsProcessed, 0);
			assert.equal(result.errors.length, 2);
			assert.ok(result.errors[0]!.includes("no message frames"));
		} finally {
			fx.cleanup();
			await close();
		}
	});
});
