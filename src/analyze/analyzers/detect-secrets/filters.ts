/**
 * detect-secrets exclusion filters: the ported false-positive heuristics that
 * are detect-secrets' distinctive contribution.
 *
 * Provenance: ported from Yelp detect-secrets **v1.5.0**, licensed
 * **BSD-3-Clause** (`detect_secrets/filters/heuristic.py` and the filtering
 * behaviour of its plugins). Source:
 * https://github.com/Yelp/detect-secrets/tree/v1.5.0/detect_secrets/filters
 * The upstream licence is recorded here per the repo's provenance rules; the
 * heuristics are re-expressed as pure TypeScript predicates. No subprocess and
 * no binary — everything runs deterministically in-process.
 *
 * Why this matters here: session transcripts are full of example tokens,
 * placeholders, and quoted documentation. A bare pattern catalogue flags them
 * in droves; these filters are the best-available catalogue of "looks like a
 * secret but isn't". Every filter is an individually testable pure function
 * applied **after** candidate generation (see `generators.ts`), so a candidate
 * must survive every enabled filter to become a finding.
 *
 * Each filter carries a stable kebab-case `id` (the config surface's
 * `disabledFilters` entries map 1:1) and the upstream function it ports in its
 * provenance comment.
 *
 * Filters that need surrounding context receive it through
 * {@link ExclusionFilterContext}: the matched value, the line containing the
 * match, the full field text, and the match offset. Value-only filters ignore
 * the context fields.
 */

import { calculateHexShannonEntropy, calculateShannonEntropy } from "./generators.js";

/** Everything a filter may look at when deciding to exclude a candidate. */
export interface ExclusionFilterContext {
	/** The candidate secret value produced by a generator. */
	value: string;
	/** The line of the field text that contains the match. */
	line: string;
	/** The full field text the candidate was found in. */
	text: string;
	/** Character offset of the match within `text`. */
	index: number;
	/** Id of the generator rule that produced the candidate. */
	ruleId: string;
}

/** Options a filter may consult (resolved analyzer config values). */
export interface ExclusionFilterOptions {
	/**
	 * When set, overrides the per-plugin upstream entropy thresholds
	 * (hex 3.0, base64 4.5). Absent means "use upstream defaults".
	 */
	entropyThreshold?: number;
}

/** One exclusion heuristic: a stable id plus its pure predicate. */
export interface ExclusionFilter {
	id: string;
	label: string;
	applies: (ctx: ExclusionFilterContext, opts: ExclusionFilterOptions) => boolean;
}

// ──────────────────── value-only heuristics ────────────────────

/**
 * Ports `detect_secrets.filters.heuristic.is_templated_secret`: filters
 * secrets shaped like `{secret}`, `<secret>`, or `${secret}` — template
 * placeholders, not credentials. A one-character secret is excluded outright
 * (upstream raises IndexError on it and treats it as a false positive).
 */
export function isTemplatedSecret(value: string): boolean {
	if (value.length <= 1) return true;
	const first = value[0]!;
	const last = value[value.length - 1]!;
	return (
		(first === "{" && last === "}") ||
		(first === "<" && last === ">") ||
		(first === "$" && value[1] === "{" && last === "}")
	);
}

/**
 * Ports `detect_secrets.filters.heuristic.is_prefixed_with_dollar_sign`:
 * `$VARIABLE` references are variable uses, not secret literals. Best used on
 * text that actually uses `$` as a reference syntax; disable the filter
 * otherwise.
 */
export function isPrefixedWithDollarSign(value: string): boolean {
	return value.startsWith("$");
}

/**
 * Ports `detect_secrets.filters.heuristic.is_not_alphanumeric_string`:
 * a candidate with no ASCII letters at all (e.g. `********`) is not a secret.
 */
export function isNotAlphanumericString(value: string): boolean {
	return !/[a-zA-Z]/.test(value);
}

