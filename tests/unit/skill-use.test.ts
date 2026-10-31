/**
 * Unit tests for the skill-use analyzer's detection. Pure functions, no
 * database, no mocks: hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { skillLoadedBy, summariseSkillUse } from "../../src/analyze/analyzers/skill-use/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow as row } from "./helpers.js";

function exchange(id: string, name: string, args: Record<string, unknown>, isError = false): MessageRow[] {
	return [
		row({ id: `call-${id}`, role: "assistant", tool_calls: JSON.stringify([{ id, name, arguments: args }]) }),
		row({
			id: `result-${id}`,
			role: "toolResult",
			content_text: "ok",
			tool_results: JSON.stringify([{ toolCallId: id, toolName: name, isError, textLength: 2 }]),
		}),
	];
}

describe("skillLoadedBy", () => {
	it("reads the skill name from the skill tool", () => {
		assert.deepEqual(skillLoadedBy({ name: "Skill", args: { skill: "vale-prose-rules" } }), {
			name: "vale-prose-rules",
			via: "skill_tool",
		});
	});

	it("reads the skill name from a SKILL.md read, on either path separator", () => {
		assert.deepEqual(skillLoadedBy({ name: "read", args: { path: "/home/u/.pi/agent/skills/deploy/SKILL.md" } }), {
			name: "deploy",
			via: "skill_file",
		});
		assert.deepEqual(skillLoadedBy({ name: "Read", args: { file_path: "C:\\x\\skills\\deploy\\SKILL.md" } }), {
			name: "deploy",
			via: "skill_file",
		});
	});

	it("ignores other reads, other tools, and a skill call with no name", () => {
		assert.equal(skillLoadedBy({ name: "read", args: { path: "/repo/skills/deploy/notes.md" } }), null);
		assert.equal(skillLoadedBy({ name: "bash", args: { command: "cat skills/x/SKILL.md" } }), null);
		assert.equal(skillLoadedBy({ name: "Skill", args: {} }), null);
	});
});

describe("summariseSkillUse", () => {
	it("counts each skill, most-called first, with failures and the first call", () => {
		const messages = [
			...exchange("a", "Skill", { skill: "deploy" }),
			...exchange("b", "bash", { command: "ls" }),
			...exchange("c", "Skill", { skill: "review" }, true),
			...exchange("d", "Skill", { skill: "review" }),
		];
		const summary = summariseSkillUse(messages);
		assert.equal(summary.tool_call_count, 4);
		assert.deepEqual(summary.skills, [
			{ name: "review", via: "skill_tool", calls: 2, failed_calls: 1, first_call_message_id: "call-c" },
			{ name: "deploy", via: "skill_tool", calls: 1, failed_calls: 0, first_call_message_id: "call-a" },
		]);
	});

	it("returns an empty list for a session that loaded no skill", () => {
		const summary = summariseSkillUse(exchange("a", "bash", { command: "ls" }));
		assert.deepEqual(summary, { skills: [], tool_call_count: 1 });
	});
});
