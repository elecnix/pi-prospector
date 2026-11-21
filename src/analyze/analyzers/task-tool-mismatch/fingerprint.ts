import { newestPerSession, type FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * Sessions whose agent avoided the tool its task told it to use and rebuilt the
 * result by hand. The rule is deterministic, so objective, but it finds the
 * instruction in English imperative sentences. Only a session with a recorded
 * tool inventory gets a node, so a session without one is not measured. Tool
 * names stay out: they name a person's setup.
 */
export const taskToolMismatchFingerprint: FingerprintContributor = {
	def: {
		id: "toolAvoidance",
		label: "Instructed tool avoided",
		description:
			"Sessions whose first message told the agent to use a tool it had, and whose agent never called it and made many calls of substitute tools instead, with those substitute calls. The instruction is found in English imperative sentences only, and only sessions whose host recorded a tool inventory are measured.",
		kind: "objective",
		analyzers: ["task-tool-mismatch"],
		measures: [
			{ kind: "sessions", id: "sessionsWithMismatch", metric: "task-tool-mismatch.mismatch-found", field: "mismatch" },
			{ kind: "total", id: "substituteCalls", metric: "task-tool-mismatch.mismatch-found", field: "substituteCalls" },
		],
	},
	async read(ctx) {
		const rows = newestPerSession(await ctx.nodes("task-tool-mismatch", { mismatch: "$.mismatch_found", substitutes: "$.substitute_calls" }), "mismatch");
		return {
			measured: rows.map((r) => String(r["session"])),
			// Substitute calls count only where they stood in for an avoided tool.
			rows: rows.map((r) => ({ session: r["session"]!, mismatch: r["mismatch"]!, substituteCalls: r["mismatch"] === 1 ? (r["substitutes"] ?? null) : null })),
		};
	},
};
