/**
 * Pure detection logic for the task-tool-mismatch analyzer (#158).
 *
 * The pattern: a task's first user/task message instructs use of a specific
 * tool or command, that tool was available to the agent, the agent made zero
 * calls of it, and instead reconstructed the result by hand with many calls of
 * substitute tools. All four conditions must hold; the finding points at the
 * instructed-but-avoided tool — never at the substitute symptom (the redundant
 * reads and greps are the shadow, not the disease).
 *
 * Instruction extraction is deliberately conservative: only *imperative*
 * sentences in the first user message count (sentence-initial verb, after the
 * usual markdown bullets, quotes, and polite/sequencing lead-ins), negated
 * imperatives are dropped, and a bare word is only accepted when it names an
 * actually-available tool. A mention sitting inside prose ("you can use rg for
 * this") is never an instruction.
 */

import { Type, type Static } from "typebox";
import type { ToolInvocation } from "../../tool-stream.js";
import type { TaskToolMismatchConfig } from "./config.js";

/** Cap on named instructions per session, so node size is bounded. */
export const MENTION_CAP = 8;

export const MentionSource = Type.Union([Type.Literal("backticked"), Type.Literal("known-tool")]);
export type MentionSource = Static<typeof MentionSource>;

export const InstructedMentionSchema = Type.Object({
	mention: Type.String(),
	source: MentionSource,
});

/** Where an extracted mention came from: a backticked command span after an
 * imperative verb, or a bare word naming one of the session's own tools. */
export interface InstructedMention extends Static<typeof InstructedMentionSchema> {}

const IMPERATIVE_VERBS = /^(run|use|call|execute|invoke|try)(?:\s+to)?\s+/i;

