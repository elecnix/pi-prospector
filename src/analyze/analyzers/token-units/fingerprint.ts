import { newestPerSession, type FingerprintContributor } from "../../../fingerprint/contributor.js";

const MILLION = 1_000_000;

/**
 * What a session spent, priced in MITE (million input-token equivalents), and
 * the mix of token classes behind it. Counted from the host's usage records, so
 * objective. The per-model split is left out: model ids name a person's setup.
 */
export const tokenUnitsFingerprint: FingerprintContributor = {
	def: {
		id: "tokenSpend",
		label: "Token spend",
		description: "Spend per session in MITE (input x1, output x15, cache read x0.1, cache write x1.25), with the API calls and tokens of each class behind it.",
		kind: "objective",
		analyzers: ["token-units"],
		measures: [
			{ kind: "total", id: "totalMite", metric: "token-units.mite", field: "mite", decimals: 1 },
			{ kind: "distribution", id: "perSession", metric: "token-units.mite", field: "mite", unit: "mite", edges: [0, 1, 5, 10, 25, 50, 100, 250] },
			{ kind: "total", id: "apiCalls", metric: "token-units.mite", field: "calls" },
			{ kind: "total", id: "inputMillions", metric: "token-units.mite", field: "input", divisor: MILLION, decimals: 2 },
			{ kind: "total", id: "outputMillions", metric: "token-units.mite", field: "output", divisor: MILLION, decimals: 2 },
			{ kind: "total", id: "cacheReadMillions", metric: "token-units.mite", field: "cacheRead", divisor: MILLION, decimals: 2 },
			{ kind: "total", id: "cacheWriteMillions", metric: "token-units.mite", field: "cacheWrite", divisor: MILLION, decimals: 2 },
		],
	},
	async read(ctx) {
		// A session that grew between runs is a new unit with its own node; the newest covers the whole session.
		const rows = newestPerSession(
			await ctx.nodes("token-units", {
				mite: "$.totals.mite",
				calls: "$.totals.calls",
				input: "$.totals.input",
				output: "$.totals.output",
				cacheRead: "$.totals.cache_read",
				cacheWrite: "$.totals.cache_write",
			}),
			"mite",
		);
		return { measured: rows.map((r) => String(r["session"])), rows };
	},
};
