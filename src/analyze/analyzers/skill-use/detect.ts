/**
 * Skill-use detection.
 *
 * A session used a skill when the agent loaded it: a call to the host's skill
 * tool, or, on a host with no such tool, a read of the skill's `SKILL.md`. The
 * detection reads the shared action stream, so a call that was issued and never
 * answered still counts as a use (the agent asked for it) and is also counted as
 * unanswered, never silently dropped.
 *
 * Skill *identity* is the point. The share of tool calls that are skill calls is
 * a number the corpus already had; which skills, and how many times each, was not
 * aggregated anywhere.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream, type ToolInvocation } from "../../tool-stream.js";
import { DEFAULT_SKILL_USE_CONFIG, type SkillUseConfig } from "./config.js";

/** How the agent loaded the skill. */
export type SkillLoadVia = "skill_tool" | "skill_file";

/** One skill the session used, with how often and where it first happened. */
export interface SkillUse {
	name: string;
	via: SkillLoadVia;
	calls: number;
	/** Calls whose result was recorded as an error. */
	failed_calls: number;
	/** The assistant message that issued the first call. */
	first_call_message_id: string;
}

export interface SkillUseSummary {
	skills: SkillUse[];
	/** Every tool call in the session: the denominator for a skill share. */
	tool_call_count: number;
}

/** `…/skills/<name>/SKILL.md`, case-insensitive, either path separator. */
const SKILL_FILE_RE = /(?:^|[\\/])skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i;

function stringArg(args: Record<string, unknown>, key: string): string | null {
	const value = args[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The skill a call loaded, or null when the call is not a skill load. */
export function skillLoadedBy(
	call: Pick<ToolInvocation, "name" | "args">,
	config: SkillUseConfig = DEFAULT_SKILL_USE_CONFIG,
): { name: string; via: SkillLoadVia } | null {
	const tool = call.name.toLowerCase();
	if (config.skillToolNames.some((n) => n.toLowerCase() === tool)) {
		const name = stringArg(call.args, "skill") ?? stringArg(call.args, "name");
		return name === null ? null : { name: name.slice(0, config.maxNameChars), via: "skill_tool" };
	}
	if (config.readToolNames.some((n) => n.toLowerCase() === tool)) {
		const filePath = stringArg(call.args, "path") ?? stringArg(call.args, "file_path");
		const match = filePath === null ? null : SKILL_FILE_RE.exec(filePath);
		return match?.[1] ? { name: match[1].slice(0, config.maxNameChars), via: "skill_file" } : null;
	}
	return null;
}

/** The skills a session used, most-called first, ties by name. */
export function summariseSkillUse(
	messages: MessageRow[],
	config: SkillUseConfig = DEFAULT_SKILL_USE_CONFIG,
): SkillUseSummary {
	const { invocations } = buildToolStream(messages);
	const byKey = new Map<string, SkillUse>();
	for (const call of invocations) {
		const loaded = skillLoadedBy(call, config);
		if (!loaded) continue;
		const key = `${loaded.via}\u0000${loaded.name}`;
		const known = byKey.get(key);
		const failed = call.outcome?.isError === true ? 1 : 0;
		if (known) {
			known.calls++;
			known.failed_calls += failed;
		} else {
			byKey.set(key, {
				name: loaded.name,
				via: loaded.via,
				calls: 1,
				failed_calls: failed,
				first_call_message_id: call.messageId,
			});
		}
	}
	const skills = [...byKey.values()].sort(
		(a, b) => b.calls - a.calls || a.name.localeCompare(b.name) || a.via.localeCompare(b.via),
	);
	return { skills, tool_call_count: invocations.length };
}
