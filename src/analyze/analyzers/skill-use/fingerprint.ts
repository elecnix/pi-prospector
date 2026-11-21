import { type FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * How much a person's sessions lean on skills. Counted from the tool calls that
 * load one, so objective. A session that loaded no skill still has a node, so
 * it counts as measured with none. Skill names stay out: they name a person's
 * setup.
 */
export const skillUseFingerprint: FingerprintContributor = {
	def: {
		id: "skills",
		label: "Skills",
		description: "Skill loads and the tool calls they are among, the sessions that load any skill, and the distinct skills loaded per session.",
		kind: "objective",
		analyzers: ["skill-use"],
		measures: [
			{ kind: "total", id: "skillCalls", metric: "skill-use.skill-calls", field: "calls" },
			{ kind: "total", id: "toolCalls", metric: "skill-use.skill-calls", field: "toolCalls" },
			{ kind: "total", id: "distinctSkills", metric: "skill-use.skill-calls", field: "distinct" },
			{ kind: "sessions", id: "sessionsWithSkill", metric: "skill-use.skill-calls", field: "calls" },
		],
	},
	async read(ctx) {
		const rows = await ctx.nodes("skill-use", { calls: "$.skill_call_count", distinct: "$.distinct_skill_count", toolCalls: "$.tool_call_count" });
		return { measured: [...new Set(rows.map((r) => String(r["session"])))], rows };
	},
};
