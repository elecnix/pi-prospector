/**
 * Grounded-claims consistency detection (issue #100).
 *
 * Two deterministic, turn-anchored checks that compare what the agent *claimed*
 * against what actually happened in the transcript. Neither needs a model; a
 * check fires or it doesn't, and when it fires the evidence is the discrepancy
 * itself.
 *
 *   - **ungrounded-claim** — the assistant states a concrete fact (a number, a
 *     filename/path, a test count, a percentage, a line reference) in its
 *     reply, and that fact appears nowhere in the turn's tool results. When the
 *     turn carried no tool results at all there is nothing to ground against
 *     and the check stays quiet — an ungrounded claim is only provable when the
 *     agent had evidence in front of it and contradicted or ignored it.
 *     Claims the *user* introduced are excluded: repeating the user's own
 *     words back is not fabrication.
 *
 *   - **unacted-request** — the user message contains a concrete actionable
 *     request from a small curated catalogue (run the tests, build, open a PR,
 *     commit, push, delete a named path) and no tool call in this turn — or
 *     the immediately following turn, for the acknowledge-then-act pattern —
 *     actually did it. The catalogue is deliberately narrow: each entry pairs
 *     a request shape with its own action matcher, so "run the tests" is
 *     satisfied by a test-runner invocation, not by any random command.
 *
 * Turn construction is reused from turn-pair-core (`buildTurnPairs`); call/
 * result pairing is reused from the shared action stream
 * (`src/analyze/tool-stream.ts`), so "the third call" and "that call's result"
 * mean exactly what they mean everywhere else. Tool-result text is read from
 * the carrying rows' `content_text`, concatenated per turn — the check asks
 * whether a fact appeared anywhere in what the tools returned, which is a
 * whole-turn question, not a per-call one.
 *
 * Everything here is pure and deterministic over the message rows.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream, type ToolInvocation } from "../../tool-stream.js";
import { buildTurnPairs } from "../turn-pair-core/build.js";
import type { GroundedClaimsConfig } from "./config.js";

/** The two consistency checks. */
export const UNGROUNDED_CLAIM = "ungrounded-claim";
export const UNACTED_REQUEST = "unacted-request";

/** What kind of concrete fact an ungrounded claim is about. */
export type ClaimKind = "number" | "count" | "percentage" | "path" | "location" | "line-ref";

export type SignalKind = typeof UNGROUNDED_CLAIM | typeof UNACTED_REQUEST;

/** One detected discrepancy: a signal is the finding, anchored to one turn. */
export interface ConsistencySignal {
	pairIndex: number;
	userMessageId: string;
	signal: SignalKind;
	/** For `ungrounded-claim`: the kind of fact. For `unacted-request`: "request". */
	claimKind: ClaimKind | "request";
	/** The verbatim claim token, or the request trigger sentence excerpt. */
	claim: string;
	/** The catalogue entry that matched, for `unacted-request`; null otherwise. */
	requestType: string | null;
	/** Human-readable statement of the discrepancy. */
	detail: string;
	/** Fingerprint source of the turn's conversation content (identity input). */
	turnFingerprint: string;
}

// ─────────────────────────── normalisation ───────────────────────────

/**
 * Normalise text before matching: lowercase (paths and numbers are compared
 * case-insensitively — a false match costs far less than a false accusation),
 * Windows separators folded to forward slashes, leading `./` dropped. Applied
 * to claims and to both haystacks alike, so matching is symmetric.
 */
