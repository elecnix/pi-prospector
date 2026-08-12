/**
 * assistant-reflection — what does the assistant's thinking/response reveal?
 *
 * The shipped analyzers answer "what went wrong inside this turn?" from the
 * user's perspective. `user-reply-acts` answers "what did the user do with the
 * assistant's response?" This analyzer answers a third question, from the
 * *assistant's* side: "what does the assistant's private reasoning and visible
 * response signal that is worth capturing?"
 *
 * It reads `thinkingText` and `assistantText` (NOT `userText` — that's
 * `user-reply-acts`'s job) and classifies four kinds of signal:
 *
 *   memories     — durable facts worth storing permanently (in global or
 *                  project AGENTS.md). The classifier *synthesises* a
 *                  candidate_text from the reasoning; no verbatim quote is
 *                  required because the fact is inferred, not extracted.
 *   mistakes     — the assistant acknowledging a mistake, with severity
 *                  (small / large / huge). The acknowledgement is stated
 *                  verbatim in the text, so each mistake carries a quote
 *                  validated as an exact substring.
 *   user_frustration — the assistant perceived the user as frustrated, angry,
 *                  or impatient, with level (mild / moderate / high). Inferred
 *                  from tone, no quote.
 *   user_acceptance  — the assistant perceived the user as satisfied, pleased,
 *                  or accepting, with level (mild / moderate / high). Inferred
 *                  from tone, no quote.
 *
 * This is the first analyzer to consume the thinking trace (`thinkingText`),
 * which `turn-pair-core` captures but no other LLM analyzer reads.
 *
 * The classifier is explicitly speculative — the assistant's self-reflection is
 * a hypothesis about what matters, not ground truth. This is the lower-precision
 * companion to `user-reply-acts`'s `memories` class (Track A, #130), which
 * extracts from the user's own words.
 *
 * One `classification` node per turn (anchored to the turn's user message).
 * Consumes the turn-pair-core node of the *same* turn. Ungated — every turn
 * with non-empty thinking or assistant text is classified, up to a per-session
 * cap applied in turn order. Cost is bounded only by the cap.
 *
 * Implements the full `user-reply-acts` robustness stack: native structured
 * output (responseSchema) with tool-call fallback, two-attempt agentic retry
 * with abstention escape, structural validation, and head+tail prompt
 * rendering for long thinking/response text.
 */

import { Type, type Static } from "typebox";
import { defineAnalyzer } from "../../src/analyze/authoring.js";
import type {
	Analyzer,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalysisResult,
	AnalysisUnit,
	SourceRef,
	EdgeSpec,
} from "../../src/analyze/types.js";
import { computeSourceSetHash, computeConfigHash, shortHash } from "../../src/analyze/input-hash.js";
import { resolveModelSpec } from "../../src/analyze/model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../src/analyze/edge-kinds.js";
import { buildTurnPairs } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import { TURN_PAIR_CORE_DEF } from "../../src/analyze/analyzers/turn-pair-core/index.js";

// ── config ──

const AssistantReflectionConfig = Type.Object({
	/**
	 * Which model classifies a turn: a tier name (`cheap`/`mid`/`expensive`) or
	 * an explicit `provider/model` spec, which `resolveModelSpec` passes through
	 * unchanged. Shipped default is `openrouter/inclusionai/ling-2.6-flash` —
	 * ~7× cheaper than the `cheap` tier for the same low-intelligence,
	 * high-volume, forced-tool-call task profile. Override via
	 * `analyzers["assistant-reflection"].tier` in prospector.json.
	 */
	tier: Type.String(),
	temperature: Type.Number(),
	reasoning: Type.Union([
		Type.Literal("off"),
		Type.Literal("minimal"),
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high"),
	]),
	/**
	 * Hard ceiling on turns classified per session. Classification is ungated
	 * (signal lives in smooth turns too), so this is the only cost bound.
	 * Applied in turn order — not friction-ranked.
	 */
	maxTurnsPerSession: Type.Number(),
	/** Min thinking+assistant chars to render into the prompt. */
	minContentChars: Type.Number(),
	/**
	 * Use the provider's native structured output (response_format) instead of
	 * tool-calling for schema enforcement. Default: true.
	 */
	structuredOutput: Type.Boolean(),
});
type AssistantReflectionConfig = Static<typeof AssistantReflectionConfig>;

