import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { MESSAGE_ORIGINS } from "../../message-origin.js";

/** What settled a label: a named rule, the decision model, or nothing (the label is the provisional `typed`). */
const SETTLED_BY = ["rule", "model", "undecided"];

function settledBy(rule: unknown, decided: unknown): string {
	if (decided !== 1) return "undecided";
	return rule === "decision-model" ? "model" : "rule";
}

/**
 * Who wrote the messages that start a turn: the person typing, the person
 * pasting, an agent, or the harness. Named rules settle almost every label, so
 * the section is objective; the `settledBy` dimension shows how many labels a
 * decision model settled and how many no rule or model could place. The rule
 * names and the messages stay out: only the label and what settled it are read.
 */
export const messageOriginFingerprint: FingerprintContributor = {
	def: {
		id: "messageOrigin",
		label: "Message origin",
		description:
			"Turn-starting user-role messages by who wrote them (typed, pasted, agent, notification) and by what settled the label (a rule, a decision model, or nothing, which leaves the provisional label typed). Some rules that recognise an agent's brief match English wording.",
		kind: "objective",
		analyzers: ["message-origin"],
		measures: [
			{ kind: "total", id: "messages", metric: "message-origin.origin", field: "messages" },
			{ kind: "groups", id: "byOrigin", metric: "message-origin.origin", dimensions: { origin: [...MESSAGE_ORIGINS], settledBy: SETTLED_BY } },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("message-origin"));
		const labels = await ctx.nodes("message-origin", { origin: "$.origin", rule: "$.rule", decided: "$.decided" });
		return {
			measured: [...measured],
			rows: labels
				.filter((r) => measured.has(String(r["session"])))
				.map((r) => ({ session: r["session"]!, origin: r["origin"]!, settledBy: settledBy(r["rule"], r["decided"]), messages: 1 })),
		};
	},
};
