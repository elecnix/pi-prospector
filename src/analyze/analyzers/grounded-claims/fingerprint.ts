import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { metricValues } from "../../metrics/values.js";
import { REQUEST_TYPES, UNACTED_REQUEST, UNGROUNDED_CLAIM } from "./detect.js";
import { metrics } from "./metrics.js";

const CLAIM_KINDS = metricValues(metrics, "grounded-claims.ungrounded-claim");

/**
 * What the agent claimed without grounds, and what the person asked for that no
 * tool call did. Deterministic, so the figures are objective. One node per hit.
 */
export const groundedClaimsFingerprint: FingerprintContributor = {
	def: {
		id: "groundedClaims",
		label: "Grounded claims",
		description:
			"Claims the agent stated (a number, count, percentage, path or line reference) that appear in none of that turn's tool results, and requests the person made (run the tests, build, open a PR, commit, push, delete) that no tool call in that turn or the next carried out. The request patterns match English wording only, so requests in other languages are not counted.",
		kind: "objective",
		analyzers: ["grounded-claims"],
		measures: [
			{ kind: "total", id: "ungroundedClaims", metric: "grounded-claims.ungrounded-claim", field: "ungrounded" },
			{ kind: "total", id: "unactedRequests", metric: "grounded-claims.unacted-request", field: "unacted" },
			{ kind: "groups", id: "byKind", metric: "grounded-claims.ungrounded-claim", dimensions: { claimKind: CLAIM_KINDS } },
			{ kind: "groups", id: "unactedByRequest", metric: "grounded-claims.unacted-request", dimensions: { requestType: [...REQUEST_TYPES] } },
		],
	},
	async read(ctx) {
		const measured = await ctx.runs("grounded-claims");
		const hits = await ctx.nodes("grounded-claims", { check: "$.signal", claimKind: "$.claim_kind", requestType: "$.request_type" });
		return {
			measured,
			rows: hits.map((h) => ({
				session: h["session"]!,
				// Every unacted request has the one kind `request`; its type is what tells them apart.
				claimKind: h["check"] === UNGROUNDED_CLAIM ? h["claimKind"]! : null,
				requestType: h["requestType"]!,
				ungrounded: h["check"] === UNGROUNDED_CLAIM ? 1 : 0,
				unacted: h["check"] === UNACTED_REQUEST ? 1 : 0,
			})),
		};
	},
};
