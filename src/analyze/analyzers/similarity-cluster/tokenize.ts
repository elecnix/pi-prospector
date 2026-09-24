/**
 * Tokenisation and normalisation for the similarity-cluster analyzer (issue #145).
 *
 * Stage 1 of the four-stage pipeline. The goal is Type-2/3 clone comparison:
 * blind-rename identifiers and literals so "the same command with different
 * arguments, the same file at a different path, the same correction phrased
 * slightly differently" reduce to comparable structural streams, while keeping
 * the tokens that ARE the signal (operators, keywords, line shape, content
 * words in prose).
 *
 * Three domains, three normalisers:
 *   - tool calls → a structural stream of tool name, argument keys, and
 *     type-tagged values; string values are tokenised with their CONTENT kept
 *     (lowercased) because for `bash`/`read`-shaped calls the value is where
 *     all discrimination lives — collapsing every value to STR would make any
 *     two bash calls identical, which is precisely the false positive the
 *     issue's own example table warns against.
 *   - tool results → language-agnostic text tokens with identifiers blind-
 *     renamed to ID (per spec), paths/URIs/numbers/strings tagged, newlines
 *     kept as structural tokens so log/diff shape survives.
 *   - user prompts → the result tokeniser minus blind renaming (prose words
 *     ARE the signal — renaming every word to ID would collapse all prompts to
 *     indistinguishable streams), plus stop-word removal so function-word
 *     differences ("please don't…" vs "don't…") do not inflate the LCS
 *     denominator.
 *
 * Pure and deterministic throughout: every output feeds content-addressed node
 * identity, so the same input must yield the same tokens on any machine.
 */

import { fnv1a64 } from "../tool-trajectory/reasoning-fingerprint.js";

/**
 * English function words dropped from user prompts before normalisation
 * (issue #145 Detector 3). Deliberately small and closed — no stemming,
 * no language detection.
 */
export const PROMPT_STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "shall",
	"should", "may", "might", "must", "can", "could", "of", "in", "to",
	"for", "on", "at", "from", "by", "with", "about", "as", "into",
	"through", "during", "before", "after", "above", "below", "between",
	"out", "off", "over", "under", "again", "further", "then", "once",
	"here", "there", "when", "where", "why", "how", "all", "both", "each",
	"few", "more", "most", "other", "some", "such", "no", "not", "only",
	"own", "same", "so", "than", "too", "very", "just", "also", "now",
]);

/** Structural keywords kept verbatim even under blind renaming. */
const KEPT_KEYWORDS = new Set([
	"if", "else", "for", "while", "return", "true", "false", "nil", "null",
	"error",
]);

/**
 * One match of the scanner: URL | path | [quoted string] | number | word |
 * operator run. Order of alternatives matters — more specific shapes first.
 *
 * Two variants. The prompt variant omits quoted-string recognition entirely:
 * prose apostrophes ("don't") would otherwise open a literal that swallows
 * everything up to the next quote character and silently delete whole clauses
 * from the stream — exactly the text the prompt domain exists to compare.
 */
const TOKEN_RE = new RegExp(
	[
		"(https?://\\S+)", // 1 URL
		"((?:[A-Za-z0-9_.\\-/]*\\/)+[A-Za-z0-9_.\\-]+)", // 2 path-like
		"(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')", // 3 quoted string
		"(\\d+(?:\\.\\d+)?)", // 4 number
		"([A-Za-z_][A-Za-z0-9_]*)", // 5 identifier / word
		"(=>|->|::|[{}()\\[\\]=:,;.!?<>/+\\-*%&|^~@#$\\\\]+)", // 6 operator/punct run
	].join("|"),
	"g",
);

const TOKEN_RE_NO_QUOTES = new RegExp(
	[
		"(https?://\\S+)",
		"((?:[A-Za-z0-9_.\\-/]*\\/)+[A-Za-z0-9_.\\-]+)",
		"(\\d+(?:\\.\\d+)?)",
		"([A-Za-z_][A-Za-z0-9_]*)",
		"(=>|->|::|[{}()\\[\\]=:,;.!?<>/+\\-*%&|^~@#$\\\\]+)",
	].join("|"),
	"g",
);

/** Options for {@link tokenizeText}. */
export interface TokenizeTextOptions {
	/** Drop prompt stop words after tokenising. */
	stopwords?: boolean;
	/** Blind-rename non-keyword identifiers to ID (tool-result mode). */
	blindIdentifiers?: boolean;
}

/**
 * Tokenise free text into the normalised stream shared by the prompt and
 * tool-result domains. Newlines survive as NL tokens so line-oriented results
 * keep their shape.
 */
