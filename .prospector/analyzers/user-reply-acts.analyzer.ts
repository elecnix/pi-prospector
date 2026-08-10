/**
 * user-reply-acts — what does the user's reply DO with the assistant's offer?
 *
 * The shipped analyzers answer "what went wrong *inside* a turn?" — they look
 * at a user request and the assistant's response to it, and they are gated on
 * friction. This analyzer answers a different question, one boundary later:
 * "what did the user *do with* the assistant's previous response?" Did they
 * accept it, refuse it, answer a question the assistant posed, or come back with
 * a question of their own — and if a question, was it asking the assistant to
 * do something new, to make a decision, to re-explain what it already said, or
 * to provide information?
 *
 * That question can only be answered with the *previous* assistant output in
 * view. Classifying the user's text alone would conflate a refusal ("no, don't
 * do that") with a question asked in reply to a question the assistant posed
 * ("which option, A or B?" → "A"), and would miss that a terse "ok" is an
 * acceptance only because the assistant had just proposed something. The unit
 * is the pair — (prior assistant output → this user reply).
 *
 * A reply can do several things at once: it may accept one part, refuse another,
 * and ask two questions. So the classifier emits *arrays* of acts rather than
 * one label or aggregate levels:
 *
 *   acceptances — zero or more acceptance acts. A reply that endorses the whole
 *                 proposal emits one { level: "full" }; a reply that accepts
 *                 part and pushes back on another emits { level: "partial" }
 *                 alongside a refusal. Empty array = no acceptance.
 *   refusals    — zero or more refusal acts, same shape. Not mutually exclusive
 *                 with acceptances.
 *   questions   — the distinct questions the user asks. Each carries a purpose:
 *                   request    — asks the assistant to do / look up / change
 *                                something new.
 *                   decision   — asks the assistant to choose / recommend a
 *                                course among options the user is posing.
 *                   clarify    — asks the assistant to re-explain or expand on
 *                                what it ALREADY said (a signal the prior
 *                                response under-explained or lacked context).
 *                   information— asks the assistant for a fact / status / state
 *                                of the world ("what does X do?", "is it
 *                                running?").
 *   answers     — the distinct questions the ASSISTANT asked that the user
 *                  answers here ("A or B?" → "A"). This is the user *closing* a
 *                  decision fork, not asking one.
 *   continuation — true when the user continues the task with a new, unrelated
 *                  instruction or topic — neither accepting/refusing a proposal
 *                  nor asking or answering anything.
 *   other       — true when the reply is none of the above (small talk, a report
 *                  of an external event).
 *
 * A reply with one acceptance {level:"full"}, no refusals, no questions, no
 * answers is a clean accept. A reply with a clarify question is the signal you
 * described — the assistant did not explain properly or did not give the right
 * context. The arrays keep the evidence (a rationale per act) and never collapse
 * a multi-act reply into a single aggregate that would hide the parts.
 *
 * One `classification` node per user reply (turn index ≥ 1). No friction gate
 * and no friction-ranked cap: acceptance and clarify-questions are the *desired*
 * signal and they live in smooth turns, which friction-only gating or
 * friction-ordered truncation would suppress and bias the distribution of. Cost
 * is bounded only by a hard per-session ceiling, applied in turn order
 * (deterministic, unbiased).
 *
 * Anchors to the user message. Consumes the turn-pair-core node of the *prior*
 * turn (the one whose assistant output is being reacted to) for provenance.
 *
 * Imports the framework's shared machinery (turn builder, hashing, types,
 * authoring helper) so it carries no duplicate code. Runs under tsx as `.ts`.
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

const UserReplyActsConfig = Type.Object({
	/**
	 * Which model classifies a reply: a tier name (`cheap`/`mid`/`expensive`) or
	 * an explicit `provider/model` spec, which `resolveModelSpec` passes through
	 * unchanged. Shipped default is `openrouter/inclusionai/ling-2.6-flash` —
	 * ~7× cheaper than the `cheap` tier (DeepSeek V4 Flash) for the same
	 * low-intelligence, high-volume, forced-tool-call task profile validated by
	 * the frustration-lexicon analyzer. Override via
	 * `analyzers["user-reply-acts"].tier` in prospector.json.
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
	 * Hard ceiling on replies classified per session. Classification is ungated
	 * (acceptance/clarify live in smooth turns), so this is the only cost bound.
	 * Applied in turn order — not friction-ranked — so truncation does not bias
	 * the act distribution.
	 */
	maxRepliesPerSession: Type.Number(),
	/** Min assistant-context chars to render into the prompt. */
	minAssistantContextChars: Type.Number(),
});
type UserReplyActsConfig = Static<typeof UserReplyActsConfig>;

