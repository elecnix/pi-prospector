/**
 * Message origin: who wrote a user-role message.
 *
 * Hosts file many things under the user role that the person never typed: a
 * harness notification, a prompt another agent wrote, a log the person pasted.
 * `text-origin.ts` labels the spans inside a message so a frustration hit can
 * say where its words came from. This module labels the whole message with one
 * of four values, so any analyzer can count only what a person wrote:
 *
 *   - `typed`: the person composed or dictated the words. Anything no rule
 *     below claims, a slash command, and a message whose text is mostly the
 *     person's own.
 *   - `pasted`: the person sent material they copied instead of wrote: a log, a
 *     terminal capture, a quoted reply, a bare link.
 *   - `agent`: an agent or a script wrote it. A child agent's prompt, a brief
 *     an orchestrator wrote for a worker, a relayed message, a one-shot probe.
 *   - `notification`: the harness or an extension injected it. A monitor event,
 *     a task notification, an interruption notice, a tool-output echo.
 *
 * The rules run in a fixed order and the first that claims the message decides
 * it. Each carries a name, so a consumer can see why a message got its label.
 * Strong rules decide. A message that matches none but carries a weak sign of
 * machine authorship is `undecided`: it keeps `typed` as its provisional label
 * and the analyzer may ask a decision model. No weak sign means `typed`, decided.
 *
 * Harness blocks are an envelope, not content. A person's prompt with a
 * `<system-reminder>` appended is the person's; a message that is nothing but
 * harness blocks is a notification.
 *
 * Pure functions: no database, no state.
 */

import { Type, type Static } from "typebox";
import { labelUserText, type TextSpan } from "./text-origin.js";

export const MessageOrigin = Type.Union([
	Type.Literal("typed"),
	Type.Literal("pasted"),
	Type.Literal("agent"),
	Type.Literal("notification"),
]);
export type MessageOrigin = Static<typeof MessageOrigin>;

/** Every label, in the order a report lists them. */
export const MESSAGE_ORIGINS: readonly MessageOrigin[] = ["typed", "pasted", "agent", "notification"];

/** The rule that decided a label. */
export const OriginRule = Type.Union([
	Type.Literal("pi-entry"),
	Type.Literal("compaction"),
	Type.Literal("harness-block"),
	Type.Literal("harness-line"),
	Type.Literal("slash-command"),
	Type.Literal("tool-result"),
	Type.Literal("child-session"),
	Type.Literal("teammate-block"),
	Type.Literal("signature"),
	Type.Literal("peer-message"),
	Type.Literal("computed-task"),
	Type.Literal("spawn-pointer"),
	Type.Literal("relay-header"),
	Type.Literal("brief"),
	Type.Literal("role-preamble"),
	Type.Literal("shelf-item"),
	Type.Literal("operator-reference"),
	Type.Literal("probe"),
	Type.Literal("pasted-block"),
	Type.Literal("terminal-output"),
	Type.Literal("link-only"),
	Type.Literal("no-marker"),
	Type.Literal("undecided"),
	Type.Literal("decision-model"),
]);
export type OriginRule = Static<typeof OriginRule>;

/** A weak sign of machine authorship. Signs alone never decide; they send a message to the decision model. */
export const OriginSuspicion = Type.Union([
	Type.Literal("handle-prefix"),
	Type.Literal("operator-third-person"),
	Type.Literal("worker-vocabulary"),
	Type.Literal("long-structured"),
	Type.Literal("short-role-preamble"),
	Type.Literal("sha-and-path"),
	Type.Literal("machine-text"),
	Type.Literal("agent-handle"),
	Type.Literal("field-list"),
	Type.Literal("pasted-wrapper"),
	Type.Literal("paste-with-prose"),
]);
export type OriginSuspicion = Static<typeof OriginSuspicion>;

