/**
 * How much a term's presence tells you, given how many turns carry it.
 *
 * A word that appears in nearly every turn cannot distinguish one turn from
 * another: it is the corpus's background, not a signal. The measure of that is
 * **document frequency** — the share of analysed turns that carry the term —
 * and it needs no vocabulary of any language, so the same rule prices a French
 * corpus, a Japanese one, and a corpus written in three languages at once.
 *
 * This replaces a hand-written list of English function words. The list was the
 * wrong instrument twice over: it could not reach any language but English, and
 * it decided membership by spelling rather than by what the corpus actually
 * does. Document frequency is the property the list was approximating — `do`
 * and `no` were not noise because they are English, but because nearly every
 * turn contains them.
 *
 * `specificity` is 1 for a term no other turn carries and falls linearly to 0 at
 * `maxDocumentShare`; at or above that share it stays 0.
 *
 * The cut has to *reach zero* rather than merely decay. A ranking totals each
 * term's weight across the turns it fired on, so a background word with a small
 * positive price still wins on volume: 250 turns at 0.4 beats 20 turns at 0.9.
 * Zeroing it is what actually removes it from the ranking.
 *
 * The estimate is refused entirely below `MIN_DOCUMENTS`: on a handful of turns
 * a share is noise, and pricing there would silence the very first sessions a
 * corpus has. Below the floor nothing is priced, which is the safe direction —
 * a young corpus over-reports rather than going silent.
 */

/**
 * The share of analysed turns at which a term counts as background.
 *
 * Calibrated against the terms that dominated a real corpus's ranking — `do`,
 * `no`, `do not`, `never`, `cannot`, `still` — which all fired on far more than
 * a tenth of its turns. Lower it to suppress more aggressively; raise it to
 * keep more repeated vocabulary. It is a ratio, not a word list, so it needs no
 * revision when the corpus changes language.
 */
export const DEFAULT_MAX_DOCUMENT_SHARE = 0.1;

/**
 * Fewer analysed turns than this and a document share is not worth acting on.
 *
 * A term in one of three turns is not "background" by any useful reading; the
 * ratio is simply too coarse. Below the floor every term keeps full weight.
 */
export const MIN_DOCUMENTS = 20;

/**
 * The specificity of a term: 1 when it is unique to its turns, 0 when it is
 * background.
 *
 * @param hitDocuments distinct turns the term fired on
 * @param documents    analysed turns in the corpus, the denominator of the share
 * @param maxDocumentShare above this share the term is background
 */
export function termSpecificity(
	hitDocuments: number,
	documents: number,
	maxDocumentShare: number = DEFAULT_MAX_DOCUMENT_SHARE,
): number {
	// Nothing to compare against: an empty corpus has no background to be part of.
	if (!Number.isFinite(documents) || documents < MIN_DOCUMENTS) return 1;
	if (!Number.isFinite(hitDocuments) || hitDocuments <= 0) return 1;
	// A non-positive cut prices every term at zero, which would silently disable
	// the lexicon; treat it as "no cut" instead.
    if (!(maxDocumentShare > 0)) return 1;
	const share = hitDocuments / documents;
	if (share >= maxDocumentShare) return 0;
	return 1 - share / maxDocumentShare;
}