const DEFAULT_CONFIG: AssistantReflectionConfig = {
	tier: "openrouter/inclusionai/ling-2.6-flash",
	temperature: 0,
	reasoning: "off",
	maxTurnsPerSession: 100,
	minContentChars: 1,
	structuredOutput: true,
};

function configOf(config: Record<string, unknown>): AssistantReflectionConfig {
	const c = config as Partial<AssistantReflectionConfig>;
	const tier = typeof c.tier === "string" && c.tier.length > 0 ? c.tier : DEFAULT_CONFIG.tier;
	return {
		tier,
		temperature: typeof c.temperature === "number" ? c.temperature : DEFAULT_CONFIG.temperature,
		reasoning:
			c.reasoning === "off" || c.reasoning === "minimal" || c.reasoning === "low" || c.reasoning === "medium" || c.reasoning === "high"
				? c.reasoning
				: DEFAULT_CONFIG.reasoning,
		maxTurnsPerSession: typeof c.maxTurnsPerSession === "number" && c.maxTurnsPerSession > 0 ? c.maxTurnsPerSession : DEFAULT_CONFIG.maxTurnsPerSession,
		minContentChars: typeof c.minContentChars === "number" && c.minContentChars >= 0 ? c.minContentChars : DEFAULT_CONFIG.minContentChars,
		structuredOutput: typeof c.structuredOutput === "boolean" ? c.structuredOutput : DEFAULT_CONFIG.structuredOutput,
	};
}

// ── prompt ──

export const CLASSIFY_PROMPT = `You are analyzing a coding assistant's private reasoning (thinking) and visible response to find signals worth capturing.

You are given:
  THINKING:  the assistant's private chain-of-thought reasoning for this turn.
  RESPONSE:  the assistant's visible reply to the user.

Look for four kinds of signal:

1. MEMORIES — durable facts worth storing permanently (in global or project AGENTS.md).
   Good memories: stable user preferences, communication style, durable workflow
   preferences, recurring project conventions, decisions likely to matter later,
   things that belong in global or project AGENTS.md.
   Bad memories: temporary task progress, implementation minutiae, one-off facts,
   obvious summaries, secrets or credentials.
   Each memory has: candidate_text (your synthesis of the fact, phrased for human
   review), scope (global or project), confidence (0.0 to 1.0 — this is
   speculative), rationale (one sentence: why it is durable and where it came
   from in the thinking/response).

2. MISTAKES — the assistant acknowledging a mistake or shortcoming.
   The acknowledgement must be stated in the thinking or response text, not
   inferred. Quote it verbatim.
   Severity: small (trivial slip, typo, wrong filename — no lasting impact),
             large (real error that cost turns — wrong approach, missed instruction),
             huge (damaging failure that derailed the session — deleted work, broke build).
   Each mistake has: quote (exact verbatim substring from the thinking or response),
   severity, rationale (one sentence: what the mistake was and why it happened).

3. USER_FRUSTRATION — the assistant perceived the user as frustrated, angry, or impatient.
   Level: mild (terse reply, slight impatience),
          moderate (repeated corrections, visible annoyance),
          high (angry outburst, explicit frustration).
   Each has: level, rationale (one sentence: how the assistant read the user's
   frustration and what triggered it).
   Only emit this when the THINKING shows the assistant noticing the user's
   frustration — not when the user's words are frustrated but the assistant
   did not reflect on it.

4. USER_ACCEPTANCE — the assistant perceived the user as satisfied, pleased, or accepting.
   Level: mild (ok, fine),
          moderate (happy with approach, explicit approval),
          high (this is exactly what I wanted, ship it).
   Each has: level, rationale (one sentence: how the assistant read the user's
   satisfaction and what prompted it).
   Only emit this when the THINKING shows the assistant noticing the user's
   satisfaction.

Judge only what the text supports. Do not invent signals. If nothing is
present, return empty arrays for all four fields.

Every MISTAKE quote MUST be an exact substring of the THINKING or RESPONSE text
— copy it verbatim, including typos or formatting. The quote will be checked.

Respond ONLY by calling the classify_reflection tool. Never answer in prose.`;