/**
 * Ports `detect_secrets.filters.heuristic.is_sequential_string`: excludes
 * candidates that are substrings of well-known sequential character runs
 * (alphabets, digit runs, hexdigit runs, base64 tables). Upstream compares the
 * uppercased candidate against doubled sequence tables so any contiguous run
 * within them is caught.
 */
const SEQUENCES: readonly string[] = [
	// Base64 letters first: A..Z A..Z 0..9 +/
	("ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "0123456789" + "+/"),
	// Base64 numbers first: 0..9 A..Z A..Z +/
	("0123456789" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "+/"),
	// Alphanumeric sequences are caught by the base64 checks above.
	// Digit runs.
	("0123456789" + "0123456789"),
	// Hexdigit runs.
	("0123456789ABCDEF" + "0123456789ABCDEF"),
	("ABCDEFGHIJKLMNOPQRSTUVWXYZ" + "=/"),
];

export function isSequentialString(value: string): boolean {
	const upper = value.toUpperCase();
	return SEQUENCES.some((seq) => seq.includes(upper));
}

/**
 * Ports `detect_secrets.filters.heuristic.is_potential_uuid`: UUID-shaped
 * values name resources, not credentials.
 */
const UUID_REGEX = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

export function isPotentialUuid(value: string): boolean {
	return UUID_REGEX.test(value);
}

/**
 * Shannon-entropy rejection for the high-entropy plugins' own candidates: a
 * "high-entropy string" below its plugin's threshold is by definition not one.
 * This is the deterministic gate the upstream plugins apply after matching
 * (`HighEntropyStringsPlugin.analyze_line`); exposed as a filter so it can be
 * inspected and disabled like the rest. Keyword-context candidates are never
 * entropy-gated (upstream doesn't either).
 */
export function isLowEntropy(ctx: ExclusionFilterContext, opts: ExclusionFilterOptions): boolean {
	if (ctx.ruleId === "hex-high-entropy-string") {
		return !(calculateHexShannonEntropy(ctx.value) > (opts.entropyThreshold ?? 3.0));
	}
	if (ctx.ruleId === "base64-high-entropy-string") {
		return !(calculateShannonEntropy(ctx.value) > (opts.entropyThreshold ?? 4.5));
	}
	return false;
}

// ──────────────────── placeholder heuristics ────────────────────

/**
 * Example placeholders — the wordlist-driven idea behind upstream's
 * `filters.wordlist` ("known words that are definitely test keys", e.g.
 * AKIATEST) specialised to the placeholder vocabulary that dominates session
 * prose: `xxxx`, `YOUR_API_KEY`, `example…`, `test…`, `changeme`, and friends.
 * Anchored at the start of the value so a real credential merely *containing*
 * such a substring is not silently dropped.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
	/^(?:x|X|\*|•|\.|-|_){3,}/, // xxxx..., ****, ••••
	/^(.)\1{3,}$/, // one character repeated (aaaa..., 0000...) — port extension:
	//	detect-secrets' sequential-string filter misses single-char runs (its
	//	sequence tables contain no repeated character), but no real credential
	//	is one character repeated, and `password = "aaaa…"` is classic prose noise.
	/^your[_-]?(?:api[_-]?key|apikey|token|secret|password|key|credential)/i,
	/^my[_-]?(?:api[_-]?key|apikey|token|secret|password)/i,
	/^(?:example|sample|dummy|placeholder|fake|mock|foobar|changeme|change[_-]?me|not[_-]?a[_-]?real|redacted|insert[_-]?|replace[_-]?with|todo|fixme|delete[_-]?me)/i,
	/^test/i, // test-prefixed test keys (upstream's motivating AKIATEST case)
	/^(?:none|null|nil|undefined|true|false|empty|redacted)$/i,
];

export function isPlaceholderValue(value: string): boolean {
	return PLACEHOLDER_PATTERNS.some((re) => re.test(value));
}

// ──────────────────── line-context heuristics ────────────────────

/**
 * Ports `detect_secrets.filters.heuristic.is_likely_id_string`: a candidate
 * assigned to an `id`-like variable (`user_id = …`, `myId: …`) names a record
 * identifier, not a credential. Upstream searches the line *before* the
 * secret's offset with `(^(id|myid|userid)|_id)s?[^a-z0-9]`.
 */
const ID_DETECTOR_REGEX = /(^(id|myid|userid)|_id)s?[^a-z0-9]/i;

export function isLikelyIdString(ctx: ExclusionFilterContext): boolean {
	const before = ctx.line.slice(0, Math.max(0, ctx.line.indexOf(ctx.value)));
	return ID_DETECTOR_REGEX.test(before);
}

/**
 * Ports `detect_secrets.filters.heuristic.is_indirect_reference`: lines like
 * `secret = get_secret_key()` or `secret = request.headers['apikey']` read a
 * secret from somewhere else — the "value" is an expression, not a literal.
 * Line length is capped (as upstream does) to bound regex work.
 */
const INDIRECT_REFERENCE_REGEX = /([^\n=!:]*)\s*(:=?|[!=]{1,3})\s*([\w.-]+[[(][^\n]*[\])])/;

export function isIndirectReference(line: string): boolean {
	if (line.length > 1000) return false;
	return INDIRECT_REFERENCE_REGEX.test(line);
}

// ──────────────────── prose-context heuristics ────────────────────

/**
 * Known documentation/example URL hosts (RFC 2606 reserved hosts plus popular
 * placeholder echo services). A credential embedded in a URL pointing at one
 * of these hosts is quoted documentation, not a leak. Subdomain forms
 * (`api.example.com`) are covered by suffix matching on the reserved suffixes.
 */
const KNOWN_DOC_URL_SUFFIXES: readonly string[] = [
	"example.com",
	"example.org",
	"example.net",
	"localhost",
	"127.0.0.1",
	"0.0.0.0",
	"httpbin.org",
	"jsonplaceholder.typicode.com",
	"reqres.in",
	"httpstat.us",
	"postman-echo.com",
	"webhook.site",
	"yourdomain.com",
	"myserver.com",
];

const URL_REGEX = /(?:https?:)?\/\/[^\s'"<>)]+/g;

function urlHost(url: string): string {
	let rest = url.replace(/^https?:\/\//, "").replace(/^\/\//, "");
	rest = rest.split(/[/?#]/)[0] ?? "";
	// Strip userinfo and port.
	rest = rest.split("@").pop() ?? rest;
	rest = rest.split(":")[0] ?? "";
	return rest.toLowerCase();
}

/** True when the candidate sits inside a URL whose host is a known doc host. */
export function isDocumentationUrlContext(ctx: ExclusionFilterContext): boolean {
	for (const m of ctx.line.matchAll(URL_REGEX)) {
		const url = m[0];
		if (!url.includes(ctx.value)) continue;
		const host = urlHost(url);
		if (KNOWN_DOC_URL_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return true;
	}
	return false;
}

/**
 * Strings inside obvious code-sample contexts: fenced code blocks whose fence
 * info string marks them as examples/samples/documentation, lines carrying a
 * trailing example-marker comment, and candidates on a line that follows a
 * bare example marker. Quoted documentation is the single largest
 * false-positive source in session prose; this is the structural way to
 * recognise it.
 */
const FENCE_INFO_REGEX = /(^|\n)([`]{3,}|~{3,})([^\n]*)\n/g;
/** A line that is nothing but an example marker (comment syntax optional). */
const BARE_EXAMPLE_MARKER = /^\s*(?:#|\/\/|\/\*|<!--)?\s*(?:for\s+example|e\.g\.|example|sample|usage)\b[^\w]*$/i;
/** A trailing example-marker comment on the candidate's own line. */
const TRAILING_EXAMPLE_MARKER = /(?:#|\/\/)\s*(?:for\s+example|e\.g\.|example|sample|usage)\s*$/i;

function fenceRangeContaining(text: string, index: number): { info: string } | undefined {
	const fences: Array<{ pos: number; info: string; marker: string }> = [];
	for (const m of text.matchAll(FENCE_INFO_REGEX)) {
		fences.push({ pos: m.index ?? 0, info: (m[3] ?? "").trim(), marker: m[2] ?? "" });
	}
	// Walk paired fences; a candidate inside a pair belongs to that block.
	let open: { info: string; end: number } | undefined;
	for (const f of fences) {
		if (!open) {
			open = { info: f.info, end: f.pos + f.marker.length };
		} else {
			// Closing fence: if our index falls inside [open.start, close.pos], done.
			if (index >= open.end && index <= f.pos) return { info: open.info };
			open = undefined;
		}
	}
	if (open && index >= open.end) return { info: open.info }; // unclosed block runs to EOF
	return undefined;
}

const EXAMPLE_FENCE_INFO = /(?:example|sample|demo|documentation|docs|placeholder|fixture|usage)/i;

export function isInsideCodeSampleContext(ctx: ExclusionFilterContext): boolean {
	const range = fenceRangeContaining(ctx.text, ctx.index);
	if (range && EXAMPLE_FENCE_INFO.test(range.info)) return true;
	if (TRAILING_EXAMPLE_MARKER.test(ctx.line)) return true;
	// A bare marker on the immediately preceding non-empty line marks what
	// follows as an example ("# example" on its own line, then the assignment).
	const previousLine =
		(() => {
			const before = ctx.text.slice(0, ctx.index);
			const lastNewline = before.lastIndexOf("\n");
			if (lastNewline === -1) return ""; // candidate is on the first line
			return (
				before
					.slice(0, lastNewline)
					.split("\n")
					.filter((l) => l.trim().length > 0)
					.pop() ?? ""
			);
		})();
	return BARE_EXAMPLE_MARKER.test(previousLine);
}

// ──────────────────── filter table ────────────────────

/**
 * The exclusion heuristics applied to every candidate, in fixed order (cheap
 * value-only checks first, then line-level, then whole-text). Order matters
 * only for cost; a candidate is excluded when any enabled filter applies.
 */
export const EXCLUSION_FILTERS: readonly ExclusionFilter[] = [
	{
		id: "templated-secret",
		label: "Templated secret ({secret}, <secret>, ${secret})",
		applies: (ctx) => isTemplatedSecret(ctx.value),
	},
	{
		id: "dollar-prefix",
		label: "Prefixed with dollar sign ($VARIABLE reference)",
		applies: (ctx) => isPrefixedWithDollarSign(ctx.value),
	},
	{
		id: "not-alphanumeric",
		label: "No letters in the value",
		applies: (ctx) => isNotAlphanumericString(ctx.value),
	},
	{
		id: "sequential-string",
		label: "Sequential character run (alphabet, digits, hex, base64 table)",
		applies: (ctx) => isSequentialString(ctx.value),
	},
	{
		id: "low-entropy",
		label: "Below the plugin's shannon-entropy threshold",
		applies: isLowEntropy,
	},
	{
		id: "potential-uuid",
		label: "UUID-shaped value",
		applies: (ctx) => isPotentialUuid(ctx.value),
	},
	{
		id: "placeholder-value",
		label: "Example placeholder (xxxx, YOUR_API_KEY, example/test-prefixed)",
		applies: (ctx) => isPlaceholderValue(ctx.value),
	},
	{
		id: "likely-id-string",
		label: "Assigned to an id-like variable",
		applies: (ctx) => isLikelyIdString(ctx),
	},
	{
		id: "indirect-reference",
		label: "Value is an indirect reference (get_secret_key())",
		applies: (ctx) => isIndirectReference(ctx.line),
	},
	{
		id: "documentation-url",
		label: "Embedded in a known documentation/example URL",
		applies: (ctx) => isDocumentationUrlContext(ctx),
	},
	{
		id: "code-sample-context",
		label: "Inside an obvious code-sample context",
		applies: (ctx) => isInsideCodeSampleContext(ctx),
	},
];

/** Stable filter ids, for config validation and tests. */
export const EXCLUSION_FILTER_IDS: readonly string[] = EXCLUSION_FILTERS.map((f) => f.id);
