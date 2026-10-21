/**
 * verification-commands — which shell commands verify the working tree.
 *
 * The `stale-verification` analyzer measures verification time a later edit
 * threw away, but it can only measure a run it recognises. The shipped
 * `verificationPatterns` cover the common runners (`npm test`, `go test`,
 * `cargo clippy`, a `*.sh` gate script), and a project whose checks run
 * through `tox`, `bazel test`, `just test`, or a gate script of its own naming
 * gets a count of zero, which reads as "no waste" rather than "not measured".
 *
 * This analyzer closes that gap by learning the answer. It nominates the
 * commands a session actually ran, asks a decision model once per distinct
 * command for the whole corpus, and stores each verdict as a node. The
 * verdict is a subject of the corpus, not of the session that first surfaced
 * it, so the graph itself is the cache: the first session to run a command
 * pays one model call, and every later session reuses the verdict for nothing.
 *
 * The nomination is deterministic and free. A command is nominated when it
 * lasted at least `minRunSeconds` and either ran twice with an edit between
 * it, or ran right before a commit — the two shapes a gate run takes. A
 * command the shipped patterns already match is not nominated, because the
 * pattern list already covers it and the model call would pay for a verdict
 * nobody needs.
 *
 * The verdict is one of three: `full` (the whole suite, the gate script, the
 * build), `narrow` (one test file, one linted package), or
 * `not_verification` (reads, lists, edits, installs, starts a server). The
 * `full` versus `narrow` distinction is the part a regex cannot give, and it
 * is what lets a proposal say "the full gate ran again after one edit" rather
 * than "a check ran again".
 *
 * Without a decision model configured, the analyzer nominates nothing and the
 * pattern list stands alone. The command lines are the only session text that
 * leaves the machine, and only when a decision model is configured.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, computeSourceSetHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import { decisionIdentity } from "../../decision-model.js";
import { DEFAULT_STALE_VERIFICATION_CONFIG } from "../stale-verification/config.js";
import { commandSegments, editCallTimes, normaliseCommand, shellCalls } from "../stale-verification/command-vocabulary.js";
import { DEFAULT_VERIFICATION_COMMANDS_CONFIG, type VerificationCommandsConfig } from "./config.js";
import {
	VERIFICATION_DECISION_QUESTIONS,
	VERIFICATION_DECISION_QUESTIONS_HASH,
	parseVerificationDecision,
} from "./decision.js";

export {
	VERIFICATION_DECISION_QUESTIONS,
	VERIFICATION_DECISION_QUESTIONS_HASH,
	parseVerificationDecision,
} from "./decision.js";
export type { VerificationVerdict } from "./decision.js";

/** One nominated command, before any model has judged it. */
export interface CommandCandidate {
	/** The normalised command line. */
	command: string;
	/** The longest run of this command in the session, in seconds. */
	seconds: number;
	/** How many times the session ran it. */
	runs: number;
}

/** The stored verdict for one command. */
export const VerificationCommandProperties = Type.Object({
	/** The normalised command this verdict is about. */
	command: Type.String(),
	/** What the command does to the working tree. */
	verdict: Type.String(),
	confidence: Type.Number(),
	/** The distribution over the options, stored as the evidence. */
	probabilities: Type.Optional(Type.Record(Type.String(), Type.Number())),
});
export type VerificationCommandProperties = Static<typeof VerificationCommandProperties>;

export const VERIFICATION_COMMANDS_DEF: AnalyzerDef = {
	id: "verification-commands",
	label: "Verification Commands (corpus-wide, decision model)",
	description:
		"Learns which shell commands verify the working tree. It nominates the commands a session actually ran, asks a decision model once per distinct command for the whole corpus, and records the verdict: a full check (the whole suite, the gate script, a build), a narrow check (one test file, one linted package), or not a check at all. The verdict is a subject of the corpus, so the first session to run a command pays one model call and every later session reuses it.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: VerificationCommandProperties,
};

