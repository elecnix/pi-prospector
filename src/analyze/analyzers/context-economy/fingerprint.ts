import { newestPerSession, type FingerprintContributor } from "../../../fingerprint/contributor.js";

/** The kinds of waste flag context-economy raises: its closed set. */
const FLAG_KINDS = ["high-carry-result", "oversized-tool-result", "redundant-read"];

/**
 * The first version whose redundant-read flags are slice-aware. An older run
 * flagged each page of a paginated read as a repeat, so its flag counts mean
 * something else and the session is not measured.
 */
export const SLICE_AWARE_SINCE = "2.1";

/**
 * How much context a session carries and re-sends. Counted from tool results
 * and the host's usage records, so objective. The per-tool split and the
 * flagged paths are left out: tool names and paths name a person's setup.
 */
export const contextEconomyFingerprint: FingerprintContributor = {
	def: {
		id: "contextCarry",
		label: "Context carry",
		description:
			"Tool-result tokens re-sent as cache reads on later turns, the read and shell carry per output token (read amplification), and the tool results flagged as likely waste of carried context.",
		kind: "objective",
		analyzers: ["context-economy"],
		measures: [
			{ kind: "total", id: "carriedMillionTokenTurns", metric: "context-economy.carry-cost", field: "carry", divisor: 1_000_000, decimals: 1 },
			{ kind: "distribution", id: "readAmplification", metric: "context-economy.read-amplification", field: "amplification", unit: "ratio", edges: [0, 5, 10, 25, 50, 100, 250] },
			{ kind: "sessions", id: "sessionsFlagged", metric: "context-economy.waste-flag", field: "flags" },
			{ kind: "groups", id: "flagsByKind", metric: "context-economy.waste-flag", dimensions: { kind: FLAG_KINDS } },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("context-economy", SLICE_AWARE_SINCE));
		const read = await ctx.nodes("context-economy", { amplification: "$.readAmplification", output: "$.billed.output", carry: "$.carry.totalTokenTurns" });
		const nodes = newestPerSession(read, "carry")
			.filter((r) => measured.has(String(r["session"])))
			// The analyzer writes 0 when the session billed no output; that is no ratio, so it is left out, not read as 0.
			.map((r) => ({ session: r["session"]!, carry: r["carry"]!, amplification: Number(r["output"]) > 0 ? (r["amplification"] ?? null) : null }));
		const flags = (await ctx.items("context-economy", "$.flags", { kind: "$.kind" })).filter((f) => measured.has(String(f["session"])));
		const flagsPerSession = new Map<string, number>();
		for (const f of flags) flagsPerSession.set(String(f["session"]), (flagsPerSession.get(String(f["session"])) ?? 0) + 1);
		return {
			measured: nodes.map((r) => String(r["session"])),
			rows: [...nodes.map((r) => ({ ...r, flags: flagsPerSession.get(String(r["session"])) ?? 0 })), ...flags.map((f) => ({ session: f["session"]!, kind: f["kind"]! }))],
		};
	},
};