const DEFAULT_CONFIG: UserReplyActsConfig = {
	tier: "openrouter/inclusionai/ling-2.6-flash",
	temperature: 0,
	reasoning: "off",
	maxRepliesPerSession: 100,
	minAssistantContextChars: 1,
};

function configOf(config: Record<string, unknown>): UserReplyActsConfig {
	const c = config as Partial<UserReplyActsConfig>;
	// Accept tier names (cheap/mid/expensive) OR explicit provider/model specs.
	// An empty/invalid tier falls back to the shipped default (ling-2.6-flash).
	const tier = typeof c.tier === "string" && c.tier.length > 0 ? c.tier : DEFAULT_CONFIG.tier;
	return {
		tier,
		temperature: typeof c.temperature === "number" ? c.temperature : DEFAULT_CONFIG.temperature,
		reasoning:
			c.reasoning === "off" || c.reasoning === "minimal" || c.reasoning === "low" || c.reasoning === "medium" || c.reasoning === "high"
				? c.reasoning
				: DEFAULT_CONFIG.reasoning,
		maxRepliesPerSession: typeof c.maxRepliesPerSession === "number" && c.maxRepliesPerSession > 0 ? c.maxRepliesPerSession : DEFAULT_CONFIG.maxRepliesPerSession,
		minAssistantContextChars: typeof c.minAssistantContextChars === "number" && c.minAssistantContextChars >= 0 ? c.minAssistantContextChars : DEFAULT_CONFIG.minAssistantContextChars,
	};
}

// ── prompt ──