export const CLASSIFY_PROMPT_HASH = shortHash(`prompt(classify_reflection:${CLASSIFY_PROMPT})`);

/** Retry prompt: shown only on the second attempt when the first returned no usable verdict. */
export const RETRY_PROMPT = `Your previous response was not usable — the JSON did not contain a valid classification (every mistake needs a quote that is an exact verbatim substring of the THINKING or RESPONSE text).

Try again. Use only the provided classes:
  memories (scope: global|project), mistakes (severity: small|large|huge),
  user_frustration (level: mild|moderate|high), user_acceptance (level: mild|moderate|high).

If you genuinely cannot classify the turn — for example the thinking is in a
language you don't understand, is pure noise, or is empty — set the
classifier_abstention field with a reason and proposed class. When you abstain:
  - You MUST provide a reason (why you cannot classify).
  - You MUST propose the closest class (one of: memory, mistake, user_frustration,
    user_acceptance, other).
Abstaining is a last resort. Only use it when you truly cannot classify — not
when the turn is merely hard or ambiguous. When in doubt, pick the closest class
and emit it.`;

export const RETRY_PROMPT_HASH = shortHash(`prompt(classify_reflection_retry:${RETRY_PROMPT})`);

// ── schemas ──

const actObject = (props: Record<string, unknown>) =>
	Type.Object(props, { additionalProperties: false });

export const CLASSIFY_SCHEMA = Type.Object({
	memories: Type.Array(actObject({
		candidate_text: Type.String({ description: "The model's synthesis of the durable fact, phrased for human review." }),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		confidence: Type.Number({ description: "0.0 to 1.0 — this is speculative, confidence reflects that." }),
		rationale: Type.String({ description: "One short sentence: why this is durable and where it came from in the thinking/response." }),
	})),
	mistakes: Type.Array(actObject({
		quote: Type.String({ description: "Exact verbatim substring from the thinking or assistant text where the assistant acknowledges the mistake." }),
		severity: Type.Union([Type.Literal("small"), Type.Literal("large"), Type.Literal("huge")]),
		rationale: Type.String({ description: "One short sentence: what the mistake was and why it happened." }),
	})),
	user_frustration: Type.Array(actObject({
		level: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
		rationale: Type.String({ description: "One short sentence: how the assistant read the user's frustration and what triggered it." }),
	})),
	user_acceptance: Type.Array(actObject({
		level: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
		rationale: Type.String({ description: "One short sentence: how the assistant read the user's satisfaction and what prompted it." }),
	})),
}, { additionalProperties: false });

export const CLASSIFY_RESPONSE_SCHEMA = {
	name: "classify_reflection",
	schema: CLASSIFY_SCHEMA,
	strict: true as const,
};

/**
 * Retry schema: same as CLASSIFY_SCHEMA plus an optional classifier_abstention.
 * The abstention is only offered on the second attempt, so the model doesn't
 * see it as an easy escape on the first pass.
 */
