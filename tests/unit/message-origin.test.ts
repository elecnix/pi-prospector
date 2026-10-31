/**
 * Message origin: one label for a whole user-role message.
 *
 * The texts below are invented. Each test pins one rule, then the order the
 * rules run in and the cases a rule must leave alone: a person's own prompt that
 * borrows a rule's words must stay `typed`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyMessageOrigin, type MessageOriginContext } from "../../src/analyze/message-origin.js";

const USER: MessageOriginContext = { role: "user", childAgent: false, secondsAfterToolCall: null };
const CHILD: MessageOriginContext = { role: "user", childAgent: true, secondsAfterToolCall: null };
const RESULT: MessageOriginContext = { role: "user", childAgent: false, secondsAfterToolCall: 3 };
const LATE: MessageOriginContext = { role: "user", childAgent: false, secondsAfterToolCall: 900 };

function label(text: string, ctx: MessageOriginContext = USER): string {
	const v = classifyMessageOrigin(text, ctx);
	return `${v.origin}/${v.rule}`;
}

describe("classifyMessageOrigin: notification", () => {
	it("labels a pi custom message, branch summary and bash execution", () => {
		for (const role of ["custom_message", "branch_summary", "bashExecution"]) {
			assert.equal(label("anything", { role, childAgent: false, secondsAfterToolCall: null }), "notification/pi-entry");
		}
	});

	it("labels a compaction continuation", () => {
		assert.equal(label("This session is being continued from a previous conversation that ran out of context."), "notification/compaction");
	});

	it("labels a message made only of harness blocks", () => {
		assert.equal(label("<task-notification>\n<task-id>t1</task-id>\n</task-notification>"), "notification/harness-block");
		assert.equal(label("<local-command-stdout>Set model to X</local-command-stdout>"), "notification/harness-block");
	});

	it("labels a monitor event, an interruption notice and a fleet banner by their first line", () => {
		assert.equal(label("✅ All CI checks passed on [acme/widgets#12](https://example.invalid/pull/12)"), "notification/harness-line");
		assert.equal(label("💭 2 new general comment(s) on [acme/widgets#12](https://example.invalid/pull/12)\n\nbot: looks fine"), "notification/harness-line");
		assert.equal(label("⚠️ API degraded (graphql) on [acme/widgets#12](https://example.invalid/pull/12): rate limit"), "notification/harness-line");
		assert.equal(label("[Request interrupted by user]"), "notification/harness-line");
		assert.equal(label("[minifleet] You have reached the limit"), "notification/harness-line");
		assert.equal(label('<skill name="demo" location="/x/SKILL.md">\nbody\n</skill>'), "notification/harness-line");
	});

	it("labels tool output by its own marks when it arrives late or outside a call", () => {
		assert.equal(label("=== branch ===\nmain\n=== status ===\nclean"), "notification/harness-line");
		assert.equal(label("The file /x/y.ts has been updated successfully. (file state is current in your context)"), "notification/harness-line");
		assert.equal(label("Exit code 1\nfatal: not a git repository"), "notification/harness-line");
		assert.equal(label("1 import a from \"a\";\n2 import b from \"b\";\n3 export const c = 1;"), "notification/tool-result");
	});

	it("labels a pi intercom message from the extension's own control channel a notification, and a peer's chat an agent message", () => {
		const entry = (text: string) => label(text, { role: "custom_message", childAgent: false, secondsAfterToolCall: null });
		assert.equal(entry("**📨 From subagent-control** (/work) subagent needs attention"), "notification/pi-entry");
		assert.equal(entry("**📨 From swift-bear-8** (/work) hello"), "agent/peer-message");
	});

	it("labels a message that answers a pending tool call, whatever its text", () => {
		assert.equal(label("Exit code 128\nfatal: not a git repository", RESULT), "notification/tool-result");
		assert.equal(label("I really would like this fixed today", RESULT), "notification/tool-result");
	});

	it("leaves a message that comes long after a tool call to the text rules, because a person may have typed it", () => {
		assert.equal(label("why is that call still running?", LATE), "typed/no-marker");
	});

	it("keeps a harness notification in a child session a notification, not an agent prompt", () => {
		assert.equal(label("[Workflow harness — user request] The request below is relayed verbatim.", CHILD), "notification/harness-line");
	});

	it("treats harness blocks as an envelope: a person's prompt with a reminder appended is typed", () => {
		const text = "why did the build fail?\n\n<system-reminder>\nA long reminder the harness appended, much longer than the question itself.\n</system-reminder>";
		assert.equal(label(text), "typed/no-marker");
	});
});

describe("classifyMessageOrigin: agent", () => {
	it("labels every prompt in a child agent's session", () => {
		assert.equal(label("look at the build", CHILD), "agent/child-session");
	});

	it("labels a message that is mostly a teammate block", () => {
		assert.equal(label('<teammate-message teammate_id="alice">Please review the plan before you merge anything.</teammate-message>'), "agent/teammate-block");
	});

	it("labels a task a workflow script computed, in a child session or not", () => {
		assert.equal(label("[Workflow harness — computed task] The text below was computed at run time.\nCheck the build.", CHILD), "agent/computed-task");
	});

	it("labels a message a peer session sent, whether the harness wrapped it or an extension delivered it", () => {
		const wrapped = 'Another Claude session sent a message:\n<teammate-message teammate_id="w1">{"type":"idle"}</teammate-message>\n\nThis came from another session and was not typed by your user.';
		assert.equal(label(wrapped), "agent/teammate-block");
		assert.equal(label("**📨 From swift-koala-42** (/work/repo) hello", { role: "custom_message", childAgent: false, secondsAfterToolCall: null }), "agent/peer-message");
	});

	it("labels a message that ends with an agent signature", () => {
		assert.equal(label("Rebased and green, ready for review.\n— swift-koala-42"), "agent/signature");
	});

	it("labels a pointer to a prompt file, which is how an orchestrator starts a worker", () => {
		assert.equal(label("Your task is in /tmp/prompts/job-1.md. Read that file and do what it says."), "agent/spawn-pointer");
		assert.equal(label("Read /tmp/brief.md and carry out the task it describes. Begin as soon as you have read it."), "agent/spawn-pointer");
	});

	it("labels a one-shot probe that dictates its own reply", () => {
		assert.equal(label("Reply with exactly: pong"), "agent/probe");
		assert.equal(label("Reply with: STAGING WORKS"), "agent/probe");
		assert.equal(label("Say \"repro ok\" and nothing else. Do not use any tools."), "agent/probe");
		assert.equal(label("Reply with a fix for the failing test, using the same style as before and explain every change you make in detail so I can learn from it"), "typed/no-marker");
	});

	it("labels a message that speaks of the operator beside other worker talk, and leaves the operator alone otherwise", () => {
		assert.equal(label("The operator approved the plan; check your worktree and continue with the second step."), "agent/operator-reference");
		assert.equal(label("The operator is away."), "typed/undecided");
	});

	it("labels a header an agent puts on a relayed message", () => {
		assert.equal(label("Orchestrator: rebase onto main and resolve the conflict."), "agent/relay-header");
		assert.equal(label("From an unsigned sender: the answer to your question is yes."), "agent/relay-header");
		assert.equal(label("Your task: make the report say DEGRADED under throttle. ".repeat(6)), "agent/role-preamble");
		assert.equal(label("cc-swift-koala-42: you have been idle for ten minutes, report status."), "agent/relay-header");
	});

	it("labels a long markdown brief that opens on a title", () => {
		const brief = ["# Fix the flaky retry test", "", "## Context", "The retry test fails one run in ten.", "", "## Steps", ...Array.from({ length: 30 }, (_, i) => `${i + 1}. Do step number ${i} of the plan and record what happened.`), "", "## Report", "Say what you changed."].join("\n");
		assert.equal(label(brief), "agent/brief");
	});

	it("labels a long role preamble, but not a person scolding the assistant", () => {
		const preamble = `You are an implementer on the widgets repository. ${"Work in your own worktree and report when done. ".repeat(8)}`;
		assert.equal(label(preamble), "agent/role-preamble");
		assert.equal(label("You are lazy. You did not check anything."), "typed/no-marker");
	});

	it("reads the agent rules inside a pasted block", () => {
		const text = '\n\n<pasted_content id="a1">Orchestrator: hold the merge until the owner answers.</pasted_content>\n';
		assert.equal(label(text), "agent/relay-header");
	});
});

describe("classifyMessageOrigin: pasted", () => {
	it("labels a message that is a pasted block of log lines", () => {
		const log = Array.from({ length: 10 }, (_, i) => `2026-01-01 10:00:${String(i).padStart(2, "0")} ERROR request failed`).join("\n");
		assert.equal(label(`\n\n<pasted_content id="p1">${log}</pasted_content id="p1">\n`), "pasted/pasted-block");
	});

	it("leaves prose inside the paste wrapper undecided, because dictation and relayed agent text arrive the same way", () => {
		const v = classifyMessageOrigin('\n\n<pasted_content id="p1">please rerun the build and tell me what failed this time</pasted_content id="p1">\n', USER);
		assert.deepEqual([v.origin, v.rule, v.decided, v.suspicions], ["typed", "undecided", false, ["pasted-wrapper"]]);
	});

	it("labels a pasted output right after an unanswered tool call a tool result, however late it arrives", () => {
		const out = Array.from({ length: 10 }, (_, i) => `step ${i}: ok`).join("\n");
		assert.equal(label(out, { role: "user", childAgent: false, secondsAfterToolCall: 900 }), "notification/tool-result");
	});

	it("keeps a bare link a paste when it follows an unanswered tool call late", () => {
		assert.equal(label("https://example.invalid/acme/widgets/pull/12", { role: "user", childAgent: false, secondsAfterToolCall: 900 }), "pasted/link-only");
	});

	it("sends a paste that reads like an agent's brief to the model instead of calling it a paste", () => {
		const brief = Array.from({ length: 9 }, (_, i) => `Worktree: /work/repo-${i}\nBranch: fix/thing-${i}`).join("\n");
		assert.equal(classifyMessageOrigin(brief, USER).decided, false);
	});

	it("labels a message that is a fenced block", () => {
		assert.equal(label("```\nerror: cannot find module 'x'\n    at load (a.js:1:1)\n```"), "pasted/pasted-block");
	});

	it("keeps a short note above a large paste pasted, because the paste is most of the message", () => {
		const log = Array.from({ length: 12 }, (_, i) => `2026-01-01 10:00:${String(i).padStart(2, "0")} ERROR request failed`).join("\n");
		assert.equal(label(`see this\n\n${log}`), "pasted/pasted-block");
	});

	it("labels a message that is only links", () => {
		assert.equal(label("https://example.invalid/acme/widgets/pull/12"), "pasted/link-only");
		assert.equal(label("https://example.invalid/a\nhttps://example.invalid/b"), "pasted/link-only");
	});

	it("keeps a sentence that contains a link typed", () => {
		assert.equal(label("why did https://example.invalid/acme/widgets/pull/12 fail?"), "typed/no-marker");
	});

	it("labels a capture that opens on a zsh prompt", () => {
		assert.equal(label("dev@Laptop src % printenv | grep EDITOR\nGIT_EDITOR=false\nEDITOR=vi"), "pasted/terminal-output");
	});

	it("labels a capture that opens on a shell prompt", () => {
		assert.equal(label("dev@host:~/src$ ls\na.txt\nb.txt"), "pasted/terminal-output");
	});

	it("labels a terminal capture", () => {
		assert.equal(label("$ npm test\nPASS a.test.ts\nPASS b.test.ts\nTests: 2 passed"), "pasted/terminal-output");
	});
});

describe("classifyMessageOrigin: typed and undecided", () => {
	it("labels plain prose typed", () => {
		assert.equal(label("can you check why the tests are slow?"), "typed/no-marker");
		assert.equal(label("ok"), "typed/no-marker");
	});

	it("labels a slash command with no arguments a notification, because a command carries no words", () => {
		assert.equal(label("/compact"), "notification/slash-command");
		assert.equal(label("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>"), "notification/slash-command");
	});

	it("keeps the arguments of a slash command typed", () => {
		assert.equal(label("<command-message>build</command-message>\n<command-name>/build</command-name>\n<command-args>why does the parser reject this input?</command-args>"), "typed/no-marker");
	});

	it("keeps the person's instructions in a skill expansion typed and drops the skill's own guidelines", () => {
		assert.equal(label("<instructions>\nadd a retry to the sync\n</instructions>\n\n<guidelines>\n- Proceed test-first.\n</guidelines>"), "typed/no-marker");
		assert.equal(label("<guidelines>\n- Proceed test-first.\n</guidelines>"), "notification/harness-block");
	});

	it("leaves a message with only a weak sign undecided, with the provisional label typed and the sign recorded", () => {
		const v = classifyMessageOrigin("The operator says the login is done, please resume the check.", USER);
		assert.equal(v.origin, "typed");
		assert.equal(v.decided, false);
		assert.equal(v.rule, "undecided");
		assert.deepEqual(v.suspicions, ["operator-third-person"]);
	});

	it("marks a mention of an agent handle undecided", () => {
		const v = classifyMessageOrigin("Merge event: #7 merged into main; it is cx-gentle-zebra-35's lane.", USER);
		assert.deepEqual(v.suspicions.includes("agent-handle"), true);
		assert.equal(v.decided, false);
	});


	it("marks program output undecided", () => {
		const v = classifyMessageOrigin("Test Files 10 passed (10) Duration 2.36s", USER);
		assert.equal(v.decided, false);
		assert.ok(v.suspicions.includes("machine-text"));
	});

	it("never returns an empty suspicion list for an undecided message, or a non-empty one for a decided message", () => {
		for (const text of ["hello", "The operator is away.", "/compact", "why is it slow?"]) {
			const v = classifyMessageOrigin(text, USER);
			assert.equal(v.decided, v.suspicions.length === 0, text);
		}
	});
});