function normalizeText(s: string): string {
	return s.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Strip trailing punctuation a prose token may drag along (`src/x.ts,`). */
function stripTrailingPunctuation(token: string): string {
	return token.replace(/[.,;:!)\]"}']+$/, "");
}

function truncate(s: string, maxLen: number): string {
	const t = s.trim();
	return t.length > maxLen ? `${t.slice(0, maxLen)}…` : t;
}

// ─────────────────────────── claim extraction ───────────────────────────

interface Candidate {
	kind: ClaimKind;
	/** Normalised value searched for verbatim in the haystacks. */
	value: string;
	/** The verbatim text the claim was extracted from (for display). */
	verbatim: string;
}

/** Nouns whose adjacent number is a count worth grounding ("12 tests failed"). */
const COUNT_WORDS =
	/(?:tests?|cases?|files?|errors?|warnings?|lines?|matches|commits?|packages?|failures?|modules?|functions?|checks?|scenarios?|assertions?)\b/i;

/**
 * Whether a bare token looks like a file path rather than a flag, URL, or word.
 * A slash anywhere (absolute or relative), or a dotted final segment with a
 * non-empty extension — the same conservative shape files-in-play uses.
 */
function looksLikePath(token: string): boolean {
	if (token.includes("://")) return false;
	if (/^[|&;<>()]+$/.test(token)) return false;
	if (token.includes("/")) return true;
	return /^[^.].*\.[^.]+$/.test(token);
}

/** Extract every groundable claim candidate from an assistant reply. */
export function extractClaims(text: string): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	function push(kind: ClaimKind, value: string, verbatim: string): void {
		const v = value.trim();
		if (!v) return;
		// One stated fact is one claim, whatever shape it was read in ("128" vs
		// "128 tests") — otherwise the same sentence fires twice for one error.
		const key = v;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ kind, value: v, verbatim });
	}

	// Locations: `path.ext:NN` — grounded by the full location string appearing,
	// or by the path alone (the agent read the file; the line number rides on a
	// real reference rather than an invented one).
	for (const m of text.matchAll(/([A-Za-z0-9_.\-/\\]+\.[A-Za-z0-9]+):(\d{2,})/g)) {
		const value = normalizeText(`${m[1]}:${m[2]}`);
		push("location", value, m[0]);
	}

	// Path-shaped tokens and standalone line refs (`L42`), from whitespace /
	// quote-delimited tokens.
	for (const raw of text.split(/[\s"'`(){}<>|]+/)) {
		const clean = stripTrailingPunctuation(raw.trim());
		if (!clean) continue;
		const normalized = normalizeText(clean);
		// `path.ext:NN` tokens were already captured as locations above.
		if (/^[^\s]*\.[A-Za-z0-9]+:\d{2,}$/.test(normalized)) continue;
		if (looksLikePath(normalized)) {
			push("path", normalized, clean);
			continue;
		}
		const lineRef = /^L(\d{2,})$/i.exec(normalized);
		if (lineRef) push("line-ref", `:${lineRef[1]}`, clean);
	}

	// Counts: a number adjacent to a count noun, even single-digit ("3 tests").
	for (const m of text.matchAll(new RegExp(`(?<![\\w.])\\d[\\d,]*\\s*${COUNT_WORDS.source}`, "gi"))) {
		const digits = /^\d[\d,]*/.exec(m[0])?.[0].replace(/,/g, "") ?? "";
		if (!digits) continue;
		push("count", digits, m[0].trim());
	}

	// Percentages ("85%", "99.9%").
	for (const m of text.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)\s*%(?!\w)/g)) {
		const pct = m[1];
		if (pct) push("percentage", pct, m[0].trim());
	}

	// Bare integers of at least two digits ("128", "1,234"). Single digits are
	// noise: they appear somewhere in almost any tool output by chance, and a
	// check that fires on them trains the reader to ignore the output.
	for (const m of text.matchAll(/(?<![\w.])\d[\d,]*(?![\w.])/g)) {
		const digits = m[0].replace(/,/g, "");
		if (!/\d{2}/.test(digits)) continue;
		push("number", digits, m[0]);
	}

	return out;
}

// ─────────────────────────── request catalogue ───────────────────────────

/**
 * Bash invocations that only look at the world. Everything else is treated as
 * potentially acting — the asymmetry is deliberate: misclassifying a mutating
 * command as read-only would silence a real unacted-request, while treating a
 * reader as mutating only risks a missed signal, never a false accusation.
 */