/** What the classifier needs to know about the turn beyond its text. */
export const MessageOriginContext = Type.Object({
	/** The turn-starting message's role. */
	role: Type.String(),
	/** The session is a child agent's: another agent wrote its prompts. */
	childAgent: Type.Boolean(),
	/**
	 * Seconds since the assistant message that made tool calls, when this message
	 * directly follows it with no tool result between; null otherwise. Some hosts
	 * file a tool's result under the user role, and it arrives within seconds,
	 * while a person who types into a call still waiting for its answer takes longer.
	 */
	secondsAfterToolCall: Type.Union([Type.Number(), Type.Null()]),
});
export type MessageOriginContext = Static<typeof MessageOriginContext>;

/** One message's heuristic verdict. */
export const OriginVerdict = Type.Object({
	origin: MessageOrigin,
	rule: OriginRule,
	/** False when only a weak sign was found; `origin` is then provisional. */
	decided: Type.Boolean(),
	suspicions: Type.Array(OriginSuspicion),
});
export type OriginVerdict = Static<typeof OriginVerdict>;

/** pi turn-start entries that the harness or an extension writes. */
const PI_ENTRY_ROLES = new Set(["custom_message", "branch_summary", "bashExecution"]);

/** A tool result arrives within this many seconds of its call. Measured on a corpus: 95% of messages that follow a call land inside it. */
export const TOOL_RESULT_WINDOW_SECONDS = 120;

/**
 * A paste with fewer than this many characters of other text is a pure paste. With
 * more, the person's sentences may be the message and the paste its attachment, and
 * the label depends on those sentences.
 */
export const PURE_PASTE_MAX_PROSE_CHARS = 40;

/** A probe prompt is short. */
const PROBE_MAX_CHARS = 200;

const PEER_MAIL_RE = /^\s*\*\*📨 From (?!subagent-control\b)/u;

const COMPACTION_RE = /^\s*This session is being continued from a previous conversation/;

/**
 * A line a harness or extension writes at the start of a user-role message: an
 * interruption notice, a workflow or fleet banner, a pull-request monitor event.
 */
const HARNESS_LINE_RE = new RegExp(
	[
		String.raw`\[Request interrupted by user`,
		String.raw`\[Workflow harness — user request`,
		String.raw`Base directory for this skill:`,
		String.raw`\[minifleet\]`,
		String.raw`\[workflows mode armed`,
		String.raw`<skill name="`,
		String.raw`<bash-input>`,
		String.raw`={3} [^\n=]{2,80} ={3}(?:\s|$)`,
		String.raw`---[A-Za-z ]{3,40}---\s`,
		String.raw`The file \S.* has been (?:updated|created) successfully`,
		String.raw`File created successfully at: `,
		String.raw`Exit code \d+(?:\n|$)`,
		String.raw`Command running in background with ID: `,
		String.raw`Shell cwd was reset to `,
		String.raw`(?:Updated|Created) task #\d+`,
		String.raw`🔔\s+\*\*You were mentioned`,
		String.raw`[✅❌⚠️📝🔀]\uFE0F?\s+\[[\w./-]+#\d+\]\(`,
		String.raw`<retrieval_status>`,
		String.raw`The user doesn't want to proceed with this tool use`,
		String.raw`🏁\s+Workflow run`,
		String.raw`🔔\s+@\S+ mentioned you`,
		String.raw`Your questions have been answered:`,
		String.raw`Next wakeup scheduled for`,
		String.raw`\[Your previous response had no visible output`,
		String.raw`\[Skill conflicts\]`,
		String.raw`Launching skill: `,
		String.raw`[💡✨]\uFE0F?\s+(?:Consider monitoring|\[)`,
		String.raw`[⚠️✅]\uFE0F?\s+(?:Merge conflicts detected|Approved by|Changes requested)`,
		String.raw`\[\{"type":"text"`,
		String.raw`[⚠️✅❌💭📝📋🔀📡⏳🔔]️?\s+(?:API degraded|GraphQL budget|All CI checks|Failing CI checks|\d+ (?:new )?general comment|\d+ new |New commit|\d+ (?:\(truncated\) )?annotation|\d+\{annotationTruncated\}|PR \[|Monitor this|Workflow run|Review requested|CI )`,
	].join("|"),
	"u",
);

