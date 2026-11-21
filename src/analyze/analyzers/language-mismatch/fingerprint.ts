import type { FingerprintContributor, FingerprintRow } from "../../../fingerprint/contributor.js";
import { SCRIPT_NAMES } from "./detect.js";

/**
 * Replies and compaction summaries written in a different script than the
 * person wrote in. A deterministic count of letters per Unicode block, so
 * objective and the same in any language; it cannot tell two languages that
 * share a script apart. A session with no judgable text gets no node and is
 * not measured.
 */
export const languageMismatchFingerprint: FingerprintContributor = {
	def: {
		id: "languageMismatch",
		label: "Language mismatch",
		description:
			"Turns whose reply is in a different script than the person's message, compaction summaries in a different script than the conversation, and the pair of scripts of each mismatched turn. Scripts are told apart by Unicode block, so French answered in English is not a mismatch.",
		kind: "objective",
		analyzers: ["language-mismatch"],
		measures: [
			{ kind: "total", id: "judgedTurns", metric: "language-mismatch.mismatched-turns", field: "judged" },
			{ kind: "total", id: "mismatchedTurns", metric: "language-mismatch.mismatched-turns", field: "mismatched" },
			{ kind: "total", id: "summariesChecked", metric: "language-mismatch.mismatched-compactions", field: "summaries" },
			{ kind: "total", id: "mismatchedSummaries", metric: "language-mismatch.mismatched-compactions", field: "mismatchedSummaries" },
			{ kind: "groups", id: "byScripts", metric: "language-mismatch.mismatched-turns", dimensions: { userScript: [...SCRIPT_NAMES], replyScript: [...SCRIPT_NAMES] } },
		],
	},
	async read(ctx) {
		const ran = new Set(await ctx.runs("language-mismatch"));
		const totals = (
			await ctx.nodes(
				"language-mismatch",
				{ judged: "$.judged_turn_count", mismatched: "$.mismatched_turn_count", summaries: "$.compaction_checked_count", mismatchedSummaries: "$.mismatched_compaction_count" }
			)
		).filter((r) => ran.has(String(r["session"])));
		const measured = new Set(totals.map((r) => String(r["session"])));
		const turns = await ctx.items("language-mismatch", "$.turns", { userScript: "$.user_script", replyScript: "$.assistant_script", mismatched: "$.mismatched" });
		const mismatches: FingerprintRow[] = turns
			.filter((r) => measured.has(String(r["session"])) && r["mismatched"] === 1)
			.map((r) => ({ session: r["session"]!, userScript: r["userScript"]!, replyScript: r["replyScript"]! }));
		return { measured: [...measured], rows: [...totals, ...mismatches] };
	},
};