const READ_ONLY_BASH = [
	/^(?:cat|ls|pwd|head|tail|grep|rg|find|wc|diff|stat|file|du|df|which|whoami|date|echo|printf|env|printenv|man|tree)\b/,
	/^git\s+(?:status|log|diff|show|blame|rev-parse|remote|branch|config\s+--get|describe)\b/,
	/^gh\s+(?:pr|run|issue|release|repo|api\s+--method=GET)\b[^&|;]*\b(?:view|list|checks|diff|search)?\b/,
	/^gh\s+(?:pr|issue)\s+view\b/,
	/^npm\s+(?:view|info|ls|list|search|test|run\s+(?:test|lint|typecheck))\b/,
	/^(?:yarn|pnpm)\s+(?:npm\s+)?(?:info|ls|list|why)\b/,
	/--version|-V\b/,
];

const TEST_RUN_RE =
	/\b(?:vitest|jest|mocha|karma|pytest|unittest|rspec|minitest|gotest|cypress|playwright)\b|\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b|\bcargo\s+test\b|\bgo\s+test\b|\bmake\s+test\b|\btsc\b|\beslint\b|\bruff\b|\bnode\s+--test\b/i;

const BUILD_RUN_RE = /\bnpm\s+run\s+build\b|\byarn\s+build\b|\bpnpm\s+build\b|\bbun\s+run\s+build\b|\bgo\s+build\b|\bcargo\s+build\b|\bmaven\b|\bgradle\b|\btsc\b/i;

const PR_CREATE_RE = /\bgh\s+pr\s+create\b|\bhub\s+pull-request\b|\bglab\s+mr\s+create\b/i;
const GIT_COMMIT_RE = /\bgit\s+(?:\S+\s+)*commit\b/;
const GIT_PUSH_RE = /\bgit\s+(?:\S+\s+)*push\b/;

/** Request shapes worth checking, each pairing its trigger with its matcher. */
interface RequestRule {
	type: string;
	description: string;
	/** Detects the imperative request in one user sentence. */
	detect: RegExp;
	/** Matches an invocation that actually acted on the request. */
	act: (inv: ToolInvocation, objectBasename: string | null) => boolean;
	/** Whether the rule needs a path-shaped object extracted from the sentence. */
	needsObject: boolean;
}

const REQUEST_RULES: RequestRule[] = [
	{
		type: "test-run",
		description: "run the tests",
		needsObject: false,
		detect:
			/\b(?:run|execute|trigger|rerun|kick\s+off|launch)\b[^.!?;\n]*?\b(?:(?:the\s+|all\s+|full\s+|entire\s+|unit\s+|e2e\s+|integration\s+)?tests?|specs?|test\s+suites?|check)\b/i,
		act: (inv) =>
			inv.name === "bash" && TEST_RUN_RE.test(stringArg(inv, "command")),
	},
	{
		type: "build-run",
		description: "run the build",
		needsObject: false,
		detect:
			/\b(?:run|execute|do|kick\s+off|trigger)\b[^.!?;\n]*?\bbuild\b|\b(?:re)?build\b\s+(?:it|this|the)\b|\bcompile\b\s+(?:it|this|the)/i,
		act: (inv) =>
			inv.name === "bash" && BUILD_RUN_RE.test(stringArg(inv, "command")),
	},
	{
		type: "pr-create",
		description: "open a pull request",
		needsObject: false,
		detect: /\b(?:open|create|submit|file|draft|raise)\b[^.!?;\n]*?\b(?:pull\s+requests?|prs?|merge\s+requests?)\b/i,
		act: (inv) =>
			inv.name === "bash" && PR_CREATE_RE.test(stringArg(inv, "command")),
	},
	{
		type: "commit",
		description: "commit the work",
		needsObject: false,
		detect: /\bcommit\b(?!t?(?:ing|ed|s)\b)/i,
		act: (inv) =>
			inv.name === "bash" && GIT_COMMIT_RE.test(stringArg(inv, "command")),
	},
	{
		type: "push",
		description: "push the branch",
		needsObject: false,
		detect: /\bpush\b(?!e?(?:ing|ed|es)\b)/i,
		act: (inv) =>
			inv.name === "bash" && GIT_PUSH_RE.test(stringArg(inv, "command")),
	},
	{
		type: "delete-target",
		description: "delete the named file",
		needsObject: true,
		detect: /\b(?:delete|remove)\b[^.!?;\n]*/i,
		act: (inv, objectBasename) => {
			if (!objectBasename) return false;
			const lower = objectBasename.toLowerCase();
			if (inv.name === "bash") {
				const cmd = stringArg(inv, "command");
				return /\brm\s|\brmdir\s|\bgit\s+rm\b|\btrash\s/.test(cmd) && cmd.toLowerCase().includes(lower);
			}
			return /delete|remove|unlink/i.test(inv.name) && JSON.stringify(inv.args).toLowerCase().includes(lower);
		},
	},
];

