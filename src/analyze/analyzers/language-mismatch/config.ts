/**
 * Configuration for the language-mismatch analyzer (issue #151).
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const LanguageMismatchConfig = Type.Object({
	/**
	 * Minimum number of script letters a text must carry before it is judged.
	 * Shorter texts — "ok", "fix it", punctuation-only replies — say nothing
	 * reliable about language, so they are skipped rather than guessed at. The
	 * count is over letters only, after code blocks / inline code / URLs are
	 * stripped; emoji, digits and punctuation never contribute.
	 */
	minTextLength: Type.Integer({ minimum: 1 }),
	/**
	 * Minimum share of a text's script letters the dominant script must hold for
	 * the text to be judged written in that script. Texts below the ratio are
	 * mixed-script noise (pasted code identifiers, transliteration) and are not
	 * judged rather than being attributed to whichever script squeaked ahead.
	 */
	dominantScriptRatio: Type.Number({ minimum: 0.5, maximum: 1 }),
	/** Whether compaction summaries are checked against their conversation's language. */
	checkCompaction: Type.Boolean(),
	/**
	 * Minimum number of mismatches across the session (mismatched turns plus
	 * mismatched compaction summaries) before one proposal is earned. A single
	 * slip may be incidental; recurrence is a pattern worth encoding as a
	 * standing instruction about responding in the user's language.
	 */
	minMismatchesForProposal: Type.Integer({ minimum: 1 }),
});
export type LanguageMismatchConfig = Static<typeof LanguageMismatchConfig>;

export const DEFAULT_LANGUAGE_MISMATCH_CONFIG: LanguageMismatchConfig = {
	minTextLength: 40,
	dominantScriptRatio: 0.7,
	checkCompaction: true,
	minMismatchesForProposal: 2,
};