export const VERIFICATION_COMMANDS_VERSION: AnalyzerVersion = {
	analyzerId: VERIFICATION_COMMANDS_DEF.id,
	major: 1,
	minor: 0,
	implementationKind: "in_process_llm",
	codeRef: "src/analyze/analyzers/verification-commands/index.ts",
};

/** The stored config over the defaults, so a partial config cannot leave a threshold undefined. */
export function resolveConfig(raw: unknown): VerificationCommandsConfig {
	return { ...DEFAULT_VERIFICATION_COMMANDS_CONFIG, ...((raw as Partial<VerificationCommandsConfig> | null | undefined) ?? {}) };
}

/**
 * The command line as the model sees it: the normalised form, capped in length.
 */
function commandForModel(command: string, max = 400): string {
	return command.length > max ? `${command.slice(0, max - 1)}…` : command;
}

/**
 * Whether the shipped pattern list already covers a command.
 *
 * The check runs on the line's segments, the same way the detector matches
 * patterns, so the two agree on what "already covered" means. A line like
 * `cd /repo && npm test` holds a command the patterns cover, and the corpus
 * must not pay a model call for a verdict it already has.
 */
function matchesKnownPattern(command: string): boolean {
	return commandSegments(command).some((segment) =>
		DEFAULT_STALE_VERIFICATION_CONFIG.verificationPatterns.some((source) => {
			try {
				return new RegExp(`^(?:${source})`, "i").test(segment);
			} catch {
				return false;
			}
		}),
	);
}

/** Whether a shell line commits. */
function isCommit(command: string): boolean {
	return commandSegments(command).some((segment) => /^git\s+(-C\s+\S+\s+)?commit\b/.test(segment));
}

/**
 * The commands worth a model call.
 *
 * A command qualifies when it lasted at least `minRunSeconds` and either ran
 * twice with an edit between the two runs, or ran right before a commit. Both
 * shapes are what a gate run looks like: the agent ran the whole suite, then
 * changed something and ran it again, or ran it and committed. A command that
 * ran once, briefly, matches neither and is not nominated.
 *
 * The nomination uses the *raw* command line, not the segments a launcher
 * split off, because the model judges the command the agent actually typed.
 * Two lines that differ only in their launcher are two entries, and both get
 * judged; the corpus pays for each once.
 */
export function nominateCommands(messages: readonly MessageRow[], config: VerificationCommandsConfig): CommandCandidate[] {
	const calls = shellCalls(messages, config.shellToolNames);
	const edits = editCallTimes(messages, DEFAULT_STALE_VERIFICATION_CONFIG.editToolNames);
	const commitTimes = calls.filter((c) => isCommit(c.command)).map((c) => c.startMs).filter((t): t is number => t !== null);

	// The commands this session ran, with the longest run and the run count.
	const runs = new Map<string, { seconds: number; runs: number; times: number[] }>();
	for (const call of calls) {
		if (call.isError) continue;
		const seconds = call.seconds ?? 0;
		const key = normaliseCommand(call.command);
		const seen = runs.get(key);
		if (seen) {
			seen.runs += 1;
			seen.seconds = Math.max(seen.seconds, seconds);
			if (call.startMs !== null) seen.times.push(call.startMs);
		} else {
			runs.set(key, { seconds, runs: 1, times: call.startMs === null ? [] : [call.startMs] });
		}
	}

	const candidates: CommandCandidate[] = [];
	for (const [command, seen] of runs) {
		if (seen.seconds < config.minRunSeconds) continue;
		if (config.skipKnownPatterns && matchesKnownPattern(command)) continue;
		const times = seen.times;
		let qualifies = false;
		if (times.length >= 2) {
			// Several runs: it counts when an edit separates two of them.
			qualifies = times.some((first, i) => times.slice(i + 1).some((second) => edits.some((e) => e > first && e < second)));
		} else {
			// One run: it counts only when a commit follows it.
			const last = times[0];
			qualifies = last !== undefined && commitTimes.some((c) => c > last);
		}
		if (!qualifies) continue;
		candidates.push({ command, seconds: seen.seconds, runs: seen.runs });
	}

	candidates.sort((a, b) => b.seconds - a.seconds || (a.command < b.command ? -1 : a.command > b.command ? 1 : 0));
	return candidates.slice(0, config.maxCandidatesPerSession);
}