export const CLASSIFY_SCHEMA_RETRY = Type.Object({
	memories: Type.Array(actObject({
		candidate_text: Type.String({ description: "The model's synthesis of the durable fact, phrased for human review." }),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		confidence: Type.Number({ description: "0.0 to 1.0 — this is speculative, confidence reflects that." }),
		rationale: Type.String({ description: "One short sentence: why this is durable and where it came from in the thinking/response." }),
	})),
	mistakes: Type.Array(actObject({
		quote: Type.String({ description: "Exact verbatim substring from the thinking or assistant text where the assistant acknowledges the mistake." }),
		severity: Type.Union([Type.Literal("small"), Type.Literal("large"), Type.Literal("huge")]),
		rationale: Type.String({ description: "One short sentence: what the mistake was and why it happened." }),
	})),
	user_frustration: Type.Array(actObject({
		level: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
		rationale: Type.String({ description: "One short sentence: how the assistant read the user's frustration and what triggered it." }),
	})),
	user_acceptance: Type.Array(actObject({
		level: Type.Union([Type.Literal("mild"), Type.Literal("moderate"), Type.Literal("high")]),
		rationale: Type.String({ description: "One short sentence: how the assistant read the user's satisfaction and what prompted it." }),
	})),
	classifier_abstention: Type.Union([
		actObject({
			reason: Type.String({ description: "Why you cannot classify this turn into the provided classes." }),
			proposed_class: Type.Union([
				Type.Literal("memory"),
				Type.Literal("mistake"),
				Type.Literal("user_frustration"),
				Type.Literal("user_acceptance"),
				Type.Literal("other"),
			]),
		}),
		Type.Null(),
	]),
}, { additionalProperties: false });

export const CLASSIFY_RESPONSE_SCHEMA_RETRY = {
	name: "classify_reflection_retry",
	schema: CLASSIFY_SCHEMA_RETRY,
	strict: true as const,
};

// Tool-call fallback schemas (for providers without response_format support)
export const CLASSIFY_TOOL = {
	name: "classify_reflection",
	description: "Submit the classification of a coding assistant's thinking and response: memories, mistakes, user frustration, and user acceptance.",
	parameters: CLASSIFY_SCHEMA,
};

export const CLASSIFY_TOOL_RETRY = {
	name: "classify_reflection",
	description: "Submit the classification of a coding assistant's thinking and response, or abstain with a reason if you genuinely cannot classify.",
	parameters: CLASSIFY_SCHEMA_RETRY,
};

// ── stored properties + interfaces ──

export interface MemoryCandidate {
	candidate_text: string;
	scope: "global" | "project";
	confidence: number;
	rationale: string;
}

export interface MistakeAct {
	quote: string;
	severity: "small" | "large" | "huge";
	rationale: string;
}

export interface UserFrustrationAct {
	level: "mild" | "moderate" | "high";
	rationale: string;
}

export interface UserAcceptanceAct {
	level: "mild" | "moderate" | "high";
	rationale: string;
}

export interface ClassifierAbstention {
	reason: string;
	proposed_class: "memory" | "mistake" | "user_frustration" | "user_acceptance" | "other";
}

export interface AssistantReflectionProperties {
	user_message_id: string;
	pair_index: number;
	/** Output key of the turn-pair-core node for the SAME turn (provenance). */
	core_output_key: string | null;
	memories: MemoryCandidate[];
	mistakes: MistakeAct[];
	user_frustration: UserFrustrationAct[];
	user_acceptance: UserAcceptanceAct[];
	/** Present only when the model abstained on the retry attempt. */
	abstention: ClassifierAbstention | null;
	/** Which attempt produced the verdict: 1 = first, 2 = retry. */
	attempt: 1 | 2;
}

// ── parsing ──

const VALID_SCOPES = new Set(["global", "project"]);
const VALID_SEVERITIES = new Set(["small", "large", "huge"]);
const VALID_LEVELS = new Set(["mild", "moderate", "high"]);
const VALID_PROPOSED_CLASSES = new Set(["memory", "mistake", "user_frustration", "user_acceptance", "other"]);

/**
 * Parse and validate the structured reply. Returns null if no usable verdict.
 * `visibleText` is the combined thinking+assistant text the model saw (after
 * head+tail truncation); mistake quotes are validated against it.
 */