export function tokenizeText(text: string, opts: TokenizeTextOptions): string[] {
	const out: string[] = [];
	if (!text) return out;

	let lastEnd = 0;
	// Prompts scan without the quoted-string alternative (see TOKEN_RE_NO_QUOTES);
	// its capture groups are shifted one slot earlier, so map them explicitly.
	const promptsMode = opts.stopwords === true;
	const re = promptsMode ? TOKEN_RE_NO_QUOTES : TOKEN_RE;
	re.lastIndex = 0;
	for (let m = re.exec(text); m !== null; m = re.exec(text)) {
		// Newlines in the gap between matches are structural: one NL per line break.
		const gap = text.slice(lastEnd, m.index);
		for (let i = 0; i < gap.length; i++) {
			if (gap[i] === "\n") out.push("NL");
		}
		lastEnd = m.index + m[0].length;

		const g = m as unknown as string[];
		const [url, path, str, num, word, op] = (
			promptsMode
				? [g[1], g[2], undefined, g[3], g[4], g[5]]
				: [g[1], g[2], g[3], g[4], g[5], g[6]]
		) as [string | undefined, string | undefined, string | undefined, string | undefined, string | undefined, string | undefined];
		if (url) {
			out.push("URI");
		} else if (path) {
			out.push("PATH");
		} else if (str) {
			out.push("STR");
		} else if (num) {
			out.push("NUM");
		} else if (word) {
			const lower = word.toLowerCase();
			if (opts.blindIdentifiers && !KEPT_KEYWORDS.has(lower)) {
				out.push("ID");
			} else if (opts.stopwords && PROMPT_STOP_WORDS.has(lower)) {
				// dropped
			} else {
				out.push(lower);
			}
		} else if (op) {
			out.push(op);
		}
	}
	return out;
}

/** User-prompt tokenisation: prose words kept (lowercased), stop words removed. */
export function tokenizePrompt(text: string): string[] {
	return tokenizeText(text, { stopwords: true });
}

/**
 * Tool-result tokenisation: identifiers blind-renamed to ID per the issue's
 * Detector-2 spec, with truncation for very large bodies — first half and last
 * half of `maxTokens`, the excised middle replaced by a single MID:<fnv> token
 * so two results matching head-and-tail score near but below 1.0.
 */
export function tokenizeResult(text: string, maxTokens: number): string[] {
	let tokens = tokenizeText(text, { blindIdentifiers: true });
	if (maxTokens > 0 && tokens.length > maxTokens) {
		const half = Math.floor(maxTokens / 2);
		const middle = tokens.slice(half, tokens.length - half);
		const midHash = fnv1a64(middle.join("\u001f")).toString(16);
		tokens = [...tokens.slice(0, half), `MID:${midHash}`, ...tokens.slice(tokens.length - half)];
	}
	return tokens;
}

/** Cap on recursive object expansion inside tool-call arguments. */
const MAX_EXPANDED_KEYS = 16;
/** Depth cap for nested objects/arrays before they collapse to a structural hash tag. */
const MAX_EXPANSION_DEPTH = 2;

function appendValue(value: unknown, out: string[], depth: number): void {
	if (value === null || value === undefined) {
		out.push("NIL");
		return;
	}
	switch (typeof value) {
		case "number":
			out.push("NUM");
			return;
		case "boolean":
			out.push("BOOL");
			return;
		case "string":
			// String VALUES keep their content (lowercased, no stop-word removal):
			// for bash/read-shaped calls the value is the discriminating signal.
			out.push(...tokenizeText(value, {}));
			return;
		default:
			break;
	}
	// Objects/arrays expand structurally up to the caps; beyond them they hash,
	// so identity stays stable without unbounded streams.
	if (depth >= MAX_EXPANSION_DEPTH) {
		out.push(`STRUCT:${fnv1a64(JSON.stringify(value)).toString(16).slice(0, 8)}`);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			out.push("EMPTYARR");
			return;
		}
		for (const item of value) appendValue(item, out, depth + 1);
		return;
	}
	if (typeof value === "object") {
		const keys = Object.keys(value).sort();
		if (keys.length === 0) {
			out.push("EMPTYOBJ");
			return;
		}
		if (keys.length > MAX_EXPANDED_KEYS) {
			out.push(`STRUCT:${fnv1a64(JSON.stringify(value)).toString(16).slice(0, 8)}`);
			return;
		}
		for (const k of keys) {
			out.push(k.toLowerCase());
			appendValue((value as Record<string, unknown>)[k], out, depth + 1);
		}
		return;
	}
	// Functions/symbols cannot occur in parsed JSON args; degrade to a tag.
	out.push("OPAQUE");
}

/**
 * Normalise one tool call into its structural token stream (issue #145
 * Detector 1): the tool name verbatim, then each top-level argument key
 * (sorted, so key order never matters) followed by its normalised value.
 *
 * Note on reuse: the issue suggested reusing `normalizeToolCall()` from
 * tool-trajectory's arg-parser. That module canonicalises bash/git/gh commands
 * into base+flags+target for loop detection — it collapses away exactly the
 * argument structure this detector needs to compare (typed values, multiple
 * keys). It is therefore not reused here; the shared action stream builder
 * (`buildToolStream`) IS reused upstream so call pairing agrees with every
 * other analyzer.
 */
export function tokenizeToolCall(name: string, args: Record<string, unknown> | undefined): string[] {
	const out: string[] = [name];
	const keys = Object.keys(args ?? {}).sort();
	for (const key of keys) {
		out.push(key.toLowerCase());
		appendValue((args as Record<string, unknown>)[key], out, 0);
	}
	return out;
}