export const CLASSIFY_PROMPT = `You classify what the user's reply DOES with the assistant's preceding output.

You are given:
  ASSISTANT (previous): the assistant's last response to the user.
  USER (reply):         the user's message that follows it.

Read the ASSISTANT output first. A reply's meaning depends on what it replies
to: "ok" is an acceptance only when the assistant proposed something; a bare new
instruction with no reaction to a proposal is a request or continuation, not an
acceptance; and "A" is an *answer* (closing a fork the assistant opened), not a
question.

Classify the reply into these act arrays. They are independent — a reply may
accept one part and refuse another, or accept and also ask a question. Emit one
entry per distinct act; a long reply may carry several.

  acceptances  Zero or more. The user endorses / approves / proceeds with the
               assistant's proposal or output (incl. terse "ok", "yes", "go
               ahead", "ship it", AND explicit acceptance of a proposal).
                 level: full   — the user accepts the proposal/output outright.
                 level: partial— the user accepts part of it (another part is
                                 refused or modified).
  refusals     Zero or more. The user rejects / declines / pushes back on the
               assistant's proposal or chosen direction ("no, don't", "not that",
               "revert", "I don't want X"). Also covers corrections: when the user
               points out the assistant did something wrong ("585 comment
               indentation is not fixed!", "the roles are fucked up"), classify it
               as a refusal, not other.
                 level: full | partial (same meaning as acceptance).
               NOT mutually exclusive with acceptances.
  questions    Zero or more. Each distinct question the user asks, with a purpose:
                 request     — asks the assistant to do / look up / change
                               something new. A command like "check if we are
                               GitHub Team/Enterprise" is a request, not an
                               information question — it asks the assistant to
                               DO something (even if the result is information).
                 decision    — asks the assistant to choose or recommend a course
                               among options the USER is posing.
                 clarify     — asks the assistant to re-explain or expand on what
                               it ALREADY said (signals the prior response
                               under-explained or lacked context).
                 information — asks the assistant for a fact / status / state of
                               the world ("what does X do?", "is it running?",
                               "what does P12 say exactly?"). A bare question mark
                               with no verb is information, not request.
  answers      Zero or more. Each distinct question the ASSISTANT asked that the
               user answers here (e.g. "should I use A or B?" → "A"). This is the
               user closing a decision fork, NOT asking a question.
  commands     Zero or more. A direct imperative where the user TELLS the assistant to
               do something, without phrasing it as a question. The user is giving an
               order, not asking. Examples:
                 "create a linear issue for Separate IAM/OIDC layer"
                 "add a chromatic review"
                 "use gh monitor"
                 "KEEP MONITORING YOUR DEPLOYMENT!!!"
                 "rename provider-keys to provider-configs"
                 "export CHROMATIC_PROJECT_TOKEN=chpt_..."
                 "start 1e now"
                 "continue"
               Each entry needs a quote and a short rationale: what is being commanded.
               If the user PHRASES it as a question ("can you create a linear issue?"),
               that is a question/request, NOT a command. The distinction is grammatical:
               imperative mood → command; interrogative mood → question.
  information_provisions
               Zero or more. The user provides context, data, or a status update
               without asking for anything or instructing anything — they are just
               dropping information into the conversation. Examples:
                 "DD_APP_KEY used to come from gh secret" (context for future work)
                 "369 merged" (status update)
                 "FLEET RESUMED — the OpenRouter daily key limit was exhausted"
                 "INCIDENT — STAGING IS RED. MERGES ARE FROZEN."
                 "olivier posted: https://linear.app/..." (relaying external info)
               Each entry needs a quote and a short rationale: what information
               is being provided.
  continuation true if the user shifts to a new, unrelated topic that isn't a
               command, question, or information provision. Use this ONLY for genuine
               topic shifts — not for instructions (those are commands), not for
               status updates (those are information_provisions), not for corrections
               (those are refusals). When in doubt between continuation and another
               class, prefer the other class.
  other        true ONLY if the reply is genuinely none of the above — small talk,
               a joke, or something truly unclassifiable. This is the absolute
               last resort. A correction or complaint is a refusal. A new
               instruction is a command. A status update is an information_provision.
               An external event report is an information_provision. When in doubt,
               pick the closest class instead of other. If you find yourself setting
               other=true, ask yourself: could this be a command, a request, an
               information_provision, a refusal, or a continuation? It almost
               certainly is one of those.

Every act MUST include a quote: an exact substring copied verbatim from the
USER (reply) text that justifies the act. The quote is the evidence — without
it, the act did not happen. If you cannot find a quote in the reply text that
supports an act, do not emit that act. The quote will be checked against the
reply text — if it is not an exact substring, the act will be rejected.

Rules:
  - Judge only what the text and context support. Do not invent acts.
  - Every quote must be an EXACT substring of the USER (reply) text — copy it
    verbatim, including any typos or formatting. Do not paraphrase.
  - "A" / "the first one" / "yes, do it" in reply to an assistant question is an
    answer (and, if it also endorses a proposal, an acceptance) — NOT a question.
  - A clarification is specifically about something the assistant ALREADY said;
    a request is for something new; an information question asks for a fact.
  - Each distinct question is its own entry in the questions array, with its own
    quote.
  - A correction ("this is wrong", "not fixed", "you fucked up") is a refusal —
    the user is pushing back on the assistant's output.
  - A complaint about external state ("CI failed", "the build is broken") that
    asks the assistant to investigate or fix is a request. A bare status update
    with no call to action ("369 merged", "staging is red") is an
    information_provision.
  - An instruction ("create a Linear issue", "start 1e now", "look for other
    PRs that touch tf", "add a chromatic review", "use gh monitor") is a
    command — the user is telling the assistant to DO something in the imperative
    mood. Do NOT classify imperatives as continuation or other. If phrased as a
    question ("can you create a Linear issue?"), it is a question/request instead.
  - Indirect imperatives are ALSO commands: "I want you to X", "you need to X",
    "Read X and carry out the task", "the operator asked you to X", "review and
    merge X". The grammatical subject is the agent, not the user. These are
    commands disguised as statements — classify them as commands, not other.
  - A reprimand or negative evaluation of the assistant's work ("You've been
    sleeping on your job", "I hate this", "this is over-engineered") is a refusal
    — the user is pushing back on the assistant's approach or output. Do not
    classify reprimands as other.
  - Deontic language ("should", "must", "need to", "keep", "do not use") is a
    command — the user is prescribing how things should be done. "keep the /
    command references" is a command. "do not use letters or numbers for agents"
    is both a command and a refusal of the current approach.
  - A sentence ending with "?" is a question, even if it starts with a URL or
    technical context. "Even if we parsed the Go code, would it match?" is a
    question (clarify or information). Do not classify questions as other.
  - If the reply is empty or carries no classifiable content, emit every array
    empty, continuation false, and other false.

Respond ONLY by calling the classify_reply tool. Never answer in prose.`;

export const CLASSIFY_PROMPT_HASH = shortHash(`prompt(classify_reply:${CLASSIFY_PROMPT})`);

/** Retry prompt: shown only on the second attempt when the first returned no usable verdict. */
export const RETRY_PROMPT = `Your previous response was not usable — it did not contain a valid classify_reply tool call with the required fields (every act needs a quote that is an exact verbatim substring of the USER reply text).

Try again. You MUST use the classify_reply tool. Use only the provided classes:
  acceptances, refusals, commands, questions (request/decision/clarify/information), answers,
  information_provisions, continuation, other.

If you genuinely cannot classify the reply into any of these classes — for example the reply is in a language you don't understand, is pure noise, or is a system-generated message that is not a human reply — you may call the classify_reply tool with the classifier_abstention field instead. When you abstain:
  - You MUST provide a reason (why you cannot classify).
  - You MUST propose the closest class (one of: acceptance, refusal, command, question, information_provision, continuation, other).
Abstaining is a last resort. Only use it when you truly cannot classify — not when the reply is merely hard or ambiguous. When in doubt, pick the closest class and emit it.`;

