import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { codexFormatOf, parseCodexLine, codexToolName } from "../../src/sync/codex-parser.js";
import {
	codexCustomToolCallLine,
	codexFunctionCallLine,
	codexFunctionCallOutputLine,
	codexMessageLine,
	codexReasoningLine,
	codexTurnContextLine,
	codexUsageRecordLine,
} from "../fixtures/codex-rollout.js";

/**
 * The Codex line parser, one line at a time.
 *
 * The parser is the only place that knows Codex's own vocabulary, so these
 * tests pin that vocabulary: which lines carry a message, which carry a tool
 * call, which carry the usage of a generation.
 */
describe("parseCodexLine", () => {
	it("reads a user message as a user turn", () => {
		const parsed = parseCodexLine(
			codexMessageLine("user", "add a note", { kinds: ["user.text"], turnId: "turn-1" }),
			"2026-03-04T09:15:02.000Z",
		);
		assert.ok(parsed);
		assert.equal(parsed.kind, "message");
		assert.equal(parsed.entry.role, "user");
		assert.equal(parsed.entry.text, "add a note");
		assert.equal(parsed.entry.timestamp, "2026-03-04T09:15:02.000Z");
		assert.equal(parsed.entry.turnId, "turn-1");
	});

	it("does not read the host's own context as a user turn", () => {
		// Codex writes the repository's AGENTS.md body into the transcript as a
		// user message. Treating it as a human turn would open a turn on the
		// host's own instructions, so the parser does not index it at all.
		for (const kinds of [
			["agents_md.instructions", "environments.environment_context"],
			["environments.environment_context"],
			["multi_agent.subagent_notification"],
			["generic.turn_aborted"],
		]) {
			const parsed = parseCodexLine(codexMessageLine("user", "<environment_context>…", { kinds }), "2026-03-04T09:15:02.000Z");
			assert.equal(parsed, null, `${kinds.join(",")} must not become a message row`);
		}
	});

	it("reads a context block of the older rollout format as host context too", () => {
		// The older format records no content kinds, so the text's own shape is
		// the only evidence that a message is the host's context.
		for (const opening of [
			"# AGENTS.md instructions for /home/tester/workspace/notes-app",
			"<environment_context>\n  <cwd>/home/tester</cwd>",
			"<command-name>/clear</command-name>",
		]) {
			const parsed = parseCodexLine(codexMessageLine("user", opening), "2026-03-04T09:15:02.000Z");
			assert.equal(parsed, null, `${opening.slice(0, 20)} must not become a message row`);
		}
	});

	it("reads an assistant message as an assistant turn", () => {
		const parsed = parseCodexLine(codexMessageLine("assistant", "done", { turnId: "turn-1" }), "2026-03-04T09:15:02.000Z");
		assert.ok(parsed);
		assert.equal(parsed.kind, "message");
		assert.equal(parsed.entry.role, "assistant");
		assert.equal(parsed.entry.text, "done");
	});

	it("reads reasoning as assistant thinking rather than assistant text", () => {
		const parsed = parseCodexLine(codexReasoningLine("the user wants a note", "turn-1"), "2026-03-04T09:15:03.000Z");
		assert.ok(parsed);
		assert.equal(parsed.kind, "message");
		assert.equal(parsed.entry.role, "assistant");
		assert.equal(parsed.entry.text, null);
		assert.equal(parsed.entry.thinking, "the user wants a note");
	});

	it("reads a function call as a tool call, with its arguments parsed", () => {
		const parsed = parseCodexLine(
			codexFunctionCallLine("exec_command", "call-1", { cmd: "ls -la", workdir: "/tmp" }, "turn-1"),
			"2026-03-04T09:15:04.000Z",
		);
		assert.ok(parsed);
		assert.equal(parsed.kind, "tool-call");
		assert.equal(parsed.entry.name, "exec_command");
		assert.equal(parsed.entry.callId, "call-1");
		assert.deepEqual(parsed.entry.arguments, { cmd: "ls -la", workdir: "/tmp" });
		assert.equal(parsed.entry.turnId, "turn-1");
	});

	it("reads a custom tool call, whose input is a plain string", () => {
		const parsed = parseCodexLine(
			codexCustomToolCallLine("apply_patch", "call-2", "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch", "turn-1"),
			"2026-03-04T09:15:04.000Z",
		);
		assert.ok(parsed);
		assert.equal(parsed.kind, "tool-call");
		assert.equal(parsed.entry.name, "apply_patch");
		assert.equal(parsed.entry.callId, "call-2");
		assert.deepEqual(parsed.entry.arguments, { input: "*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch" });
	});

	it("reads a function call output as a tool result", () => {
		const parsed = parseCodexLine(
			codexFunctionCallOutputLine("call-1", "total 8\n", "turn-1"),
			"2026-03-04T09:15:05.000Z",
		);
		assert.ok(parsed);
		assert.equal(parsed.kind, "tool-result");
		assert.equal(parsed.entry.callId, "call-1");
		assert.equal(parsed.entry.text, "total 8\n");
		assert.equal(parsed.entry.timestamp, "2026-03-04T09:15:05.000Z");
	});

	it("reads a token usage record as the per-call usage of a generation", () => {
		const parsed = parseCodexLine(
			codexUsageRecordLine("turn-1", "resp-1", {
				input: 500,
				output: 60,
				cachedInput: 100,
				cacheWrite: 40,
			}),
			"2026-03-04T09:15:06.000Z",
		);
		assert.ok(parsed);
		assert.equal(parsed.kind, "usage");
		assert.equal(parsed.entry.turnId, "turn-1");
		// The cumulative turn bucket must not be folded into the per-call one:
		// summing both would bill every generation twice.
		assert.equal(parsed.entry.usage.input, 500);
		assert.equal(parsed.entry.usage.output, 60);
		assert.equal(parsed.entry.usage.cacheRead, 100);
		assert.equal(parsed.entry.usage.cacheWrite, 40);
		assert.equal(parsed.entry.usage.totalTokens, 560);
	});

	it("reads a turn context as the model serving the turn", () => {
		const parsed = parseCodexLine(codexTurnContextLine("turn-1", "gpt-5-codex"), "2026-03-04T09:15:01.000Z");
		assert.ok(parsed);
		assert.equal(parsed.kind, "model");
		assert.equal(parsed.entry.turnId, "turn-1");
		assert.equal(parsed.entry.model, "gpt-5-codex");
	});

	it("reads an item_completed event as the older format's transcript", () => {
		// The older rollout format records the conversation in events rather
		// than in response items, and its items carry the full text.
		const event = JSON.stringify({
			type: "event_msg",
			timestamp: "2026-03-04T09:15:07.000Z",
			payload: {
				type: "item_completed",
				turn_id: "turn-1",
				item: { type: "AgentMessage", id: "msg-1", content: [{ type: "Text", text: "The note is written." }] },
			},
		});
		const parsed = parseCodexLine(event, "2026-03-04T09:15:07.000Z", "older");
		assert.ok(parsed);
		assert.equal(parsed.kind, "message");
		assert.equal(parsed.entry.role, "assistant");
		assert.equal(parsed.entry.text, "The note is written.");
		assert.equal(parsed.entry.turnId, "turn-1");
	});

	it("reads an item_completed event in the current format too, for the command it records", () => {
		// The current format's events duplicate the items, but the command
		// execution event carries the exit code the result text may not.
		const event = JSON.stringify({
			type: "event_msg",
			timestamp: "2026-03-04T09:15:07.000Z",
			payload: {
				type: "item_completed",
				turn_id: "turn-1",
				item: { type: "CommandExecution", id: "cmd-1", command: "ls", exit_code: 0, aggregated_output: "a\nb\n" },
			},
		});
		const parsed = parseCodexLine(event, "2026-03-04T09:15:07.000Z", "current");
		assert.ok(parsed);
		assert.equal(parsed.kind, "command");
		assert.equal(parsed.entry.callId, "cmd-1");
		assert.equal(parsed.entry.command, "ls");
		assert.equal(parsed.entry.exitCode, 0);
	});

	it("reads a turn_aborted event as the host's verdict on the turn", () => {
		const event = JSON.stringify({
			type: "event_msg",
			timestamp: "2026-03-04T09:15:08.000Z",
			payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" },
		});
		const parsed = parseCodexLine(event, "2026-03-04T09:15:08.000Z");
		assert.ok(parsed);
		assert.equal(parsed.kind, "aborted");
		assert.equal(parsed.entry.turnId, "turn-1");
	});

	it("ignores a line it does not own", () => {
		for (const line of [
			JSON.stringify({ type: "world_state", payload: { state: {} } }),
			JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {} } }),
			JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "AgentMessage" } } }),
			"not json at all",
			"",
		]) {
			assert.equal(parseCodexLine(line, "2026-03-04T09:15:00.000Z"), null);
		}
	});
});

describe("codexToolName", () => {
	it("names a tool the way the rest of the index names tools", () => {
		assert.equal(codexToolName("exec_command"), "bash");
		assert.equal(codexToolName("shell"), "bash");
		assert.equal(codexToolName("apply_patch"), "edit");
		assert.equal(codexToolName("read_file"), "read");
		assert.equal(codexToolName("list_dir"), "glob");
		assert.equal(codexToolName("grep"), "grep");
	});

	it("keeps an unknown tool's own name", () => {
		assert.equal(codexToolName("view_image"), "view_image");
		assert.equal(codexToolName("spawn_agent"), "spawn_agent");
	});
});

describe("codexFormatOf", () => {
	it("recognises the current format by the turn stamp on its items", () => {
		const lines = [
			JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
			JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
			JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5-codex" } }),
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: "hello" }],
					internal_chat_message_metadata_passthrough: { turn_id: "t1", content_item_kinds: ["user.text"] },
				},
			}),
		];
		assert.equal(codexFormatOf(lines), "current");
	});

	it("recognises the older format, whose items carry no turn stamp", () => {
		const lines = [
			JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
			JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
			JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5-codex" } }),
			JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } }),
		];
		assert.equal(codexFormatOf(lines), "older");
	});
});
