import type { FingerprintContributor, FingerprintReadContext, FingerprintRow } from "../../../fingerprint/contributor.js";

/** The first version that looks for apologies. A session last run by 1.0 would read as having none. */
export const APOLOGY_SINCE = "1.1";

const LEVELS = ["mild", "moderate", "high"];

/** Each signal's array in the node, and the field that grades it. */
const SIGNALS = { confusion: "$.level", indecision: "$.level", surprise: "$.severity", apology: "$.severity" } as const;

/**
 * Confusion, indecision, surprise and apology in the assistant's own thinking
 * and reply, graded by a model, so inferred. A model reads only the turns whose
 * thinking is long enough or whose reply matches an English apology pattern,
 * so the counts describe those turns. Quotes and rationales stay out.
 */
export const assistantCognitionFingerprint: FingerprintContributor = {
	def: {
		id: "assistantCognition",
		label: "Assistant cognition",
		description:
			"Turns a model judged, and the confusion, indecision, surprise and apology it found in the assistant's own words, by level. Only turns with a substantial thinking trace, or a reply that matches an English apology pattern, are judged.",
		kind: "inferred",
		analyzers: ["assistant-cognition"],
		measures: [
			{ kind: "total", id: "turnsJudged", metric: "assistant-cognition.confusion", field: "turns" },
			...Object.keys(SIGNALS).map((signal) => ({ kind: "groups" as const, id: signal, metric: `assistant-cognition.${signal}`, dimensions: { [`${signal}Level`]: LEVELS } })),
		],
	},
	async read(ctx: FingerprintReadContext) {
		const measured = new Set(await ctx.runs("assistant-cognition", APOLOGY_SINCE));
		const ours = (r: FingerprintRow) => measured.has(String(r["session"]));
		const turns = (await ctx.nodes("assistant-cognition", {})).filter(ours).map((r) => ({ session: r["session"]!, turns: 1 }));
		const signals: FingerprintRow[][] = [];
		for (const [signal, grade] of Object.entries(SIGNALS)) {
			const items = await ctx.items("assistant-cognition", `$.${signal}`, { level: grade });
			// Each signal is its own measure, so its rows carry the level under that measure's dimension only.
			signals.push(items.filter(ours).map((r) => ({ session: r["session"]!, [`${signal}Level`]: r["level"] ?? null })));
		}
		return { measured: [...measured], rows: [...turns, ...signals.flat()] };
	},
};