export const RETRY_PROMPT_HASH = shortHash(`prompt(classify_reply_retry:${RETRY_PROMPT})`);

/** Forced-tool-call schema for the classify phase (reliable structured output). */
export const CLASSIFY_TOOL = {
	name: "classify_reply",
	description: "Submit the multi-act classification of a user reply to the assistant's preceding output.",
	parameters: Type.Object({
		acceptances: Type.Array(
			Type.Object({
				level: Type.Union([Type.Literal("full"), Type.Literal("partial")]),
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that shows the acceptance." }),
				rationale: Type.String({ description: "One short sentence: what is being accepted." }),
			}),
		),
		refusals: Type.Array(
			Type.Object({
				level: Type.Union([Type.Literal("full"), Type.Literal("partial")]),
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that shows the refusal or correction." }),
				rationale: Type.String({ description: "One short sentence: what is being refused or corrected." }),
			}),
		),
		questions: Type.Array(
			Type.Object({
				purpose: Type.Union([
					Type.Literal("request"),
					Type.Literal("decision"),
					Type.Literal("clarify"),
					Type.Literal("information"),
				]),
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the question." }),
				rationale: Type.String({ description: "One short sentence justifying this question and its purpose." }),
			}),
		),
		answers: Type.Array(
			Type.Object({
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the answer." }),
				rationale: Type.String({ description: "One short sentence: which assistant question this answers." }),
			}),
		),
		commands: Type.Array(
			Type.Object({
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the command." }),
				rationale: Type.String({ description: "One short sentence: what is being commanded." }),
			}),
		),
		information_provisions: Type.Array(
			Type.Object({
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the information being provided." }),
				rationale: Type.String({ description: "One short sentence: what information is being provided." }),
			}),
		),
		continuation: Type.Boolean(),
		other: Type.Boolean(),
	}),
};

/**
 * Retry tool: same schema as CLASSIFY_TOOL plus an optional classifier_abstention.
 * The abstention is only offered on the second attempt, so the model doesn't
 * see it as an easy escape on the first pass. When abstaining, the model must
 * give a reason and propose the closest class.
 */
export const CLASSIFY_TOOL_RETRY = {
	name: "classify_reply",
	description: "Submit the multi-act classification of a user reply, or abstain with a reason if you genuinely cannot classify.",
	parameters: Type.Object({
		acceptances: Type.Array(
			Type.Object({
				level: Type.Union([Type.Literal("full"), Type.Literal("partial")]),
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that shows the acceptance." }),
				rationale: Type.String({ description: "One short sentence: what is being accepted." }),
			}),
		),
		refusals: Type.Array(
			Type.Object({
				level: Type.Union([Type.Literal("full"), Type.Literal("partial")]),
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that shows the refusal or correction." }),
				rationale: Type.String({ description: "One short sentence: what is being refused or corrected." }),
			}),
		),
		questions: Type.Array(
			Type.Object({
				purpose: Type.Union([
					Type.Literal("request"),
					Type.Literal("decision"),
					Type.Literal("clarify"),
					Type.Literal("information"),
				]),
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the question." }),
				rationale: Type.String({ description: "One short sentence justifying this question and its purpose." }),
			}),
		),
		answers: Type.Array(
			Type.Object({
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the answer." }),
				rationale: Type.String({ description: "One short sentence: which assistant question this answers." }),
			}),
		),
		commands: Type.Array(
			Type.Object({
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the command." }),
				rationale: Type.String({ description: "One short sentence: what is being commanded." }),
			}),
		),
		information_provisions: Type.Array(
			Type.Object({
				quote: Type.String({ description: "Exact verbatim substring from the USER (reply) text that contains the information being provided." }),
				rationale: Type.String({ description: "One short sentence: what information is being provided." }),
			}),
		),
		continuation: Type.Boolean(),
		other: Type.Boolean(),
		classifier_abstention: Type.Optional(
			Type.Object({
				reason: Type.String({ description: "Why you cannot classify this reply into the provided classes." }),
				proposed_class: Type.Union([
					Type.Literal("acceptance"),
					Type.Literal("refusal"),
					Type.Literal("command"),
					Type.Literal("question"),
					Type.Literal("information_provision"),
					Type.Literal("continuation"),
					Type.Literal("other"),
				]),
			}),
		),
	}),
};

const VALID_LEVELS = new Set(["full", "partial"]);
const VALID_PURPOSES = new Set(["request", "decision", "clarify", "information"]);

