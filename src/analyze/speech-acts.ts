/**
 * Deterministic matchers for the two speech acts the system names separately
 * (issue #318): the user's **rebuttal** (a dispute of something the assistant
 * said) and the assistant's **apology** (a concession that it was wrong).
 *
 * Both live here, in one module, because the two sides of a disagreement have
 * to agree on where the boundary between a *dispute of a claim* and an
 * *instruction* falls — and because a matcher used by two analyzers must not be
 * allowed to drift into two different implementations.
 *
 * These are **candidates**, never findings:
 *
 *   - The rebuttal matcher marks a turn whose wording disputes a claim. It is
 *     read by the language-model layer, which confirms or rejects it. An
 *     instruction ("I told you to use X") is a *correction*, not a rebuttal: it
 *     asks for different behaviour and leaves the assistant's stated fact
 *     unchallenged, so it never matches.
 *   - The apology matcher admits a turn to scrutiny. An apology lives in the
 *     assistant's response text, and the analyzer that reads the assistant's own
 *     words only runs on turns with a substantive thinking trace — so a turn
 *     with no reasoning would never be read there. The match is a *gate for
 *     scrutiny*: what is finally stored is the model's graded apology with a
 *     quote validated against the response verbatim.
 *
 * Both are pure functions: no database, no LLM, no state.
 */

/**
 * A matched span of text with the pattern that matched it.
 *
 * `pattern` is the regular expression's source, so a stored match names the
 * rule that fired — the same shape the correction matcher already uses.
 */
export interface SpeechActMatch {
	/** The matched text, verbatim. */
	text: string;
	/** The source of the regular expression that matched. */
	pattern: string;
	/** Index of the match's first character in the searched text. */
	index: number;
}

/**
 * The negation a rebuttal pattern accepts, in every wording a writer uses:
 * "doesn't", "does not", "didn't", "did not", "don't", "do not".
 *
 * The contraction and the spelled-out form carry the same meaning, so a
 * pattern that answers only one of them answers half the disputes. The
 * spelling is the hard part: "doesn't" *is* the contraction of "does not",
 * so a pattern that asks for "does" before the suffix never matches it. Each
 * auxiliary is therefore listed in both forms.
 */
const NEGATION_SOURCE = "(?:does\\s*n[o']?t|does\\s+not|do\\s*n[o']?t|do\\s+not|did\\s*n[o']?t|did\\s+not|doesn\\u2019t|didn\\u2019t|don\\u2019t)";

/**
 * Rebuttal patterns: wordings in which the user disputes whether something the
 * assistant said is true.
 *
 * Deliberately narrow. A rebuttal is a dispute of a *claim*; a dispute of a
 * *method* ("try a different approach", "the wrong file") belongs to the
 * correction machinery, and a pattern broad enough to catch both would make
 * the two indistinguishable — which is the one thing the deterministic layer
 * exists to prevent.
 *
 * The "I told you" family is deliberately **absent**: it is an instruction, not
 * a dispute of fact. It is already a strong correction pattern, and it must
 * stay one.
 */