export function parseReflection(
	raw: Record<string, unknown>,
	visibleText?: string,
): Omit<AssistantReflectionProperties, "user_message_id" | "pair_index" | "core_output_key" | "attempt"> | null {
	if (!Array.isArray(raw["memories"]) || !Array.isArray(raw["mistakes"]) ||
		!Array.isArray(raw["user_frustration"]) || !Array.isArray(raw["user_acceptance"])) {
		return null;
	}

	const memories: MemoryCandidate[] = [];
	for (const m of raw["memories"]) {
		if (!m || typeof m !== "object" || Array.isArray(m)) return null;
		const o = m as Record<string, unknown>;
		const scope = typeof o["scope"] === "string" && VALID_SCOPES.has(o["scope"]) ? (o["scope"] as MemoryCandidate["scope"]) : null;
		if (!scope) return null;
		const candidateText = typeof o["candidate_text"] === "string" ? o["candidate_text"].slice(0, 500) : "";
		if (candidateText.length === 0) return null;
		const confidence = typeof o["confidence"] === "number" ? Math.max(0, Math.min(1, o["confidence"])) : 0;
		memories.push({
			candidate_text: candidateText,
			scope,
			confidence,
			rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "",
		});
	}

	const mistakes: MistakeAct[] = [];
	for (const m of raw["mistakes"]) {
		if (!m || typeof m !== "object" || Array.isArray(m)) return null;
		const o = m as Record<string, unknown>;
		const severity = typeof o["severity"] === "string" && VALID_SEVERITIES.has(o["severity"]) ? (o["severity"] as MistakeAct["severity"]) : null;
		if (!severity) return null;
		const quote = typeof o["quote"] === "string" ? o["quote"].slice(0, 300) : "";
		if (quote.length === 0) return null;
		// Quote validation: exact substring of the visible text (thinking + response).
		if (!isQuoteValid(quote, visibleText)) continue;
		mistakes.push({
			quote,
			severity,
			rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "",
		});
	}

	const userFrustration: UserFrustrationAct[] = [];
	for (const f of raw["user_frustration"]) {
		if (!f || typeof f !== "object" || Array.isArray(f)) return null;
		const o = f as Record<string, unknown>;
		const level = typeof o["level"] === "string" && VALID_LEVELS.has(o["level"]) ? (o["level"] as UserFrustrationAct["level"]) : null;
		if (!level) return null;
		userFrustration.push({
			level,
			rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "",
		});
	}

	const userAcceptance: UserAcceptanceAct[] = [];
	for (const a of raw["user_acceptance"]) {
		if (!a || typeof a !== "object" || Array.isArray(a)) return null;
		const o = a as Record<string, unknown>;
		const level = typeof o["level"] === "string" && VALID_LEVELS.has(o["level"]) ? (o["level"] as UserAcceptanceAct["level"]) : null;
		if (!level) return null;
		userAcceptance.push({
			level,
			rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "",
		});
	}

	// Structural validation: an all-empty verdict (no arrays populated, no
	// abstention) is the model giving up. Reject so the agentic retry forces a
	// real answer.
	const hasSignal =
		memories.length > 0 || mistakes.length > 0 ||
		userFrustration.length > 0 || userAcceptance.length > 0;
	if (!hasSignal) return null;

	return {
		memories,
		mistakes,
		user_frustration: userFrustration,
		user_acceptance: userAcceptance,
		abstention: null,
	};
}

/**
 * Check that a quote is an exact substring of the visible text.
 * When visibleText is not provided (e.g. unit tests that only test parsing),
 * the check is skipped — the quote just needs to be non-empty.
 */
function isQuoteValid(quote: string, visibleText?: string): boolean {
	if (quote.length === 0) return false;
	if (visibleText === undefined) return true;
	return visibleText.includes(quote);
}