function stringArg(inv: ToolInvocation, key: string): string {
	const v = inv.args[key];
	return typeof v === "string" ? v : "";
}

/**
 * Sentences that must not be read as requests even though they contain an
 * imperative verb: slash-command lines ("/compact"), questions ("did you run
 * the tests?"), and negations ("don't run the tests yet").
 */
function isActionableSentence(sentence: string, verbMatch: RegExpExecArray | null): boolean {
	const s = sentence.trim();
	if (s.length === 0 || s.startsWith("/")) return false;
	if (s.endsWith("?") || s.endsWith("？")) return false;
	if (verbMatch && verbMatch.index > 0) {
		const prefix = s.slice(0, verbMatch.index);
		if (
			/\b(?:don'?t|dont|do\s+not|never|no\s+need|stop|skip|avoid|hold\s+off|not\s+yet|forget)\b/i.test(prefix)
		) {
			return false;
		}
	}
	return true;
}

/**
 * Extract the path-shaped object of a delete/remove sentence, as its basename.
 * Only path-shaped objects count: "delete the debug logging" is not concrete
 * enough to accuse anyone of ignoring.
 */
function deleteTargetBasename(sentence: string): string | null {
	for (const raw of sentence.split(/[\s"'`(){}<>|]+/)) {
		const clean = stripTrailingPunctuation(raw.trim());
		const normalized = normalizeText(clean);
		if (!looksLikePath(normalized)) continue;
		const segments = normalized.split("/");
		const base = segments[segments.length - 1];
		if (base && base.length > 0) return base;
	}
	return null;
}

// ─────────────────────────── per-turn scan ───────────────────────────

interface TurnScan {
	pairIndex: number;
	userMessageId: string;
	startRole: string;
	fingerprintSource: string;
	resultText: string;
	assistantText: string;
	hasAssistantMessage: boolean;
	invocations: ToolInvocation[];
}

function scanTurns(messages: readonly MessageRow[]): TurnScan[] {
	const pairs = buildTurnPairs([...messages]);
	const byId = new Map<string, MessageRow>();
	for (const m of messages) byId.set(m.id, m);

	const stream = buildToolStream([...messages]);
	const invocationsByMessage = new Map<string, ToolInvocation[]>();
	for (const inv of stream.invocations) {
		const list = invocationsByMessage.get(inv.messageId) ?? [];
		list.push(inv);
		invocationsByMessage.set(inv.messageId, list);
	}

	return pairs.map((pair, i) => {
		const rows = pair.messageIds.map((id) => byId.get(id)).filter((r): r is MessageRow => r !== undefined);
		const startRow = byId.get(pair.userMessageId);
		let resultText = "";
		for (const r of rows) {
			if (r.role === "toolResult" && r.content_text) resultText += `\n${r.content_text}`;
		}
		const fingerprintSource = rows
			.map((r) => `${r.id}:${(r.content_text ?? "").length}:${(r.tool_calls ?? "").length}`)
			.join("|");
		const nextPair = pairs[i + 1];
		const nextRows = nextPair
			? nextPair.messageIds.map((id) => byId.get(id)).filter((r): r is MessageRow => r !== undefined)
			: [];
		const nextInvocations = nextRows.flatMap((r) => invocationsByMessage.get(r.id) ?? []);
		return {
			pairIndex: pair.index,
			userMessageId: pair.userMessageId,
			startRole: startRow?.role ?? "",
			fingerprintSource,
			resultText,
			assistantText: pair.assistantText,
			hasAssistantMessage: rows.some((r) => r.role === "assistant"),
			invocations: [
				...rows.flatMap((r) => invocationsByMessage.get(r.id) ?? []),
				...nextInvocations,
			],
		};
	});
}

/**
 * Run both checks across every turn of a session. Pure and deterministic over
 * the message rows; see the module doc comment for the heuristics.
 */
export function scanConsistencySignals(
	messages: readonly MessageRow[],
	config: GroundedClaimsConfig,
): ConsistencySignal[] {
	const turns = scanTurns(messages);
	const signals: ConsistencySignal[] = [];

	for (const turn of turns) {
		const haystack = normalizeText(turn.resultText);
		const normalizedUserText = (() => {
			const row = messages.find((m) => m.id === turn.userMessageId);
			return normalizeText(row?.content_text ?? "");
		})();
		const turnSignals: ConsistencySignal[] = [];

		// Check 1: grounded claims. Quiet unless the turn actually had tool
		// results — without evidence in front of it, absence proves nothing.
		if (haystack.length > 0 && turn.assistantText.trim().length > 0) {
			for (const candidate of extractClaims(turn.assistantText)) {
				// A fact the user themselves stated is context, not fabrication.
				if (normalizedUserText.includes(candidate.value)) continue;
				let grounded = haystack.includes(candidate.value);
				if (!grounded && candidate.kind === "location") {
					// `src/a.ts:42`: grounded when the agent actually saw that exact
					// reference, or at least the file it points into.
					const pathPart = candidate.value.slice(0, candidate.value.lastIndexOf(":"));
					grounded = haystack.includes(pathPart);
				}
				if (!grounded && candidate.kind === "line-ref") {
					// `L42` and `:42` name the same line; either form grounds it.
					const digits = candidate.value.slice(1);
					grounded = haystack.includes(`l${digits}`);
				}
				if (grounded) continue;
				turnSignals.push({
					pairIndex: turn.pairIndex,
					userMessageId: turn.userMessageId,
					signal: UNGROUNDED_CLAIM,
					claimKind: candidate.kind,
					claim: truncate(candidate.verbatim, 120),
					requestType: null,
					detail: `claimed "${truncate(candidate.verbatim, 120)}" (${candidate.kind}) but no tool result in the turn contains it`,
					turnFingerprint: turn.fingerprintSource,
				});
			}
		}

		// Check 2: unacted requests. Needs a completed reply (the agent answered)
		// on a genuine user-message boundary — a bashExecution turn start carries
		// no request, and an unfinished turn has claimed nothing yet.
		if (turn.startRole === "user" && turn.hasAssistantMessage) {
			const userRow = messages.find((m) => m.id === turn.userMessageId);
			const userText = userRow?.content_text ?? "";
			const sentences = userText.split(/(?<=[.!?])\s+|\n+/);
			for (const sentence of sentences) {
				for (const rule of REQUEST_RULES) {
					const detectRe = new RegExp(rule.detect.source, rule.detect.flags.replace("g", ""));
					const match = detectRe.exec(sentence);
					if (!match) continue;
					if (!isActionableSentence(sentence, match)) continue;

					const objectBasename = rule.needsObject ? deleteTargetBasename(sentence) : null;
					if (rule.needsObject && !objectBasename) continue;
					const acted = turn.invocations.some((inv) => rule.act(inv, objectBasename));
					if (acted) continue;

					turnSignals.push({
						pairIndex: turn.pairIndex,
						userMessageId: turn.userMessageId,
						signal: UNACTED_REQUEST,
						claimKind: "request",
						claim: truncate(sentence, 160),
						requestType: rule.type,
						detail: `asked to ${rule.description} ("${truncate(sentence, 120)}") but no tool call in this or the following turn matched`,
						turnFingerprint: turn.fingerprintSource,
					});
					break; // one request type per sentence is enough
				}
			}
		}

		signals.push(...turnSignals.slice(0, config.maxSignalsPerTurn));
	}

	return signals;
}