const REBUTTAL_PATTERNS: RegExp[] = [
	// "that's wrong", "that is wrong", "that's incorrect", "that's not right"
	/\bthat(?:'s|\s+is)\s+(?:wrong|incorrect|not\s+right|not\s+true|false)\b/i,
	// "this is wrong", "this is incorrect"
	/\bthis\s+is\s+(?:wrong|incorrect|not\s+right|not\s+true|false)\b/i,
	// "you are wrong", "you're wrong", "you were wrong"
	/\byou(?:'re| are| were)\s+(?:wrong|incorrect|mistaken)\b/i,
	// "that flag doesn't exist", "that doesn't exist"
	new RegExp(
		`\\bthat\\s+(?:flag|option|argument|command|file|branch|field|parameter|method|function|api|endpoint|setting|config(?:uration)?|key|script|test|target)\\b[^.?!]{0,40}\\b${NEGATION_SOURCE}\\s+exist\\b`,
		"i",
	),
	// "that doesn't exist", "that does not exist" — the bare form, with no noun
	// between "that" and the negation. The pattern above needs the noun, so
	// without this one the plainest wording of the dispute never matched.
	new RegExp(`\\bthat\\s+${NEGATION_SOURCE}\\s+exist\\b`, "i"),
	// "there's no such option", "there is no such flag"
	/\b(?:there(?:'s| is)\s+no|there\s+isn'?t)\s+(?:such\s+)?(?:flag|option|argument|command|file|branch|field|parameter|method|function|api|endpoint|setting|config(?:uration)?|key|script|test|target)\b/i,
	// "the test didn't pass", "the build didn't compile", "the command didn't succeed"
	new RegExp(
		`\\b(?:it|that|the\\s+test|the\\s+build|the\\s+command|the\\s+check)\\s+${NEGATION_SOURCE}\\s+(?:pass|passes|passed|compile|compiles|work|works|succeed|succeeds|succeeded)\\b`,
		"i",
	),
	// "it didn't work"
	new RegExp(`\\bit\\s+${NEGATION_SOURCE}\\s+work\\b`, "i"),
	// "it's not true", "that is not true", "that isn't true"
	//
	// "isn't true" and "is not true" are the same claim, but they are not the
	// same words: the contraction carries the negation inside "isn't", so a
	// pattern that asks for "not true" after it never matches. Both wordings
	// are listed — and only the negated ones, so "that's true" (agreement) is
	// never a rebuttal.
	/\b(?:that'?s|it'?s|this\s+is|that\s+is|it\s+is)\s+not\s+true\b/i,
	/\b(?:that|it)\s+isn'?t\s+true\b/i,
	// "you're mistaken"
	/\byou(?:'re| are)\s+mistaken\b/i,
	// "it failed", "it errored", "it timed out", "it was rejected" — the outcome
	// the assistant reported did not happen
	/\bit\s+(?:failed|errored|timed\s+out|was\s+rejected)\b/i,
];

/**
 * Apology patterns: wordings in which the assistant concedes that it was
 * wrong.
 *
 * The list is the one the issue names — `sorry`, `apologi[sz]e`, `my mistake`,
 * `I was wrong` — plus two closings that carry the same concession without the
 * word ("you're right", "my error"). "My bad" is **not** here: it is informal
 * enough that it appears in ordinary chat as often as in a concession, and the
 * model layer confirms what the matcher admits.
 */
const APOLOGY_PATTERNS: RegExp[] = [
	// "sorry", "so sorry", "sorry about that"
	/\bsorry\b/i,
	// "apology", "apologies", "apologize", "apologise", "apologizing", …
	/\bapolog(?:y|ies|ise[sd]?|ize[sd]?|ising|izing)\b/i,
	// "my mistake", "that was my mistake"
	/\bmy\s+mistake\b/i,
	// "I was wrong", "I was mistaken", "I'm wrong", "I am wrong"
	//
	// "I'm wrong" and "I was wrong" are the same concession, so both wordings
	// are listed. The contraction carries the "am" inside it, so a pattern that
	// asks for "am" before it never matches.
	/\bi\s+(?:was|were|am|are)\s+(?:wrong|mistaken)\b/i,
	/\bi'?m\s+(?:wrong|mistaken)\b/i,
	// "you're right", "you are right", "you're correct"
	/\byou(?:'re| are)\s+(?:right|correct)\b/i,
	// "my error", "that was my error"
	/\bmy\s+error\b/i,
];

/**
 * Condolence openings: "sorry" used to express regret about the user's
 * situation rather than about the assistant's own mistake.
 *
 * A condolence is not a concession, and admitting every such turn to the model
 * would spend the gate on the wrong turns. The list is short and explicit
 * rather than clever — an ordinary phrase that follows "sorry" and names the
 * user's state.
 */
const CONDOLENCE_OPENINGS = [/^to\s+hear\b/i, /^for\s+your\b/i, /^about\s+your\b/i];

/**
 * The word boundary that marks the end of a code span: a backtick, a fence,
 * or a line of source.
 *
 * An apology inside a code snippet is not the assistant apologising — it is
 * the assistant quoting code, and the snippet may well contain the word
 * "sorry" (an error message, a test fixture, a comment). The matcher skips a
 * match whose surrounding text is code.
 */
const CODE_FENCE = "```";

/**
 * The [start, end) ranges of the text that are code: fenced blocks and inline
 * spans, in the order they appear.
 *
 * A scan rather than a backtick parity count, because a parity count cannot
 * tell an inline span from a fence — and a fence contributes three backticks,
 * so any parity rule is wrong by construction. The scan tracks the two forms
 * separately, so a fenced block containing backticks stays one region.
 */
function codeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let i = 0;
	while (i < text.length) {
		if (text.startsWith(CODE_FENCE, i)) {
			const close = text.indexOf(CODE_FENCE, i + CODE_FENCE.length);
			const end = close === -1 ? text.length : close + CODE_FENCE.length;
			ranges.push([i, end]);
			i = end;
			continue;
		}
		if (text[i] === "`") {
			const close = text.indexOf("`", i + 1);
			if (close === -1) {
				i += 1;
				continue;
			}
			ranges.push([i, close + 1]);
			i = close + 1;
			continue;
		}
		i += 1;
	}
	return ranges;
}

/**
 * Is this match inside a code span? True when the match falls within a fenced
 * block or an inline `span`.
 *
 * The check is deliberately conservative about *what* counts as code: only a
 * backtick-delimited span or a fenced block. A bare word in ordinary prose is
 * never code, so a match in prose is always reported.
 */
export function isInCodeSpan(text: string, index: number): boolean {
	return codeRanges(text).some(([start, end]) => index >= start && index < end);
}

/**
 * The [start, end) ranges of the text that are quoted spans.
 *
 * A double-quoted span is a quotation at any position. A single-quoted span
 * counts only when the opening quote is preceded by a non-word character and
 * the closing quote by a non-word character (or the end of the text) — which
 * is what separates a quotation from an apostrophe in a contraction ("you're
 * right", "I'm sorry"). A contraction's apostrophe is preceded by a word
 * character, so it never opens a span.
 */
function quotedRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '"') {
			const close = text.indexOf('"', i + 1);
			const end = close === -1 ? text.length : close + 1;
			ranges.push([i, end]);
			i = end;
			continue;
		}
		if (ch === "'" && (i === 0 || !/[\w]/.test(text[i - 1]!))) {
			let close = -1;
			for (let j = i + 1; j < text.length; j++) {
				if (text[j] === "'" && (j === text.length - 1 || !/[\w]/.test(text[j + 1]!))) {
					close = j;
					break;
				}
			}
			if (close === -1) {
				i += 1;
				continue;
			}
			ranges.push([i, close + 1]);
			i = close + 1;
			continue;
		}
		i += 1;
	}
	return ranges;
}

/**
 * Is this match inside a quoted span — the assistant repeating what the user
 * said?
 *
 * The assistant's response text sometimes carries the user's own words ("you
 * said 'sorry, use the other branch'"). An apology inside such a quotation is
 * the user's wording, not the assistant's concession, so it is not a match.
 *
 * The quoted span is recognised by a double-quoted span, by a single-quoted
 * span whose delimiters are not apostrophes in a contraction, and by the
 * blockquote form a transcript uses when it re-renders a quoted message.
 */
export function isInQuotedSpan(text: string, index: number): boolean {
	if (quotedRanges(text).some(([start, end]) => index >= start && index < end)) return true;
	const before = text.slice(0, index);
	const lineStart = before.lastIndexOf("\n") + 1;
	const line = before.slice(lineStart);
	return /^\s*>\s?/.test(line);
}

/**
 * Match every rebuttal pattern in a user message.
 *
 * The result is a **candidate**: the wording disputes a claim, and a model
 * decides whether it really did. Empty means the message made no such
 * dispute — which is the ordinary case, and in particular the case for every
 * instruction. A match inside a code span is skipped: a pasted snippet that
 * happens to contain the words is not the user disputing anything.
 */
export function matchRebuttalCandidates(text: string | null): SpeechActMatch[] {
	if (!text) return [];
	const out: SpeechActMatch[] = [];
	const seen = new Set<number>();
	for (const re of REBUTTAL_PATTERNS) {
		const m = re.exec(text);
		if (!m) continue;
		if (isInCodeSpan(text, m.index)) continue;
		// Two patterns can match the same words ("it didn't work" is both the
		// generic outcome pattern and the "it didn't work" pattern). One span is
		// one candidate, so the first match at an index wins.
		if (seen.has(m.index)) continue;
		seen.add(m.index);
		out.push({ text: m[0], pattern: re.source, index: m.index });
	}
	return out.sort((a, b) => a.index - b.index);
}

/**
 * Match every apology pattern in an assistant's response text.
 *
 * Matches inside a code span or a quoted span are skipped: a code snippet's
 * "sorry" and a quotation of the user's words are not the assistant conceding.
 * A "sorry" that opens a condolence ("sorry to hear that") is skipped for the
 * same reason — it regrets the user's situation, not the assistant's mistake.
 *
 * The result is a **candidate** — the turn is admitted to the analyzer that
 * grades apologies — never the finding itself.
 */
export function matchApologyCandidates(text: string | null): SpeechActMatch[] {
	if (!text) return [];
	const out: SpeechActMatch[] = [];
	const seen = new Set<number>();
	for (const re of APOLOGY_PATTERNS) {
		const m = re.exec(text);
		if (!m) continue;
		if (isInCodeSpan(text, m.index)) continue;
		if (isInQuotedSpan(text, m.index)) continue;
		if (isCondolence(text, m)) continue;
		if (seen.has(m.index)) continue;
		seen.add(m.index);
		out.push({ text: m[0], pattern: re.source, index: m.index });
	}
	return out.sort((a, b) => a.index - b.index);
}

/**
 * Is this match a condolence rather than a concession? Only "sorry" can open
 * one; the other apology words always concede.
 */
function isCondolence(text: string, match: RegExpExecArray): boolean {
	if (!/^sorry$/i.test(match[0].trim())) return false;
	const after = text.slice(match.index + match[0].length).replace(/^[\s,:;—-]+/, "");
	return CONDOLENCE_OPENINGS.some((re) => re.test(after));
}

/** The pattern sources, exposed for tests and for the analyzer descriptions. */
export const REBUTTAL_PATTERN_SOURCES = REBUTTAL_PATTERNS.map((re) => re.source);
export const APOLOGY_PATTERN_SOURCES = APOLOGY_PATTERNS.map((re) => re.source);
