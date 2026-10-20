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

	it("reads the agent's own words and thoughts as assistant rows", () => {
		// The model's words and its private thinking are two kinds of assistant
		// row: the words are the answer, the thinking is the reasoning.
		const cases = [
			{ what: "the answer", line: codexMessageLine("assistant", "done", { turnId: "turn-1" }), text: "done", thinking: null },
			{ what: "the reasoning", line: codexReasoningLine("the user wants a note", "turn-1"), text: null, thinking: "the user wants a note" },
		];
		for (const c of cases) {
			const parsed = parseCodexLine(c.line, "2026-03-04T09:15:02.000Z");
			assert.ok(parsed, `${c.what} parses`);
			assert.equal(parsed.kind, "message");
			assert.equal(parsed.entry.role, "assistant");
			assert.equal(parsed.entry.text, c.text);
			assert.equal(parsed.entry.thinking, c.thinking);
		}
	});

	it("reads a tool call and its result, whatever kind of call it is", () => {
		// A `function_call` writes its arguments as a JSON string; a
		// `custom_tool_call` writes its input as a plain string. Both are tool
		// calls, and a result is a result.
		const calls = [
			{ what: "a function call", line: codexFunctionCallLine("exec_command", "call-1", { cmd: "ls -la" }, "turn-1"), name: "exec_command", arguments: { cmd: "ls -la" } },
			{ what: "a custom tool call", line: codexCustomToolCallLine("apply_patch", "call-2", "*** Begin Patch", "turn-1"), name: "apply_patch", arguments: { input: "*** Begin Patch" } },
		];
		for (const c of calls) {
			const parsed = parseCodexLine(c.line, "2026-03-04T09:15:04.000Z");
			assert.ok(parsed, `${c.what} parses`);
			assert.equal(parsed.kind, "tool-call");
			assert.equal(parsed.entry.name, c.name);
			assert.deepEqual(parsed.entry.arguments, c.arguments);
			assert.equal(parsed.entry.turnId, "turn-1");
		}

		const result = parseCodexLine(codexFunctionCallOutputLine("call-1", "total 8\n", "turn-1"), "2026-03-04T09:15:05.000Z");
		assert.ok(result);
		assert.equal(result.kind, "tool-result");
		assert.equal(result.entry.callId, "call-1");
		assert.equal(result.entry.text, "total 8\n");
		assert.equal(result.entry.timestamp, "2026-03-04T09:15:05.000Z");
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

	it("reads an event the host wrote, whatever the event is", () => {
		// The older format's events carry the conversation; the current
		// format's events carry the command's exit code; an abort event says
		// the host gave up on a turn.
		const cases = [
			{
				what: "a message in the older format",
				format: "older" as const,
				payload: {
					type: "item_completed",
					turn_id: "turn-1",
					item: { type: "AgentMessage", id: "msg-1", content: [{ type: "Text", text: "The note is written." }] },
				},
				kind: "message",
			},
			{
				what: "a command in the current format",
				format: "current" as const,
				payload: {
					type: "item_completed",
					turn_id: "turn-1",
					item: { type: "CommandExecution", id: "cmd-1", command: "ls", exit_code: 0, aggregated_output: "a\nb\n" },
				},
				kind: "command",
			},
			{
				what: "an abandoned turn",
				format: "current" as const,
				payload: { type: "turn_aborted", turn_id: "turn-1", reason: "interrupted" },
				kind: "aborted",
			},
		];
		for (const c of cases) {
			const event = JSON.stringify({
				type: "event_msg",
				timestamp: "2026-03-04T09:15:07.000Z",
				payload: c.payload,
			});
			const parsed = parseCodexLine(event, "2026-03-04T09:15:07.000Z", c.format);
			assert.ok(parsed, `${c.what} parses`);
			assert.equal(parsed.kind, c.kind);
			assert.equal(parsed.entry.turnId, "turn-1");
			if (c.kind === "message") {
				assert.equal(parsed.entry.role, "assistant");
				assert.equal(parsed.entry.text, "The note is written.");
			} else if (c.kind === "command") {
				assert.equal(parsed.entry.callId, "cmd-1");
				assert.equal(parsed.entry.command, "ls");
				assert.equal(parsed.entry.exitCode, 0);
			}
		}
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
	it("recognises the format by the turn stamp on the items", () => {
		// The current format stamps every item with its turn; the older one
		// stamps nothing, and records the conversation in events instead.
		const stamp = { turn_id: "t1", content_item_kinds: ["user.text"] };
		const cases = [
			{
				format: "current" as const,
				item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }], internal_chat_message_metadata_passthrough: stamp },
			},
			{
				format: "older" as const,
				item: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			},
		];
		for (const c of cases) {
			const lines = [
				JSON.stringify({ type: "session_meta", payload: { id: "s1" } }),
				JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
				JSON.stringify({ type: "turn_context", payload: { turn_id: "t1", model: "gpt-5-codex" } }),
				JSON.stringify({ type: "response_item", payload: c.item }),
			];
			assert.equal(codexFormatOf(lines), c.format);
		}
	});
});
