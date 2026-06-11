/**
 * Deterministic correction / friction detection patterns.
 *
 * These regexes flag *candidate* corrections cheaply; the LLM enrichment pass
 * (turn-pair-llm) filters false positives. Categories:
 *   - strong  : clearly corrective ("no, use X", "that's wrong", "I said …")
 *   - weak    : hedged or possibly corrective ("could you try …", "actually")
 *   - negation: a leading negative that flips intent ("no …", "not …")
 *
 * Repetition (the user re-asking) is detected separately via token overlap.
 */

export type CorrectionType = "explicit" | "implicit" | "repetition";

export interface CorrectionResult {
	detected: boolean;
	type: CorrectionType | null;
	patterns: string[];
	correctionText: string | null;
}

const STRONG: RegExp[] = [
	/\bno[,.\s]+(use|do|don'?t|that'?s|that is|it'?s|it is|use the)\b/i,
	/\bnot\s+(that|this|like that|like this|what i)\b/i,
	/\bdon'?t\s+(do|use|run|edit|add|remove|change|try|create)\b/i,
	/\bstop\s+(doing|using|running|trying)\b/i,
	/\bthat'?s\s+(wrong|incorrect|not right|not what)\b/i,
	/\bthat\s+is\s+(wrong|incorrect|not what)\b/i,
	/\binstead\s+of\s+(that|this)\b/i,
	/\bi\s+(said|told you|already said|already told|meant)\b/i,
	/\bactually[,.\s]/i,
	/\brevert\b/i,
];

const WEAK: RegExp[] = [
	/\bcould\s+you\s+(please\s+)?(try|use|do|change|switch)\b/i,
	/\bmaybe\s+(we|you|try)\b/i,
	/\bwhy\s+don'?t\s+you\b/i,
	/\bprefer\s+to\s+(use|do)\b/i,
	/\bplease\s+(use|do|try|don'?t)\b/i,
	/\bshould\s+(use|do|be|have)\b/i,
];

const LEADING_NEGATION: RegExp[] = [
	/^\s*no\b/i,
	/^\s*not\b/i,
	/^\s*never\b/i,
	/^\s*don'?t\b/i,
	/^\s*nope\b/i,
];

/** Detect a correction in user text. Strong > weak > leading-negation. */
export function classifyCorrection(text: string | null, isRepetition: boolean): CorrectionResult {
	if (isRepetition) {
		return { detected: true, type: "repetition", patterns: [], correctionText: text?.slice(0, 240) ?? null };
	}
	if (!text) return { detected: false, type: null, patterns: [], correctionText: null };

	const strong = matchAll(STRONG, text);
	if (strong.length > 0) {
		return { detected: true, type: "explicit", patterns: strong, correctionText: extractCorrectionText(text, strong[0]!) };
	}
	const weak = matchAll(WEAK, text);
	if (weak.length > 0) {
		return { detected: true, type: "implicit", patterns: weak, correctionText: extractCorrectionText(text, weak[0]!) };
	}
	const neg = matchAll(LEADING_NEGATION, text);
	if (neg.length > 0) {
		return { detected: true, type: "explicit", patterns: neg, correctionText: text.slice(0, 240) };
	}
	return { detected: false, type: null, patterns: [], correctionText: null };
}

function matchAll(patterns: RegExp[], text: string): string[] {
	const out: string[] = [];
	for (const re of patterns) if (re.test(text)) out.push(re.source);
	return out;
}

/** Slice the corrective remainder after the first matched pattern. */
export function extractCorrectionText(text: string, patternSource: string): string {
	const re = new RegExp(patternSource, "i");
	const m = re.exec(text);
	if (!m) return text.slice(0, 240);
	const after = text.slice(m.index + m[0].length).trim();
	return (after || m[0]).slice(0, 240);
}

/**
 * Cheap repetition heuristic: a short message that shares >= 2 meaningful tokens
 * with the previous user message is likely a re-ask of the same intent.
 */
export function detectRepetition(text: string | null, priorUserText: string | null): boolean {
	if (!text || !priorUserText) return false;
	if (text.length > 80) return false;
	return sharedTokenCount(text, priorUserText) >= 2;
}

function sharedTokenCount(a: string, b: string): number {
	const at = tokenSet(a);
	const bt = tokenSet(b);
	let count = 0;
	for (const t of at) if (bt.has(t)) count++;
	return count;
}

function tokenSet(s: string): Set<string> {
	return new Set(s.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
}