/** Words that may precede an imperative without changing that it is one. */
const LEAD_IN = /^(please|kindly|now|then|first|next|finally|also|and|or|but)\b[,;:]?\s*/i;
const NEGATION = /^(?:do\s+not|don'?t|never)\b[,;:]?\s*/i;

/** A plausible tool or command word: starts with a letter, identifier-ish. */
function isCommandWord(word: string): boolean {
	return /^[A-Za-z][\w./@+-]*$/.test(word);
}

/**
 * Strip the sentence-initial scaffolding (markdown bullet, quote marks,
 * polite/sequencing lead-ins) and report whether a negation preceded the verb.
 */
export function stripLeadIn(sentence: string): { rest: string; negated: boolean } {
	let s = sentence.trim();
	// Markdown list markers ("- ", "* ", "1. ") and opening quote/backtick chars.
	s = s.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^["'`“”‘’]+/, "");
	let negated = false;
	for (;;) {
		const neg = NEGATION.exec(s);
		if (neg) {
			negated = true;
			s = s.slice(neg[0].length);
			continue;
		}
		const lead = LEAD_IN.exec(s);
		if (!lead) break;
		s = s.slice(lead[0].length).replace(/^["'“”]+/, "");
	}
	return { rest: s, negated };
}

/** First token of a backticked span: `git diff origin/main...HEAD` → "git". */
export function firstToken(span: string): string | null {
	const token = span.trim().split(/\s+/)[0] ?? "";
	return isCommandWord(token) ? token : null;
}

/**
 * Extract instructed tools/commands from the session's first user/task message.
 *
 * Guards against false positives:
 *   - only imperative sentences count (sentence-initial verb after lead-ins);
 *   - negated imperatives ("don't run X") never count as instructions;
 *   - a bare (unbackticked) word is accepted only when it names one of the
 *     session's actually-available tools — prose mentions of unknown words
 *     are ignored;
 *   - backticked spans must start with a command-shaped word.
 */
export function extractInstructedMentions(text: string, availableToolNames: ReadonlySet<string>): InstructedMention[] {
	const mentions: InstructedMention[] = [];
	const seen = new Set<string>();

	for (const line of text.split(/\r?\n/)) {
		for (const segment of line.split(/(?<=[.!?;:])\s+/)) {
			const { rest, negated } = stripLeadIn(segment);
			if (negated) continue;
			const verb = IMPERATIVE_VERBS.exec(rest);
			if (!verb) continue;

			// Backticked command span right after the verb.
			const afterVerb = rest.slice(verb[0].length);
			const bt = /^`([^`\n]+)`/.exec(afterVerb);
			if (bt) {
				const token = firstToken(bt[1] ?? "");
				if (token && !seen.has(token)) {
					seen.add(token);
					mentions.push({ mention: token, source: "backticked" });
				}
				continue;
			}

			// Bare word: only counts when it names an available tool.
			const bare = /^(?:the\s+)?([A-Za-z][\w.-]*)/.exec(afterVerb);
			const word = bare?.[1];
			if (word && availableToolNames.has(word) && !seen.has(word)) {
				seen.add(word);
				mentions.push({ mention: word, source: "known-tool" });
			}
		}
		if (mentions.length >= MENTION_CAP) break;
	}
	return mentions.slice(0, MENTION_CAP);
}

export const TargetResolutionKind = Type.Union([
	Type.Literal("direct"),
	Type.Literal("shell-command"),
	Type.Literal("unavailable"),
]);
export type TargetResolutionKind = Static<typeof TargetResolutionKind>;

export type TargetResolution =
	| { resolution: "direct"; tool: string }
	| { resolution: "shell-command"; tool: string }
	| { resolution: "unavailable"; tool: null };

/**
 * Resolve an instructed mention to the tool whose avoidance would be measured:
 * directly when the name itself is an available tool (`use \`rg\``), otherwise
 * to the session's shell tool for a command word (`run \`git diff\`` → bash).
 * When neither exists the instruction was not actionable — condition 2 fails
 * honestly (the agent could not have used what it does not have).
 */
export function resolveTargetTool(
	mention: string,
	availableToolNames: ReadonlySet<string>,
	cfg: TaskToolMismatchConfig,
): TargetResolution {
	if (availableToolNames.has(mention)) return { resolution: "direct", tool: mention };
	for (const shell of cfg.shellToolNames) {
		if (availableToolNames.has(shell)) return { resolution: "shell-command", tool: shell };
	}
	return { resolution: "unavailable", tool: null };
}

/** Calls of one specific tool across the session's action stream. */
export function countCallsOf(invocations: ReadonlyArray<ToolInvocation>, toolName: string): number {
	return invocations.filter((inv) => inv.name === toolName).length;
}

/**
 * Whether any shell invocation actually ran the instructed command word
 * (word-boundary match on the `command` argument). Informational evidence:
 * condition 3 stays the issue's literal test (0 calls of the target tool),
 * so this never gates by itself.
 */
export function ranInstructedCommand(invocations: ReadonlyArray<ToolInvocation>, commandWord: string): boolean {
	const re = new RegExp(`\\b${commandWord.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	return invocations.some((inv) => typeof inv.args["command"] === "string" && re.test(inv.args["command"] as string));
}

/** Substitute-tool call counts across the session's action stream. */
export function substituteBreakdown(
	invocations: ReadonlyArray<ToolInvocation>,
	cfg: TaskToolMismatchConfig,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (const inv of invocations) {
		if (!cfg.substituteTools.includes(inv.name)) continue;
		counts.set(inv.name, (counts.get(inv.name) ?? 0) + 1);
	}
	return counts;
}

/** Per-mention verdict carried on the node. */
export const MentionVerdictSchema = Type.Object({
	mention: Type.String(),
	source: MentionSource,
	resolution: TargetResolutionKind,
	target_tool: Type.Union([Type.String(), Type.Null()]),
	target_tool_calls: Type.Number(),
	ran_instructed_command: Type.Boolean(),
	mismatched: Type.Boolean(),
});
export interface MentionVerdict extends Static<typeof MentionVerdictSchema> {}

export const DetectionResultSchema = Type.Object({
	instruction_message_id: Type.Union([Type.String(), Type.Null()]),
	verdicts: Type.Array(MentionVerdictSchema),
	substitute_calls: Type.Number(),
	substitute_tool_names: Type.Array(Type.String()),
	available_tools: Type.Number(),
	mismatch_found: Type.Boolean(),
});
export type DetectionResult = Static<typeof DetectionResultSchema>;

/**
 * The four conditions (#158), evaluated per instructed mention:
 *   1. the first user/task message instructs use of a tool/command;
 *   2. that tool resolves to something the session had available;
 *   3. the agent made 0 calls of that tool;
 *   4. the agent made many substitute calls reconstructing results by hand.
 */
export function detectTaskToolMismatch(input: {
	firstUserMessageId: string | null;
	firstUserText: string;
	availableToolNames: ReadonlySet<string>;
	invocations: ReadonlyArray<ToolInvocation>;
	cfg: TaskToolMismatchConfig;
}): DetectionResult {
	const substitutes = substituteBreakdown(input.invocations, input.cfg);
	const substituteCalls = [...substitutes.values()].reduce((a, b) => a + b, 0);

	const verdicts: MentionVerdict[] = [];
	for (const m of extractInstructedMentions(input.firstUserText, input.availableToolNames)) {
		const target = resolveTargetTool(m.mention, input.availableToolNames, input.cfg);
		if (target.resolution === "unavailable") {
			verdicts.push({
				...m,
				resolution: target.resolution,
				target_tool: null,
				target_tool_calls: 0,
				ran_instructed_command: false,
				mismatched: false,
			});
			continue;
		}
		const targetCalls = countCallsOf(input.invocations, target.tool);
		verdicts.push({
			...m,
			resolution: target.resolution,
			target_tool: target.tool,
			target_tool_calls: targetCalls,
			ran_instructed_command: ranInstructedCommand(input.invocations, m.mention),
			mismatched: targetCalls === 0 && substituteCalls >= input.cfg.minSubstituteCalls,
		});
	}

	return {
		instruction_message_id: input.firstUserMessageId,
		verdicts,
		substitute_calls: substituteCalls,
		substitute_tool_names: [...substitutes.entries()].map(([name, count]) => `${name}×${count}`),
		available_tools: input.availableToolNames.size,
		mismatch_found: verdicts.some((v) => v.mismatched),
	};
}
