/**
 * Configuration for the session-ending analyzer (issue #102).
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const SessionEndingConfig = Type.Object({
	/**
	 * Tool names treated as shell execution, whose `command` argument is matched
	 * against the verification patterns. Kept as config rather than hardcoded so
	 * a harness with a differently named shell tool is a config change, not a
	 * version bump.
	 */
	shellToolNames: Type.Array(Type.String()),
	/**
	 * Regex sources identifying verification-class commands — the calls whose
	 * exit outcome tells us whether the work shipped: running tests or builds,
	 * committing, pushing, opening or merging a PR. Matched case-insensitively
	 * against the start of the command string. The last such call in the session
	 * is the ending evidence.
	 */
	verificationPatterns: Type.Array(Type.String()),
	/**
	 * Regex sources recognising an explicit user closing utterance ("thanks",
	 * "that's all", "merci") as the session's final message. A closure cue ends
	 * the exchange deliberately — handed-off — rather than leaving it unclear.
	 */
	closurePatterns: Type.Array(Type.String()),
	/**
	 * Maximum character length of a final user message that may count as an
	 * explicit closure. A long message matching "thanks" mid-paragraph is not a
	 * sign-off; only short closing utterances are trusted.
	 */
	maxClosureLength: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum trimmed length of the final assistant text for it to count as a
	 * delivered summary. A bare "ok" at the end carries no evidence the work was
	 * wrapped up, and the conservative default applies instead.
	 */
	minFinalSummaryLength: Type.Integer({ minimum: 1 }),
	/**
	 * Character cap on the evidence excerpt carried from the final assistant
	 * message. The excerpt is provenance for humans reading the node, not
	 * analysis input, and the graph is durable and widely readable.
	 */
	excerptLength: Type.Integer({ minimum: 1 }),
});
export type SessionEndingConfig = Static<typeof SessionEndingConfig>;

export const DEFAULT_SESSION_ENDING_CONFIG: SessionEndingConfig = {
	shellToolNames: ["bash"],
	verificationPatterns: [
		"^npm( run)? test\\b",
		"^npm run build\\b",
		"^npx tsc\\b",
		"^yarn test\\b",
		"^pnpm( run)? test\\b",
		"^vitest\\b",
		"^jest\\b",
		"^pytest\\b",
		"^python -m pytest\\b",
		"^go test\\b",
		"^cargo (build|test)\\b",
		"^make\\b",
		"^mvn \\b",
		"^gradle\\b",
		"^rake test\\b",
		"^git commit\\b",
		"^git push\\b",
		"^gh pr create\\b",
		"^gh pr merge\\b",
		"^gh release create\\b",
	],
	closurePatterns: [
		"^(thanks|thank you|thx|ty|merci|parfait|nickel|perfect|great|awesome|excellent|done|fixed|works|that'?s all|c'est tout|ça marche)\\b",
	],
	maxClosureLength: 80,
	minFinalSummaryLength: 20,
	excerptLength: 200,
};
