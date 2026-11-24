import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { DocumentField } from "./documents.js";

const FIELDS = DocumentField.anyOf.map((f) => f.const);

/**
 * Generations that stopped being language. The documents' text, models and
 * leaked tokens are never read. Deterministic, so objective.
 *
 * A session scored against a corpus too small to train on is not measured: its
 * count is unknown, not zero.
 */
export const decodeCollapseFingerprint: FingerprintContributor = {
	def: {
		id: "decodeCollapse",
		label: "Decode collapse",
		description:
			"Assistant reasoning and answer texts scored, and those that stopped being language, by which of the two they are and by whether the generation returned no answer. The threshold is calibrated on the person's own corpus: each side is judged against its own usual text, so the same text can count on one side and not on the other. Compare the size of the problem, not small differences. A session is measured only when its corpus was large enough to calibrate on and it holds a text to score. The model learns from the corpus, so no language is assumed.",
		kind: "objective",
		analyzers: ["decode-collapse"],
		measures: [
			{ kind: "total", id: "textsScored", metric: "decode-collapse.collapsed-documents", field: "scored" },
			{ kind: "total", id: "textsCollapsed", metric: "decode-collapse.collapsed-documents", field: "collapsed" },
			{ kind: "sessions", id: "sessionsWithCollapse", metric: "decode-collapse.collapsed-documents", field: "collapsed" },
			{ kind: "groups", id: "collapsedByText", metric: "decode-collapse.collapsed-documents", dimensions: { text: FIELDS, answer: ["empty", "present"] } },
		],
	},
	async read(ctx) {
		const scored = (await ctx.nodes("decode-collapse", { scored: "$.document_count", collapsed: "$.collapsed_count" })).filter((r) => typeof r["collapsed"] === "number");
		const measured = new Set(scored.map((r) => String(r["session"])));
		const collapsed = await ctx.items("decode-collapse", "$.collapsed_documents", { text: "$.field", empty: "$.answer_empty" });
		return {
			measured: [...measured],
			rows: [
				...scored,
				...collapsed.filter((d) => measured.has(String(d["session"]))).map((d) => ({ session: d["session"]!, text: d["text"]!, answer: d["empty"] === 1 ? "empty" : "present" })),
			],
		};
	},
};
