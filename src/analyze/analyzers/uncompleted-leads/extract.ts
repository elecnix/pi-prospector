/**
 * Deterministic lead extraction from tool-result text (issue #216).
 *
 * A *lead* is something valuable the tool output surfaced that the agent might
 * want to pursue: a file path (grep hit, error message, test output), a URL or
 * documentation reference printed in a result, a suggested command. Extraction
 * is deliberately narrow — three shape-based classes, no LLM, no natural-language
 * guessing — because every false lead here becomes noise in the graph.
 *
 * Pure functions only: no session access, no I/O.
 */

import type { LeadType, UncompletedLeadsConfig } from "./config.js";

/** One extracted lead before completion matching. */
export interface RawLead {
	type: LeadType;
	value: string;
}

/**
 * Common CLI verbs whose mention in backticks or after a `$` prompt reads as a
 * *suggested command* rather than prose or a bare identifier. Deliberately a
 * small fixed allowlist: `run \`the thing\`` is a suggestion; `` `some random
 * words` `` is not.
 */
const COMMAND_HEADS = new Set([
	"git",
	"gh",
	"npm",
	"npx",
	"yarn",
	"pnpm",
	"node",
	"cargo",
	"pip",
	"pip3",
	"python",
	"python3",
	"go",
	"make",
	"docker",
	"kubectl",
	"curl",
	"wget",
	"tsc",
	"eslint",
	"prettier",
	"jest",
	"vitest",
	"pytest",
	"grep",
	"rg",
]);

const MAX_LEAD_LENGTH = 200;

/** Trailing punctuation to strip when a match ran into sentence punctuation. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/;

function stripTrailingPunct(value: string): string {
	return value.replace(TRAILING_PUNCT, "");
}

// ──────────────────────────── URLs ────────────────────────────

/**
 * http(s) URLs. The character class stops at whitespace and at the brackets
 * that markdown/HTML commonly wrap links in (`<…>`, `(…)`, `[…]`, `"…"`, `'…'`).
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`\\)\]}]+/g;

export function extractUrls(text: string): RawLead[] {
	const out: RawLead[] = [];
	for (const m of text.matchAll(URL_PATTERN)) {
		const value = stripTrailingPunct(m[0]);
		if (value.length >= 8 && value.length <= MAX_LEAD_LENGTH) out.push({ type: "url", value });
	}
	return dedupe(out);
}

// ──────────────────────────── paths ────────────────────────────

/**
 * Path-shaped tokens containing at least one `/`. Matches grep hits
 * (`src/db/queries.ts:42:`), error payloads (`ENOENT … open '/src/auth/login.ts'`)
 * and test output alike. Absolute, `./`, `../` and `~/` prefixes are matched
 * explicitly; relative paths must carry an extension somewhere so running prose
 * ("and/or", "input/output") never matches.
 */
const PATH_PATTERN = /(?:\.{1,2}\/|~\/|\/)?(?:(?:[A-Za-z0-9_.@%+-]+\/)+[A-Za-z0-9_.@%+-]+)/g;

function looksLikePath(value: string): boolean {
	if (value.length === 0 || value.length > MAX_LEAD_LENGTH) return false;
	if (/^(\.{1,2}|~)\//.test(value)) return true;
	if (value.startsWith("/")) return true;
	// Relative path: require a dotted segment (an extension) somewhere, so plain
	// word/slash/word shapes cannot masquerade as paths.
	return value.split("/").some((seg) => seg.includes("."));
}

export function extractPaths(text: string): RawLead[] {
	// Strip URL spans first so a URL's path component does not double as a
	// file-path lead.
	const withoutUrls = text.replace(URL_PATTERN, " ");
	const out: RawLead[] = [];
	for (const m of withoutUrls.matchAll(PATH_PATTERN)) {
		const value = stripTrailingPunct(m[0]);
		if (!looksLikePath(value)) continue;
		out.push({ type: "path", value });
	}
	return dedupe(out);
}

// ──────────────────────────── suggested commands ────────────────────────────

/** A fenced span on one line: `` `npm install left-pad` ``. */
const FENCED_COMMAND_PATTERN = /`([^`\n]{2,120})`/g;
/** A shell-prompt line: `$ git status`. */
const PROMPT_LINE_PATTERN = /^[ \t]*\$\s+(\S[^\n]{1,200})$/gm;

function commandFromCandidate(candidate: string): string | null {
	const trimmed = candidate.trim();
	if (trimmed.length < 2 || trimmed.length > MAX_LEAD_LENGTH) return null;
	const head = trimmed.split(/\s+/)[0] ?? "";
	return COMMAND_HEADS.has(head) ? trimmed : null;
}

export function extractCommands(text: string): RawLead[] {
	const out: RawLead[] = [];
	for (const m of text.matchAll(FENCED_COMMAND_PATTERN)) {
		const inner = m[1] ?? "";
		const value = stripTrailingPunct(commandFromCandidate(inner) ?? "");
		if (value) out.push({ type: "command", value });
	}
	for (const m of text.matchAll(PROMPT_LINE_PATTERN)) {
		const value = stripTrailingPunct(commandFromCandidate(m[1] ?? "") ?? "");
		if (value) out.push({ type: "command", value });
	}
	return dedupe(out);
}

// ──────────────────────────── combined ────────────────────────────

function dedupe(leads: RawLead[]): RawLead[] {
	const seen = new Set<string>();
	const out: RawLead[] = [];
	for (const lead of leads) {
		const key = `${lead.type}\u0000${lead.value}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(lead);
	}
	return out;
}

/**
 * Extract every enabled lead class from one tool result's text, in stable
 * order: paths, then URLs, then commands. Deduped per class within the result.
 */
export function extractLeads(text: string, config: UncompletedLeadsConfig): RawLead[] {
	const enabled = new Set<string>(config.enabledTypes);
	const out: RawLead[] = [];
	if (enabled.has("path")) out.push(...extractPaths(text));
	if (enabled.has("url")) out.push(...extractUrls(text));
	if (enabled.has("command")) out.push(...extractCommands(text));
	return out;
}