/** Accept JSON in the text channel too, for providers that answer that way. */
function extractJsonObject(text: string): Record<string, unknown> | null {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
	const candidate = fenced ? fenced[1] ?? "" : text;
	const start = candidate.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	for (let i = start; i < candidate.length; i++) {
		const ch = candidate[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>;
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

function extractVerdict(structured: unknown, text: string, visibleText?: string) {
	if (structured && typeof structured === "object" && !Array.isArray(structured)) {
		const v = parseReflection(structured as Record<string, unknown>, visibleText);
		if (v) return v;
	}
	const fromText = extractJsonObject(text);
	if (fromText) {
		const v = parseReflection(fromText, visibleText);
		if (v) return v;
	}
	return null;
}

/** Parse the abstention from a retry response. */
export function parseAbstention(raw: Record<string, unknown>): ClassifierAbstention | null {
	const ab = raw["classifier_abstention"];
	if (!ab || typeof ab !== "object" || Array.isArray(ab)) return null;
	const o = ab as Record<string, unknown>;
	const reason = typeof o["reason"] === "string" ? o["reason"].slice(0, 500) : "";
	const proposedClass = typeof o["proposed_class"] === "string" && VALID_PROPOSED_CLASSES.has(o["proposed_class"])
		? (o["proposed_class"] as ClassifierAbstention["proposed_class"])
		: null;
	if (!reason || !proposedClass) return null;
	return { reason, proposed_class: proposedClass };
}

function extractAbstention(structured: unknown, text: string): ClassifierAbstention | null {
	if (structured && typeof structured === "object" && !Array.isArray(structured)) {
		const a = parseAbstention(structured as Record<string, unknown>);
		if (a) return a;
	}
	const fromText = extractJsonObject(text);
	if (fromText) {
		const a = parseAbstention(fromText);
		if (a) return a;
	}
	return null;
}

// ── prompt rendering ──

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Render text with head + tail so the model sees the beginning and end of long
 * inputs. A flat head-only truncation hides late signals (a mistake
 * acknowledgement at the end of a long thinking block). Head+tail preserves
 * both with a gap marker in between.
 */
export function truncateHeadTail(s: string, max: number): string {
	if (s.length <= max) return s;
	const headLen = Math.floor(max * 0.6);
	const tailLen = max - headLen;
	return `${s.slice(0, headLen)}\n[… ${s.length - max} chars omitted …]\n${s.slice(s.length - tailLen)}`;
}

export function buildClassifyPrompt(input: { thinkingText: string; assistantText: string }): string {
	return [
		"THINKING:",
		truncateHeadTail(input.thinkingText, 2400),
		"",
		"RESPONSE:",
		truncateHeadTail(input.assistantText, 2400),
	].join("\n");
}

/** Diagnose why both attempts failed, for a precise error message. */
function diagnoseFailure(
	r1: { structured?: unknown; text?: string },
	r2: { structured?: unknown; text?: string },
	visibleText: string,
): string {
	if (!r1.structured && !r2.structured) return "Both attempts returned no structured output (likely transport errors or the model returned plain text).";

	function describe(raw: unknown): string {
		if (!raw || typeof raw !== "object") return "no structured output";
		const o = raw as Record<string, unknown>;
		const mem = Array.isArray(o["memories"]) ? o["memories"].length : 0;
		const mis = Array.isArray(o["mistakes"]) ? o["mistakes"].length : 0;
		const fr = Array.isArray(o["user_frustration"]) ? o["user_frustration"].length : 0;
		const ac = Array.isArray(o["user_acceptance"]) ? o["user_acceptance"].length : 0;
		const hasSignal = mem + mis + fr + ac > 0;
		if (!hasSignal) return "empty verdict (all arrays empty)";
		// Check quote validity for mistakes
		const allMistakes = Array.isArray(o["mistakes"]) ? o["mistakes"] : [];
		const badQuotes: string[] = [];
		for (let i = 0; i < allMistakes.length; i++) {
			const q = (allMistakes[i] as Record<string, unknown>)?.["quote"];
			if (typeof q !== "string" || q.length === 0) badQuotes.push(`mistake[${i}]: missing/empty quote`);
			else if (!visibleText.includes(q)) badQuotes.push(`mistake[${i}]: quote not substring of visible text`);
		}
		if (badQuotes.length > 0) return `quote validation: ${badQuotes.join("; ")}`;
		return "unknown validation failure";
	}

	return `Attempt 1: ${describe(r1.structured)}. Attempt 2: ${describe(r2.structured)}.`;
}

// ── analyzer ──

interface ReflectionMeta {
	thinkingText: string;
	assistantText: string;
	pairIndex: number;
	coreOutputKey: string | null;
}

/** Build the edges for a classification node. */
function buildEdges(unit: AnalysisUnit, meta: ReflectionMeta): EdgeSpec[] {
	const edges: EdgeSpec[] = [
		{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
	];
	if (meta.coreOutputKey) {
		edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.coreOutputKey, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 });
	}
	edges.push({ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 2 });
	return edges;
}

/** Build a successful classification result from a parsed verdict. */
function buildResult(
	unit: AnalysisUnit,
	meta: ReflectionMeta,
	verdict: Omit<AssistantReflectionProperties, "user_message_id" | "pair_index" | "core_output_key" | "attempt" | "abstention">,
	attempt: 1 | 2,
	response: { model: string; costUsd: number; tokensUsed: number; durationMs: number },
): AnalysisResult {
	const properties: AssistantReflectionProperties = {
		...verdict,
		abstention: null,
		attempt,
		user_message_id: unit.anchorRef,
		pair_index: meta.pairIndex,
		core_output_key: meta.coreOutputKey,
	};
	return {
		nodeKind: "classification",
		contentJson: properties as unknown as Record<string, unknown>,
		anchorKind: "message",
		anchorRef: unit.anchorRef,
		modelUsed: response.model,
		costUsd: response.costUsd,
		tokensUsed: response.tokensUsed,
		durationMs: response.durationMs,
		edges: buildEdges(unit, meta),
	};
}

const analyzer: Analyzer = {
	def: {
		id: "assistant-reflection",
		label: "Assistant Reflection (LLM, thinking-trace mining)",
		description:
			"Reads the assistant's private reasoning (thinkingText) and visible response (assistantText) to extract durable memories, self-acknowledged mistakes with severity, and the assistant's perception of user frustration/acceptance. The first analyzer to consume the thinking trace. Ungated. One classification node per turn.",
		anchorSpan: "pair",
		dependencies: [TURN_PAIR_CORE_DEF.id],
	},
	version: {
		analyzerId: "assistant-reflection",
		major: 1,
		minor: 0,
		implementationKind: "in_process_llm",
		codeRef: ".prospector/analyzers/assistant-reflection.analyzer.ts",
	},
	prompts: {
		classify: { hash: CLASSIFY_PROMPT_HASH, content: CLASSIFY_PROMPT, role: "classify" },
		retry: { hash: RETRY_PROMPT_HASH, content: RETRY_PROMPT, role: "retry" },
	},
	defaultConfig: {
		id: "",
		analyzerId: "assistant-reflection",
		configHash: computeConfigHash(DEFAULT_CONFIG),
		configJson: DEFAULT_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers) {
		const cfg = configOf(config as Record<string, unknown>);
		return [resolveModelSpec(cfg.tier, modelTiers)];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const config = configOf(ctx.config);
		const pairs = buildTurnPairs(ctx.messages);

		// Output key of each turn's turn-pair-core node, for the consumes
		// provenance edge. This analyzer consumes the SAME turn's core node
		// (not the prior turn's, like user-reply-acts).
		const coreOutputKey = new Map<string, string>();
		for (const node of ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? []) {
			try {
				const c = JSON.parse(node.content_json) as { user_message_id?: string };
				if (typeof c.user_message_id === "string") coreOutputKey.set(c.user_message_id, node.output_key);
			} catch {
				/* skip */
			}
		}

		// Units: every turn with non-empty thinking or assistant text.
		// No friction gate — signal lives in smooth turns too.
		const units: AnalysisUnit[] = [];
		for (const pair of pairs) {
			const contentLen = pair.thinkingText.trim().length + pair.assistantText.trim().length;
			if (contentLen < config.minContentChars) continue;

			const meta: ReflectionMeta = {
				thinkingText: pair.thinkingText,
				assistantText: pair.assistantText,
				pairIndex: pair.index,
				coreOutputKey: coreOutputKey.get(pair.userMessageId) ?? null,
			};
			const sources: SourceRef[] = [{ kind: "message", id: pair.userMessageId }];
			if (meta.coreOutputKey) sources.push({ kind: "analysis_node", id: meta.coreOutputKey });
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: pair.userMessageId,
				meta: meta as unknown as Record<string, unknown>,
			});
		}

		// Cost guard in turn order (deterministic, unbiased).
		return units.slice(0, config.maxTurnsPerSession);
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = configOf(ctx.config.configJson);
		const meta = unit.meta as unknown as ReflectionMeta;
		// The model sees head+tail truncated text. Validate mistake quotes
		// against the combined visible text (thinking + response).
		const visibleText = `${truncateHeadTail(meta.thinkingText, 2400)}\n${truncateHeadTail(meta.assistantText, 2400)}`;
		const userPrompt = buildClassifyPrompt({ thinkingText: meta.thinkingText, assistantText: meta.assistantText });

		const useStructuredOutput = config.structuredOutput;

		// ── Attempt 1: no abstention escape ──
		let r1: { structured?: unknown; text: string; costUsd?: number; tokensUsed?: number; durationMs?: number; model?: string; stopReason?: string };
		try {
			r1 = await ctx.llm({
				model: resolveModelSpec(config.tier, ctx.modelTiers),
				system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
				user: userPrompt,
				temperature: config.temperature,
				maxTokens: 2400,
				reasoning: config.reasoning,
				...(useStructuredOutput
					? { responseSchema: CLASSIFY_RESPONSE_SCHEMA }
					: { tool: CLASSIFY_TOOL }),
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("truncated")) throw err;
			r1 = { text: "", costUsd: 0, tokensUsed: 0, durationMs: 0, model: "", stopReason: "error" };
		}

		const verdict1 = extractVerdict(r1.structured, r1.text, visibleText);
		if (verdict1) {
			return buildResult(unit, meta, verdict1, 1, r1);
		}

		// ── Attempt 2: agentic retry with the abstention escape ──
		// Always uses the tool-call path (not response_format) to avoid the
		// ling-2.6-flash whitespace issue with strict structured outputs.
		const r2 = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["retry"] ?? RETRY_PROMPT,
			user: userPrompt,
			temperature: config.temperature,
			maxTokens: 2400,
			reasoning: config.reasoning,
			tool: CLASSIFY_TOOL_RETRY,
		});

		const totalCost = (r1.costUsd ?? 0) + (r2.costUsd ?? 0);
		const totalTokens = (r1.tokensUsed ?? 0) + (r2.tokensUsed ?? 0);
		const totalDuration = (r1.durationMs ?? 0) + (r2.durationMs ?? 0);
		const modelUsed = r2.model || r1.model;

		// Check for an abstention on the retry FIRST.
		const abstention = extractAbstention(r2.structured, r2.text);
		if (abstention) {
			const properties: AssistantReflectionProperties = {
				memories: [],
				mistakes: [],
				user_frustration: [],
				user_acceptance: [],
				abstention,
				attempt: 2,
				user_message_id: unit.anchorRef,
				pair_index: meta.pairIndex,
				core_output_key: meta.coreOutputKey,
			};
			return {
				nodeKind: "classification",
				contentJson: properties as unknown as Record<string, unknown>,
				anchorKind: "message",
				anchorRef: unit.anchorRef,
				modelUsed,
				costUsd: totalCost,
				tokensUsed: totalTokens,
				durationMs: totalDuration,
				edges: buildEdges(unit, meta),
			};
		}

		// Check for a valid classification on the retry.
		const verdict2 = extractVerdict(r2.structured, r2.text, visibleText);
		if (verdict2) {
			return buildResult(unit, meta, verdict2, 2, { ...r2, costUsd: totalCost, tokensUsed: totalTokens, durationMs: totalDuration, model: modelUsed });
		}

		// Both attempts failed.
		const reason = diagnoseFailure(r1, r2, visibleText);
		throw new Error(
			`Model '${modelUsed}' returned no usable classify_reflection verdict after 2 attempts for user message '${unit.anchorRef}'. ${reason}`,
		);
	},
};

export default defineAnalyzer(analyzer);