/** The message ends with an agent handle: `— swift-koala-42`, `-- cc-eager-owl-07`. */
const SIGNATURE_RE = /(?:^|\n)[ \t]*(?:—|–|--)[ \t]*(?:cc-)?[a-z]+-[a-z]+-\d{1,3}[ \t]*$/;

/** The banner a workflow script puts on a task it computed at run time. */
const COMPUTED_TASK_RE = /^\[Workflow harness — computed/;

/** The line the harness puts above a message another session sent. */
const PEER_RELAY_RE = /^Another Claude session sent a message/;

/** A pointer to a file that holds the real prompt: how an orchestrator starts a worker. */
const SPAWN_POINTER_RE =
	/^(?:Your task is in\s+\S+|Read\b[^\n]{0,200}\b(?:carry out the task (?:it|that) describes|do what it says|and follow it|and carry out)\b)/i;

/** A header an agent puts on a message it relays or sends to another session. */
const RELAY_HEADER_RE =
	/^(?:Orchestrator\b[:,]|Standing rules from the orchestrator|From an unsigned sender|News from [a-z][a-z-]*,|Mid-run steering from|Operator (?:answer|grant|decision|instruction)\b|(?:cc|pi|codex)-[a-z]+-[a-z]+-\d{1,3}[:,])/i;

/** `You are a …`, `Your job is …`, `Task: …`: how a prompt addresses a worker. */
const ROLE_PREAMBLE_RE =
	/^(?:You are (?:a|an|the|one|now|running|reviewing|investigating|working|assigned)\b|You (?:own|implement|fix|investigate|review|work on|will)\b|Run each probe|You(?:'|’)re (?:a|an|the|running)\b|Your (?:task|job|role|mission|assignment)(?: is|:)|Task:|# Task\b|You are a fork of this conversation|NEW TASK\b)/;

/** A work item an orchestrator shelved for another: `s0b6ece07 [chore] -> chief-of-staff (by cc-owl-09)`. */
const SHELF_ITEM_RE = /^\s*s[0-9a-f]{8} \[[a-z-]+\] -> \S+/;

/** `slug-name: …` or `slug-name (alias), …`: a lane or session addressed by its handle. */
const HANDLE_PREFIX_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?:\s+\([a-z0-9-]+\))?\s*[:,]/;

const FIELD_LINE_RE = /^(?:Ticket|Worktree|Branch|PR|Repo|Report file|Task|Issue)\b[^:\n]{0,25}: \S/gm;
const AGENT_HANDLE_RE = /\b(?:cc|cx|pi|oc|codex)-[a-z]+-[a-z]+-\d{1,3}\b/;
const OPERATOR_RE = /\b(?:the operator|operator(?:'|’)s|relayed from|his words|their words)\b/i;
const WORKER_VOCAB_RE = /\b(?:your (?:worktree|lane|orchestrator|shelf|PR|pull request|branch|work)\b|Worktree for your|orchestrator|shelf item|post-merge lane|fan-?out lane)\b/i;
const PROBE_RE = /^(?:Reply|Respond|Say|Answer|Print|Output)\b[^\n]{0,60}\b(?:exactly|only|nothing else|single word|the word|with ok)\b|^Reply (?:OK\b|with(?: the\b|:))|^Read \S+ in this directory\b/i;
const SHA_RE = /\b[0-9a-f]{7,40}\b/;
const ABS_PATH_RE = /(?:^|[\s`'"(])\/(?:Users|private|tmp|home|var)\/[^\s`'")]+/g;

/**
 * A skill expansion: the person's instructions, then the skill's own guidelines
 * and workflow. Only the instructions are the person's.
 */
const SKILL_EXPANSION_RE = /^\s*<instructions>([\s\S]*?)<\/instructions>\s*<guidelines>[\s\S]*$/;
const SKILL_TEXT_RE = /^\s*<guidelines>/;

/** Matches a whole-message `<pasted_content …>…</pasted_content …>` block. */
const PASTED_BLOCK_RE = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g;

/** A slash command with no arguments: `/compact`, or the record Claude Code keeps of one. */
/** A message that is a file's contents with line numbers: at least three lines, each opening on a number. */
const NUMBERED_LISTING_RE = /^(?:\s*\d+[ \t:|→]\S?[^\n]*(?:\n|$)){3,}/;

const SLASH_COMMAND_RE = /^\/[a-z][\w:-]*\s*$/;
const EMPTY_COMMAND_RE = /^(?:\s*<command-(?:message|name)>[^<]*<\/command-(?:message|name)>)+\s*(?:<command-args>\s*<\/command-args>)?\s*$/;

/** A message that is only a link, or links, and no words. */
const LINK_ONLY_RE = /^(?:\s*(?:<?https?:\/\/\S+>?|file:\/\/\S+)\s*)+$/;

/** A terminal capture: it opens on a prompt line or numbers its lines. */
const TERMINAL_RE = /^\s*(?:\$ \S|[\w.-]+@[\w.-]+:\S*\$ |[\w.-]+@[\S]+ \S+ % \S|Usage: |%\s\S|❯\s?\S|>>> |\d+ [A-Z=✓✔✗]|(?:\S+ ){0,3}(?:SUCCESS|FAILURE|PASS|FAIL)\b)/;

const nonSpace = (s: string): number => s.replace(/\s+/g, "").length;

/** Characters of `spans` with each label. */
function charsByOrigin(spans: readonly TextSpan[]): Map<TextSpan["origin"], number> {
	const out = new Map<TextSpan["origin"], number>();
	for (const s of spans) out.set(s.origin, (out.get(s.origin) ?? 0) + nonSpace(s.text));
	return out;
}

/** A pasted-content body with its wrapper removed, and the text around it kept. */
function unwrapPasted(text: string): string {
	return text.replace(PASTED_BLOCK_RE, (_m, inner: string) => `\n${inner}\n`);
}

/** The text of a message with harness blocks removed. */
function stripEnvelope(text: string, spans: readonly TextSpan[]): string {
	return spans
		.filter((s) => s.origin !== "notification")
		.map((s) => s.text)
		.join("");
}

function markdownStructure(text: string): number {
	const headings = text.match(/^#{1,4} \S/gm)?.length ?? 0;
	const labels = text.match(/^\*\*[^*\n]{2,60}\*\*|^[A-Z][A-Za-z ]{2,30}:\s*$/gm)?.length ?? 0;
	return headings + labels;
}

/** Strong signs the body was written by an agent. The first that matches is returned. */
function strongAgentRule(body: string): OriginRule | null {
	const text = body.trim();
	if (SPAWN_POINTER_RE.test(text)) return "spawn-pointer";
	if (RELAY_HEADER_RE.test(text)) return "relay-header";
	// A person rarely opens a prompt with a markdown title and then writes a page of sections.
	if (/^# \S/.test(text) && text.length >= 1000 && markdownStructure(text) >= 3) return "brief";
	if (/^# \S[^\n]*\n+(?:Worktree|Work in)\b/.test(text)) return "brief";
	// A person does not hand themselves a worktree path.
	if (/^Worktree(?: for your work)?:\s+\//m.test(text)) return "brief";
	if (SHELF_ITEM_RE.test(text)) return "shelf-item";
	if (ROLE_PREAMBLE_RE.test(text) && text.length >= 300) return "role-preamble";
	// A short test prompt that dictates its own reply is a probe, not a request.
	if (text.length <= PROBE_MAX_CHARS && PROBE_RE.test(text)) return "probe";
	// A message that speaks of the operator in the third person, beside other worker talk, is an agent talking to another.
	if (OPERATOR_RE.test(text) && (WORKER_VOCAB_RE.test(text) || AGENT_HANDLE_RE.test(text) || text.length >= 600)) return "operator-reference";
	return null;
}

/** Text that reads as program output or code: banner rules, or a high share of symbols. */
function machineText(text: string): boolean {
	if (/^={3,} .* ={3,}|\bDone in \d|\bDuration \d/m.test(text)) return true;
	const letters = text.replace(/[^\p{L}\s]/gu, "").length;
	return text.length >= 80 && letters / text.length < 0.65;
}

function weakSigns(body: string): OriginSuspicion[] {
	const text = body.trim();
	const out: OriginSuspicion[] = [];
	if (HANDLE_PREFIX_RE.test(text)) out.push("handle-prefix");
	if (AGENT_HANDLE_RE.test(text)) out.push("agent-handle");
	if ((text.match(FIELD_LINE_RE)?.length ?? 0) >= 2) out.push("field-list");
	if (OPERATOR_RE.test(text)) out.push("operator-third-person");
	if (WORKER_VOCAB_RE.test(text)) out.push("worker-vocabulary");
	if (text.length >= 600 && markdownStructure(text) >= 2) out.push("long-structured");
	if (ROLE_PREAMBLE_RE.test(text)) out.push("short-role-preamble");
	if (machineText(text)) out.push("machine-text");
	if (SHA_RE.test(text) && (text.match(ABS_PATH_RE)?.length ?? 0) >= 1) out.push("sha-and-path");
	return out;
}

/** Signs that machine output carries, which a paste of output carries too. */
const MACHINE_SIGNS: ReadonlySet<OriginSuspicion> = new Set(["machine-text", "sha-and-path", "long-structured"]);

/**
 * Whether lines read as sentences a person wrote: most are five words or more, and
 * nearly all of each line's words are plain words, not paths, numbers or symbols.
 * A person who presses return often writes eight short lines, and a log never reads this way.
 */
function proseLike(text: string): boolean {
	const lines = text.split("\n").map((l) => l.replace(/^\s*(?:[-*•▎>]|\d+[.)])\s+/u, "").trim()).filter(Boolean);
	if (lines.length === 0) return false;
	const sentence = lines.filter((l) => {
		const words = l.split(/\s+/);
		return words.length >= 5 && words.filter((w) => /^[\p{L}'’]+[.,;:?!]?$/u.test(w)).length / words.length >= 0.8;
	});
	return sentence.length / lines.length >= 0.6;
}

/** A span the labeller took for a paste only because it runs to eight lines or more. */
function isLongParagraph(span: TextSpan): boolean {
	return !/^\s*(?:```|~~~|<pasted_content|\[Pasted text)/.test(span.text);
}

/** What the copied-material test found. `mixed` is a paste with the person's own words beside it. */
type PasteFinding = OriginRule | "mixed" | null;

/** The rule that makes `text` copied material, `mixed` when it also has the person's words, or null. */
function pastedFinding(text: string, skillExpansion: boolean): PasteFinding {
	// A link is what the person typed into a skill command, and a paste anywhere else.
	if (LINK_ONLY_RE.test(text.trim())) return skillExpansion ? null : "link-only";
	const content = nonSpace(text);
	const spans = labelUserText(text, { role: "user", childAgent: false, forkCopy: false });
	const copied = charsByOrigin(spans).get("pasted") ?? 0;
	// A long paragraph that reads as sentences may be the person's own prompt or an agent's brief, so it is no paste.
	const sentences = spans
		.filter((span) => span.origin === "pasted" && isLongParagraph(span) && proseLike(span.text))
		.reduce((sum, span) => sum + nonSpace(span.text), 0);
	const share = content > 0 ? (copied - sentences) / content : 0;
	// A quoted line is a way of replying, not material the person did not write.
	if (share >= 0.5) return content - (copied - sentences) < PURE_PASTE_MAX_PROSE_CHARS ? "pasted-block" : "mixed";
	if ((copied) / content >= 0.5 && sentences > 0) return "mixed";
	// A Claude Code prompt echo (`❯ please fix the failing build now`) is the person's sentence, not a shell prompt.
	if (TERMINAL_RE.test(text.trimStart()) && text.split("\n").length >= 3 && !proseLike(text.trimStart().split("\n")[0]!.replace(/^❯\s*/u, ""))) return "terminal-output";
	return null;
}

/**
 * Label one user-role message.
 *
 * `decided` is false when the message matches no strong rule but carries a weak
 * sign; the label is then provisional (`typed`) and a decision model may settle it.
 */
export function classifyMessageOrigin(rawText: string, ctx: MessageOriginContext): OriginVerdict {
	const verdict = (origin: MessageOrigin, rule: OriginRule, suspicions: OriginSuspicion[] = []): OriginVerdict => ({
		origin,
		rule,
		decided: rule !== "undecided",
		suspicions,
	});
	if (SKILL_TEXT_RE.test(rawText)) return verdict("notification", "harness-block");
	const text = rawText.replace(SKILL_EXPANSION_RE, "$1");

	// A message another pi session sent through the intercom is that agent's, delivered by the harness.
	if (PI_ENTRY_ROLES.has(ctx.role)) return PEER_MAIL_RE.test(text) ? verdict("agent", "peer-message") : verdict("notification", "pi-entry");
	if (ctx.secondsAfterToolCall !== null && ctx.secondsAfterToolCall <= TOOL_RESULT_WINDOW_SECONDS) return verdict("notification", "tool-result");
	if (COMPACTION_RE.test(text)) return verdict("notification", "compaction");

	const lead = text.trimStart();
	if (COMPUTED_TASK_RE.test(lead)) return verdict("agent", "computed-task");
	if (PEER_RELAY_RE.test(lead)) return verdict("agent", "teammate-block");
	if (HARNESS_LINE_RE.test(lead)) return verdict("notification", "harness-line");
	if (NUMBERED_LISTING_RE.test(lead)) return verdict("notification", "tool-result");
	if (SLASH_COMMAND_RE.test(lead) || EMPTY_COMMAND_RE.test(lead)) return verdict("notification", "slash-command");

	// The span labeller also claims a signed message whole, so test the signature first.
	if (SIGNATURE_RE.test(text.trimEnd())) return verdict("agent", "signature");

	// Spans come from the span labeller with its whole-message rules switched off.
	const spans = labelUserText(text, { role: "user", childAgent: false, forkCopy: false });
	const chars = charsByOrigin(spans);
	const notification = chars.get("notification") ?? 0;
	const agentBlock = chars.get("agent") ?? 0;
	const content = nonSpace(text) - notification;
	if (content <= 0) return verdict("notification", "harness-block");

	if (ctx.childAgent) return verdict("agent", "child-session");
	if (agentBlock / content >= 0.5) return verdict("agent", "teammate-block");

	const body = stripEnvelope(text, spans);
	const unwrapped = unwrapPasted(body);

	// The agent rules also read inside a paste: an agent that sends a message by
	// pasting into a terminal produces a pasted block that no person wrote.
	const strong = strongAgentRule(unwrapped);
	if (strong) return verdict("agent", strong);

	// Copied material, judged on the text with the paste wrapper removed. Claude Code
	// wraps any inserted text in `<pasted_content>`, and dictation tools insert what the
	// person said the same way, so the wrapper alone says nothing about authorship.
	const pasted = pastedFinding(unwrapped, text !== rawText);
	if (pasted === "mixed") return verdict("typed", "undecided", ["paste-with-prose", ...weakSigns(unwrapped).filter((sign) => !MACHINE_SIGNS.has(sign))]);
	if (pasted) {
		// Pasted output after a tool call that never got its result is that call's output,
		// however late. A bare link is more likely the person's, so it stays a paste.
		if (ctx.secondsAfterToolCall !== null && pasted !== "link-only") return verdict("notification", "tool-result");
		// A paste that reads like a brief an agent wrote is not settled by its shape alone.
		const signs = weakSigns(unwrapped).filter((sign) => !MACHINE_SIGNS.has(sign));
		return signs.length > 0 ? verdict("typed", "undecided", signs) : verdict("pasted", pasted);
	}

	const suspicions = weakSigns(unwrapped);
	if (body !== unwrapped) suspicions.push("pasted-wrapper");
	if (suspicions.length > 0) return verdict("typed", "undecided", suspicions);
	return verdict("typed", "no-marker");
}