/**
 * Pi injects many system-generated messages as role="user" that are not
 * conversational replies to an assistant offer. These include:
 *   - <bash-input> / <bash-stdout> — bash I/O echoed back
 *   - <task-notification> — background task results
 *   - <command-message> / <command-name> — slash command invocations
 *   - <local-command-stdout> — local command output
 *   - <skill  — skill injection blocks
 *   - Emoji-prefixed ghpr-monitor notifications: 💭 ❌ ✅ 📝 🔀 📋 📡 ⚠️ ✨
 *     (matched on specific templates, not bare emoji, to avoid false positives)
 *   - JSON data dumps starting with [{
 * Classifying these produces no usable verdict and wastes a model call.
 */
function isSystemInjected(text: string): boolean {
	if (text.startsWith("<bash-input>")) return true;
	if (text.startsWith("<bash-stdout>")) return true;
	if (text.startsWith("<task-notification>")) return true;
	if (text.startsWith("<command-message>")) return true;
	if (text.startsWith("<command-name>")) return true;
	if (text.startsWith("<local-command-stdout>")) return true;
	if (text.startsWith("<skill ")) return true;
	// Pi compaction summaries injected as user messages on session resume.
	if (text.startsWith("This session is being continued from a previous conversation")) return true;
	// Pi UI events injected as user messages.
	if (text.startsWith("[Request interrupted by user")) return true;
	if (text.startsWith("[Your previous response had no visible output")) return true;
	if (text.startsWith("<system-reminder>")) return true;
	// Skill injection (alternate format without angle brackets).
	if (text.startsWith("Base directory for this skill:")) return true;
	// ghpr-monitor notification templates (specific prefixes, not bare emoji).
	const notifPrefixes = [
		"💭 ", "❌ ", "✅ ", "📝 ", "🔀 ", "📋 ", "📡 ", "⚠️ ",
		"✨ ", // PR all-clear / CI status
	];
	for (const p of notifPrefixes) {
		if (text.startsWith(p)) return true;
	}
	// Also match without trailing space for ⚠️ (sometimes no space after the emoji)
	if (text.startsWith("⚠️") && !text.startsWith("⚠️ ") === false) return true;
	if (text.startsWith("💡 Consider monitoring")) return true;
	// JSON data dumps (e.g. [{"...": ...}])
	if (text.startsWith("[{")) return true;
	return false;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Render text with head + tail so the model sees the beginning and end of long
 * inputs. A flat head-only truncation hides late signals (a question at the
 * end of a long reply, a quote buried in the second half). Head+tail preserves
 * both the opening context and the closing act, with a gap marker in between.
 */
function truncateHeadTail(s: string, max: number): string {
	if (s.length <= max) return s;
	const headLen = Math.floor(max * 0.6);
	const tailLen = max - headLen;
	return `${s.slice(0, headLen)}\n[… ${s.length - max} chars omitted …]\n${s.slice(s.length - tailLen)}`;
}

export function buildClassifyPrompt(input: { priorAssistantText: string; userText: string }): string {
	return [
		"ASSISTANT (previous):",
		truncateHeadTail(input.priorAssistantText, 2400),
		"",
		"USER (reply):",
		truncateHeadTail(input.userText, 2400),
	].join("\n");
}

// ── stored properties + parsing ──

export interface AcceptanceAct {
	level: "full" | "partial";
	quote: string;
	rationale: string;
}
export interface RefusalAct {
	level: "full" | "partial";
	quote: string;
	rationale: string;
}
export interface QuestionAct {
	purpose: "request" | "decision" | "clarify" | "information";
	quote: string;
	rationale: string;
}
export interface AnswerAct {
	quote: string;
	rationale: string;
}

/** The user issues a direct imperative — tells the assistant to do something. */
export interface CommandAct {
	quote: string;
	rationale: string;
}

/** The user provides context, data, or a status update without asking for anything. */
export interface InformationProvisionAct {
	quote: string;
	rationale: string;
}

/** The model's abstention verdict, only on the second (retry) attempt. */
export interface ClassifierAbstention {
	reason: string;
	proposed_class: "acceptance" | "refusal" | "question" | "continuation" | "other";
}

export interface UserReplyActsProperties {
	/** The user message being classified (the reply). */
	user_message_id: string;
	/** The user message of the PRIOR turn (what the assistant was replying to). */
	prior_user_message_id: string | null;
	/** Output key of the prior turn's turn-pair-core node (provenance), or null. */
	prior_core_output_key: string | null;
	pair_index: number;
	acceptances: AcceptanceAct[];
	refusals: RefusalAct[];
	questions: QuestionAct[];
	answers: AnswerAct[];
	commands: CommandAct[];
	information_provisions: InformationProvisionAct[];
	continuation: boolean;
	other: boolean;
	/** Present only when the model abstained on the retry attempt. */
	abstention: ClassifierAbstention | null;
	/** Which attempt produced the verdict: 1 = first, 2 = retry. */
	attempt: 1 | 2;
}

/** Parse and validate the structured reply. Returns null if no usable verdict. */
export function parseReply(raw: Record<string, unknown>, replyText?: string): Omit<UserReplyActsProperties, "user_message_id" | "prior_user_message_id" | "prior_core_output_key" | "pair_index" | "attempt"> | null {
	if (!Array.isArray(raw["acceptances"]) || !Array.isArray(raw["refusals"]) || !Array.isArray(raw["questions"]) || !Array.isArray(raw["answers"]) || !Array.isArray(raw["commands"]) || !Array.isArray(raw["information_provisions"])) {
		return null;
	}

	const acceptances: AcceptanceAct[] = [];
	for (const a of raw["acceptances"]) {
		if (!a || typeof a !== "object" || Array.isArray(a)) return null;
		const o = a as Record<string, unknown>;
		const level = typeof o["level"] === "string" && VALID_LEVELS.has(o["level"]) ? (o["level"] as AcceptanceAct["level"]) : null;
		if (!level) return null;
		const quote = typeof o["quote"] === "string" ? o["quote"].slice(0, 300) : "";
		if (quote.length === 0) return null;
		if (!isQuoteValid(quote, replyText)) return null;
		acceptances.push({ level, quote, rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "" });
	}

	const refusals: RefusalAct[] = [];
	for (const r of raw["refusals"]) {
		if (!r || typeof r !== "object" || Array.isArray(r)) return null;
		const o = r as Record<string, unknown>;
		const level = typeof o["level"] === "string" && VALID_LEVELS.has(o["level"]) ? (o["level"] as RefusalAct["level"]) : null;
		if (!level) return null;
		const quote = typeof o["quote"] === "string" ? o["quote"].slice(0, 300) : "";
		if (quote.length === 0) return null;
		if (!isQuoteValid(quote, replyText)) return null;
		refusals.push({ level, quote, rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "" });
	}

	const questions: QuestionAct[] = [];
	for (const q of raw["questions"]) {
		if (!q || typeof q !== "object" || Array.isArray(q)) return null;
		const o = q as Record<string, unknown>;
		const purpose = typeof o["purpose"] === "string" && VALID_PURPOSES.has(o["purpose"]) ? (o["purpose"] as QuestionAct["purpose"]) : null;
		if (!purpose) return null;
		const quote = typeof o["quote"] === "string" ? o["quote"].slice(0, 300) : "";
		if (quote.length === 0) return null;
		if (!isQuoteValid(quote, replyText)) return null;
		questions.push({ purpose, quote, rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "" });
	}

	const answers: AnswerAct[] = [];
	for (const a of raw["answers"]) {
		if (!a || typeof a !== "object" || Array.isArray(a)) return null;
		const o = a as Record<string, unknown>;
		const quote = typeof o["quote"] === "string" ? o["quote"].slice(0, 300) : "";
		if (quote.length === 0) return null;
		if (!isQuoteValid(quote, replyText)) return null;
		answers.push({ quote, rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "" });
	}

	const commands: CommandAct[] = [];
	for (const cmd of raw["commands"]) {
		if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return null;
		const o = cmd as Record<string, unknown>;
		const quote = typeof o["quote"] === "string" ? o["quote"].slice(0, 300) : "";
		if (quote.length === 0) return null;
		if (!isQuoteValid(quote, replyText)) return null;
		commands.push({ quote, rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "" });
	}

	const informationProvisions: InformationProvisionAct[] = [];
	for (const ip of raw["information_provisions"]) {
		if (!ip || typeof ip !== "object" || Array.isArray(ip)) return null;
		const o = ip as Record<string, unknown>;
		const quote = typeof o["quote"] === "string" ? o["quote"].slice(0, 300) : "";
		if (quote.length === 0) return null;
		if (!isQuoteValid(quote, replyText)) return null;
		informationProvisions.push({ quote, rationale: typeof o["rationale"] === "string" ? o["rationale"].slice(0, 300) : "" });
	}

	// Structural validation: reject contradictory verdicts so the agentic retry
	// can repair them. These are not prompt-level calibrations (which would
	// overfit) — they are logical invariants the model should never violate.
	const hasActs =
		acceptances.length > 0 || refusals.length > 0 ||
		questions.length > 0 || answers.length > 0 ||
		commands.length > 0 || informationProvisions.length > 0;
	const continuation = Boolean(raw["continuation"]);
	const other = Boolean(raw["other"]);
	// `other` means "none of the above" — it is contradictory if any act is present.
	if (other && hasActs) return null;
	// `continuation` means "a new topic shift with no acts" — it is contradictory
	// if any act is present. A reply that issues a command AND shifts topic is
	// just a command, not a continuation.
	if (continuation && hasActs) return null;

	return {
		acceptances,
		refusals,
		questions,
		answers,
		commands,
		information_provisions: informationProvisions,
		continuation,
		other,
		abstention: null,
	};
}

/**
 * Check that a quote is an exact substring of the reply text.
 * When replyText is not provided (e.g. unit tests that only test parsing),
 * the check is skipped — the quote just needs to be non-empty.
 */
function isQuoteValid(quote: string, replyText?: string): boolean {
	if (quote.length === 0) return false;
	if (replyText === undefined) return true; // skip substring check when no text provided
	return replyText.includes(quote);
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

function extractVerdict(structured: unknown, text: string, replyText?: string) {
	if (structured && typeof structured === "object" && !Array.isArray(structured)) {
		const v = parseReply(structured as Record<string, unknown>, replyText);
		if (v) return v;
	}
	const fromText = extractJsonObject(text);
	if (fromText) {
		const v = parseReply(fromText, replyText);
		if (v) return v;
	}
	return null;
}

const VALID_PROPOSED_CLASSES = new Set(["acceptance", "refusal", "command", "question", "information_provision", "continuation", "other"]);

/** Parse the abstention from a retry response. Returns null if not a valid abstention. */
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

/** Extract an abstention verdict from structured or text response. */
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

// ── analyzer ──

interface ReplyMeta {
	priorAssistantText: string;
	userText: string;
	priorUserMessageId: string | null;
	priorCoreOutputKey: string | null;
	pairIndex: number;
}

/** Build the edges for a classification node. */
function buildEdges(unit: AnalysisUnit, meta: ReplyMeta): EdgeSpec[] {
	const edges: EdgeSpec[] = [
		{ toRefKind: REF_KINDS.MESSAGE, toRefId: unit.anchorRef, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
	];
	if (meta.priorCoreOutputKey) {
		edges.push({ toRefKind: REF_KINDS.ANALYSIS_NODE, toRefId: meta.priorCoreOutputKey, edgeKind: EDGE_KINDS.CONSUMES, ordinal: 1 });
	}
	edges.push({ toRefKind: REF_KINDS.PROMPT_VERSION, toRefId: CLASSIFY_PROMPT_HASH, edgeKind: EDGE_KINDS.USES_PROMPT, ordinal: 2 });
	return edges;
}

/** Build a successful classification result from a parsed verdict. */
function buildResult(
	unit: AnalysisUnit,
	meta: ReplyMeta,
	verdict: Omit<UserReplyActsProperties, "user_message_id" | "prior_user_message_id" | "prior_core_output_key" | "pair_index" | "attempt" | "abstention">,
	attempt: 1 | 2,
	response: { model: string; costUsd: number; tokensUsed: number; durationMs: number },
	_ctx: AnalyzerRunContext,
): AnalysisResult {
	const properties: UserReplyActsProperties = {
		...verdict,
		abstention: null,
		attempt,
		user_message_id: unit.anchorRef,
		prior_user_message_id: meta.priorUserMessageId,
		prior_core_output_key: meta.priorCoreOutputKey,
		pair_index: meta.pairIndex,
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
		id: "user-reply-acts",
		label: "User Reply Acts (LLM, multi-act)",
		description:
			"Classifies each user reply (turn index ≥ 1) into multi-act arrays — acceptances, refusals, questions (request/decision/clarify/information), answers to assistant questions, continuation, other — given the prior assistant output. Ungated (acceptance/clarify live in smooth turns). One classification node per reply.",
		anchorSpan: "pair",
		dependencies: [TURN_PAIR_CORE_DEF.id],
	},
	version: {
		analyzerId: "user-reply-acts",
		major: 1,
		minor: 0,
		implementationKind: "in_process_llm",
		codeRef: ".prospector/analyzers/user-reply-acts.analyzer.ts",
	},
	prompts: {
		classify: { hash: CLASSIFY_PROMPT_HASH, content: CLASSIFY_PROMPT, role: "classify" },
		retry: { hash: RETRY_PROMPT_HASH, content: RETRY_PROMPT, role: "retry" },
	},
	defaultConfig: {
		id: "",
		analyzerId: "user-reply-acts",
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

		// Output key of each prior turn's turn-pair-core node, for the consumes
		// provenance edge. (No friction ranking: ranking by prior friction would
		// bias the act distribution toward refusal/clarify and away from
		// acceptance, which is the very distribution this analyzer measures.)
		const priorCoreOutputKey = new Map<string, string>();
		for (const node of ctx.dependencyNodes[TURN_PAIR_CORE_DEF.id] ?? []) {
			try {
				const c = JSON.parse(node.content_json) as { user_message_id?: string };
				if (typeof c.user_message_id === "string") priorCoreOutputKey.set(c.user_message_id, node.output_key);
			} catch {
				/* skip */
			}
		}

		// Reply units: turn index ≥ 1 whose anchor is a genuine user turn
		// (buildTurnPairs also starts turns at bashExecution/branch_summary, and a
		// reply to those is not a user reaction to an assistant offer).
		const units: AnalysisUnit[] = [];
		for (let i = 1; i < pairs.length; i++) {
			const prior = pairs[i - 1]!;
			const reply = pairs[i]!;
			if (reply.userText.trim().length === 0) continue;
			// Only classify genuine user messages (not bashExecution/branch/custom).
			const replyMsg = ctx.messages.find((m) => m.id === reply.userMessageId);
			if (!replyMsg || replyMsg.role !== "user") continue;
			// Pi sessions inject many system-generated messages as role="user" that are
			// not conversational replies to an assistant offer. Filter them all out —
			// classifying them produces no usable verdict and wastes a model call.
			if (isSystemInjected(reply.userText)) continue;
			if (prior.assistantText.trim().length < config.minAssistantContextChars) continue;

			const meta: ReplyMeta = {
				priorAssistantText: prior.assistantText,
				userText: reply.userText,
				priorUserMessageId: prior.userMessageId,
				priorCoreOutputKey: priorCoreOutputKey.get(prior.userMessageId) ?? null,
				pairIndex: reply.index,
			};
			const sources: SourceRef[] = [{ kind: "message", id: reply.userMessageId }];
			if (meta.priorCoreOutputKey) sources.push({ kind: "analysis_node", id: meta.priorCoreOutputKey });
			units.push({
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "message",
				anchorRef: reply.userMessageId,
				meta: meta as unknown as Record<string, unknown>,
			});
		}

		// Cost guard in turn order (deterministic, unbiased). The ceiling is the
		// only bound; a session at or below it classifies every qualifying reply.
		return units.slice(0, config.maxRepliesPerSession);
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = configOf(ctx.config.configJson);
		const meta = unit.meta as unknown as ReplyMeta;
		const userPrompt = buildClassifyPrompt({ priorAssistantText: meta.priorAssistantText, userText: meta.userText });

		// ── Attempt 1: the primary tool, no abstention escape ──
		const r1 = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
			user: userPrompt,
			temperature: config.temperature,
			maxTokens: 600,
			reasoning: config.reasoning,
			tool: CLASSIFY_TOOL,
		});

		const verdict1 = extractVerdict(r1.structured, r1.text, meta.userText);
		if (verdict1) {
			return buildResult(unit, meta, verdict1, 1, r1, ctx);
		}

		// ── Attempt 2: agentic retry with the abstention escape ──
		// The retry tool is the same schema plus classifier_abstention, so the
		// model can refuse to classify — but only after failing the first pass,
		// and only with a reason and a proposed closest class.
		const r2 = await ctx.llm({
			model: resolveModelSpec(config.tier, ctx.modelTiers),
			system: ctx.prompts["retry"] ?? RETRY_PROMPT,
			user: userPrompt,
			temperature: config.temperature,
			maxTokens: 600,
			reasoning: config.reasoning,
			tool: CLASSIFY_TOOL_RETRY,
		});

		// Accumulate cost/tokens/duration across both attempts.
		const totalCost = (r1.costUsd ?? 0) + (r2.costUsd ?? 0);
		const totalTokens = (r1.tokensUsed ?? 0) + (r2.tokensUsed ?? 0);
		const totalDuration = (r1.durationMs ?? 0) + (r2.durationMs ?? 0);
		const modelUsed = r2.model || r1.model;

		// Check for an abstention on the retry FIRST — a response with empty acts
		// AND a classifier_abstention field is an abstention, not a valid empty verdict.
		const abstention = extractAbstention(r2.structured, r2.text);
		if (abstention) {
			// Store the abstention as a node with empty acts — the proposed_class
			// and reason are preserved for downstream analysis.
			const properties: UserReplyActsProperties = {
				acceptances: [],
				refusals: [],
				questions: [],
				answers: [],
				commands: [],
				information_provisions: [],
				continuation: false,
				other: false,
				abstention,
				attempt: 2,
				user_message_id: unit.anchorRef,
				prior_user_message_id: meta.priorUserMessageId,
				prior_core_output_key: meta.priorCoreOutputKey,
				pair_index: meta.pairIndex,
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
		const verdict2 = extractVerdict(r2.structured, r2.text, meta.userText);
		if (verdict2) {
			return buildResult(unit, meta, verdict2, 2, { ...r2, costUsd: totalCost, tokensUsed: totalTokens, durationMs: totalDuration, model: modelUsed }, ctx);
		}

		// Both attempts failed. Record the error.
		throw new Error(
			`Model '${modelUsed}' returned no usable classify_reply verdict after 2 attempts for user message '${unit.anchorRef}'. ` +
			`The model either cannot do structured output or could not classify this reply.`,
		);
	},
};

export default defineAnalyzer(analyzer);