export const verificationCommandsAnalyzer: Analyzer = {
	def: VERIFICATION_COMMANDS_DEF,
	version: VERIFICATION_COMMANDS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: VERIFICATION_COMMANDS_DEF.id,
		configHash: computeConfigHash(DEFAULT_VERIFICATION_COMMANDS_CONFIG),
		configJson: DEFAULT_VERIFICATION_COMMANDS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config) {
		const cfg = resolveConfig(config);
		if (cfg.decisionModel) return [decisionIdentity(cfg.decisionModel, VERIFICATION_DECISION_QUESTIONS_HASH)];
		return [];
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		const config = resolveConfig(ctx.config);
		// Without a decision model there is nobody to ask, so nothing is
		// nominated and the pattern list stands alone.
		if (!config.decisionModel) return [];
		if (ctx.messages.length === 0) return [];

		const candidates = nominateCommands(ctx.messages, config);
		if (candidates.length === 0) return [];

		return candidates.map((candidate): AnalysisUnit => {
			// The subject is the command itself, so the unit has the same identity
			// in every session that ran it. That is what makes the graph the
			// corpus-wide cache: the first session to run a command pays for the
			// verdict, and every later session finds the unit `current`.
			//
			// The source set names the command alone, so the node's content must
			// too. A session-specific number here would make the same command
			// produce two different outputs, one per session, and the corpus-wide
			// cache would stop reproducing on another machine.
			const sources: SourceRef[] = [{ kind: "term", id: candidate.command }];
			return {
				sources,
				sourceSetHash: computeSourceSetHash(sources),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { command: candidate.command } as unknown as Record<string, unknown>,
			};
		});
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const meta = unit.meta as unknown as { command: string };
		if (!config.decisionModel) {
			throw new Error("verification-commands planned a unit with no decision model configured.");
		}
		if (!ctx.decide) {
			throw new Error(
				`verification-commands is configured with decision model '${config.decisionModel}', but this run has no decision-model client.`,
			);
		}

		const decision = await ctx.decide({
			model: config.decisionModel,
			state: { command: commandForModel(meta.command) },
			questions: VERIFICATION_DECISION_QUESTIONS,
		});
		const verdict = parseVerificationDecision(decision);

		const properties: VerificationCommandProperties = {
			command: meta.command,
			verdict: verdict.verdict,
			confidence: verdict.confidence,
			probabilities: verdict.probabilities,
		};

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			modelUsed: decision.model,
			costUsd: decision.costUsd,
			tokensUsed: decision.inputTokens + decision.outputTokens,
			inputTokens: decision.inputTokens,
			cachedInputTokens: 0,
			outputTokens: decision.outputTokens,
			durationMs: decision.durationMs,
			edges: [{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 }],
		};
	},
};

/**
 * The commands the corpus judges to verify the working tree, keyed by the
 * normalised command.
 *
 * Reads the newest verdict per command across every session, so a verdict
 * learned in one session applies to all of them. A command the model judged
 * `not_verification` is absent: it verifies nothing.
 */
export function verificationCommandsByCommand(
	nodes: readonly { content_json: string }[],
): Map<string, VerificationCommandProperties> {
	const out = new Map<string, VerificationCommandProperties>();
	for (const node of nodes) {
		let props: VerificationCommandProperties;
		try {
			props = JSON.parse(node.content_json) as VerificationCommandProperties;
		} catch {
			continue;
		}
		if (!props.command || props.verdict === "not_verification") continue;
		out.set(props.command, props);
	}
	return out;
}

/** A fingerprint of a judged set, so a change in it is visible in a node's identity. */
export function judgedSetFingerprint(judged: ReadonlyMap<string, VerificationCommandProperties>): string {
	return shortHash(
		[...judged.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([command, props]) => `${command}=${props.verdict}`)
			.join("\n"),
	);
}
