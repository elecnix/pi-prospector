/**
 * Phase classification and plan-compliance signal detection (issue #115).
 *
 * Pure, deterministic functions: a session's ordered messages are split into
 * turns (DESIGN.md §2 — one turn spans everything between two user messages),
 * each turn is mapped to exactly one problem-solving phase
 * (navigate | reproduce | patch | validate | other), and drift is read from
 * the resulting phase sequence.
 *
 * The read-only/mutating half of every bash command is decided by reusing
 * tool-trajectory's arg-parser (`normalizeToolCall`), so both analyzers agree
 * on what "the agent changed something" means. No LLM anywhere.
 */

import { normalizeToolCall } from "../tool-trajectory/arg-parser.js";
import {
	PhaseName as PhaseNameSchema,
	type PhaseName as PhaseNameType,
	type PhaseTrajectoryConfig,
} from "./config.js";
import { Type, type Static } from "typebox";

/** The narrow slice of a message row this module reads. */
export interface TurnSourceMessage {
	id: string;
	role: string;
	/** Serialised JSON array of `{name, arguments}` tool calls, or null. */
	tool_calls?: string | null;
}

// ─────────────────────────── node content schemas ───────────────────────────

export const PhaseEntrySchema = Type.Object({
	/** Zero-based turn ordinal within the session. */
	turn_index: Type.Number(),
	phase: PhaseNameSchema,
	/** The user message that opened this turn — its anchor in the transcript. */
	user_message_id: Type.String(),
	/** Assistant message ids within the turn that carried tool calls. */
	message_ids: Type.Array(Type.String()),
	/** Up to five representative commands, truncated, for evidence reading. */
	sample_commands: Type.Array(Type.String()),
});
export type PhaseEntry = Static<typeof PhaseEntrySchema>;

export const PhaseSignalKind = Type.Union([
	Type.Literal("premature-patching"),
	Type.Literal("skip-validation"),
	Type.Literal("no-patch-termination"),
	Type.Literal("phase-order-violation"),
	Type.Literal("prolonged-stagnation"),
]);
export type PhaseSignalKind = Static<typeof PhaseSignalKind>;

export const PhaseSignalSchema = Type.Object({
	signal: PhaseSignalKind,
	/**
	 * True when the signal is a plan violation (premature patching,
	 * skip-validation, no-patch-termination, phase-order-violation);
	 * false for prolonged-stagnation, which is inefficiency, not violation.
	 */
	plan_violation: Type.Boolean(),
	description: Type.String(),
	turn_indices: Type.Array(Type.Number()),
	user_message_ids: Type.Array(Type.String()),
	/** The phase involved (stagnation runs; single-phase violations). */
	phase: Type.Optional(PhaseNameSchema),
	/** For stagnation: how many consecutive turns made up the run. */
	count: Type.Optional(Type.Number()),
});
export type PhaseSignal = Static<typeof PhaseSignalSchema>;

// ─────────────────────────── classification ───────────────────────────

/** What one tool call is, independent of where it falls in the session. */
type CallKind = "mutating" | "test" | "check" | "readonly" | "neutral";

function compilePatterns(sources: readonly string[]): RegExp[] {
	return sources.map((src) => new RegExp(src, "i"));
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((p) => p.test(text));
}

/**
 * Overrides are checked before every built-in rule: a matcher either equals a
 * structured tool name (case-insensitively) or matches a bash command as a
 * case-insensitive regex. Phases are walked in declaration order of the
 * overrides record, so conflicting overrides resolve deterministically.
 */
class OverrideMatcher {
	private readonly byPhase: Array<{ phase: PhaseNameType; regexes: RegExp[]; literals: Set<string> }>;

	constructor(overrides: Record<string, string[]>) {
		this.byPhase = [];
		for (const [phaseRaw, matchers] of Object.entries(overrides)) {
			if (!PHASE_NAME_SET.has(phaseRaw) || !Array.isArray(matchers)) continue;
			this.byPhase.push({
				phase: phaseRaw as PhaseNameType,
				regexes: matchers.map((m) => new RegExp(m, "i")),
				literals: new Set(matchers.map((m) => m.toLowerCase())),
			});
		}
	}

	hit(name: string, argsText: string): PhaseNameType | null {
		for (const entry of this.byPhase) {
			if (entry.regexes.some((r) => r.test(argsText))) return entry.phase;
			if (entry.literals.has(name.toLowerCase())) return entry.phase;
		}
		return null;
	}
}

const PHASE_NAME_SET: ReadonlySet<string> = new Set([
	"navigate",
	"reproduce",
	"patch",
	"validate",
	"other",
]);

function kindOfCall(
	name: string,
	args: Record<string, unknown>,
	testRe: readonly RegExp[],
	checkRe: readonly RegExp[],
): CallKind {
	if (name === "bash") {
		const command = typeof args["command"] === "string" ? (args["command"] as string) : "";
		const normalized = normalizeToolCall({ name, args, messageId: "" });
		// Order matters: a command that runs tests is reproduce/validate material
		// even though it also executes mutating-looking shell plumbing.
		if (command && matchesAny(command, testRe)) return "test";
		if (command && matchesAny(command, checkRe)) return "check";
		return normalized.readOnly ? "readonly" : "mutating";
	}
	if (name === "read" || name === "grep" || name === "glob") return "readonly";
	if (name === "edit" || name === "write") return "mutating";
	// Unknown structured tools (subagent dispatch, todo trackers, web fetch…)
	// are neither navigation nor mutation here — they classify `other` rather
	// than being read as source edits they never performed.
	return "neutral";
}

/** One classified turn of work. */
export interface ClassifiedTurn {
	turnIndex: number;
	phase: PhaseNameType;
	userMessageId: string;
	messageIds: string[];
	sampleCommands: string[];
}

const SAMPLE_COMMAND_CAP = 5;

/**
 * Split messages into turns and map each to exactly one phase.
 *
 * Per-turn precedence: an explicit override hit > any mutating call (patch) >
 * any test run > any validation-only check > any read-only call (navigate) >
 * other. A test run before any patch classifies `reproduce`; the identical
 * command after a patch classifies `validate` — the ordering dependency IS the
 * signal. A check command (lint/typecheck/CI status) only counts as validate
 * after a patch; before one it is ordinary navigation.
 */
export function classifyTurnPhases(
	messages: readonly TurnSourceMessage[],
	config: PhaseTrajectoryConfig,
): ClassifiedTurn[] {
	const testRe = compilePatterns(config.testCommandPatterns);
	const checkRe = compilePatterns(config.checkCommandPatterns);
	const overrides = new OverrideMatcher(config.phaseToolOverrides);

	const turns: ClassifiedTurn[] = [];
	let patched = false;
	let current: {
		turnIndex: number;
		userMessageId: string;
		messageIds: string[];
		calls: Array<{ name: string; args: Record<string, unknown>; argsText: string; display: string }>;
	} | null = null;

	const flush = (): void => {
		if (!current) return;
		const phase = resolvePhase(current.calls, {
			testRe,
			checkRe,
			overrides,
			patchedBeforeResolution: patched,
		});
		if (phase === "patch") patched = true;
		turns.push({
			turnIndex: current.turnIndex,
			phase,
			userMessageId: current.userMessageId,
			messageIds: current.messageIds,
			sampleCommands: current.calls.slice(0, SAMPLE_COMMAND_CAP).map((c) => c.display),
		});
	};

	let turnIndex = -1;
	for (const message of messages) {
		if (message.role === "user") {
			flush();
			turnIndex++;
			current = { turnIndex, userMessageId: message.id, messageIds: [], calls: [] };
			continue;
		}
		if (!current || !message.tool_calls) continue;
		let parsed: Array<{ name?: unknown; arguments?: Record<string, unknown> }>;
		try {
			parsed = JSON.parse(message.tool_calls) as Array<{ name?: unknown; arguments?: Record<string, unknown> }>;
		} catch (e) {
			throw new Error(`phase-trajectory: unparseable tool_calls JSON on message ${message.id}: ${String(e)}`);
		}
		for (const call of parsed) {
			if (typeof call.name !== "string") continue;
			const args = (call.arguments ?? {}) as Record<string, unknown>;
			const command = typeof args["command"] === "string" ? (args["command"] as string) : "";
			current.messageIds.push(message.id);
			current.calls.push({
				name: call.name,
				args,
				argsText: command,
				display: command
					? `${call.name}: ${command.length > 80 ? command.slice(0, 77) + "…" : command}`
					: `${call.name}: ${(JSON.stringify(args).length > 80 ? JSON.stringify(args).slice(0, 77) + "…" : JSON.stringify(args))}`,
			});
		}
	}
	flush();

	return turns;
}

interface ResolutionInput {
	testRe: readonly RegExp[];
	checkRe: readonly RegExp[];
	overrides: OverrideMatcher;
	patchedBeforeResolution: boolean;
}

function resolvePhase(
	calls: Array<{ name: string; argsText: string }>,
	input: ResolutionInput,
): PhaseNameType {
	for (const call of calls) {
		const hit = input.overrides.hit(call.name, call.argsText);
		if (hit) return hit;
	}

	let sawTest = false;
	let sawCheck = false;
	let sawReadonly = false;
	for (const call of calls) {
		const args: Record<string, unknown> = call.argsText !== "" ? { command: call.argsText } : {};
		switch (kindOfCall(call.name, args, input.testRe, input.checkRe)) {
			case "mutating":
				return "patch";
			case "test":
				sawTest = true;
				break;
			case "check":
				sawCheck = true;
				break;
			case "readonly":
				sawReadonly = true;
				break;
			case "neutral":
				break;
		}
	}
	if (sawTest) return input.patchedBeforeResolution ? "validate" : "reproduce";
	if (sawCheck) return input.patchedBeforeResolution ? "validate" : "navigate";
	if (sawReadonly) return "navigate";
	return "other";
}

// ─────────────────────────── signal detection ───────────────────────────

function evidenceOf(entries: readonly ClassifiedTurn[]): {
	turn_indices: number[];
	user_message_ids: string[];
} {
	return {
		turn_indices: entries.map((e) => e.turnIndex),
		user_message_ids: entries.map((e) => e.userMessageId),
	};
}

/**
 * Detect all plan-compliance signals over the classified phase sequence:
 *
 * - premature-patching — a patch turn before any navigate or reproduce turn;
 * - skip-validation — a patch exists but nothing validates after the last one;
 * - no-patch-termination — real work happened but never reached patch phase;
 * - phase-order-violation — the phases first appear out of canonical order
 *   (e.g. validate before patch). With the default mapping the reproduce /
 *   validate routing already enforces order for test commands, so this fires
 *   on sessions whose configured mappings let phases land out of sequence;
 * - prolonged-stagnation — ≥ stagnationMin consecutive turns in one phase
 *   (inefficiency, not a plan violation).
 */
export function detectPhaseSignals(
	entries: readonly ClassifiedTurn[],
	config: PhaseTrajectoryConfig,
): PhaseSignal[] {
	const signals: PhaseSignal[] = [];

	const workEntries = entries.filter((e) => e.phase !== "other");
	const firstPatch = workEntries.findIndex((e) => e.phase === "patch");
	let lastPatch = -1;
	for (let i = 0; i < workEntries.length; i++) {
		if (workEntries[i]?.phase === "patch") lastPatch = i;
	}

	// ── premature-patching ──
	// The first non-other phase of the session is already a patch: the agent
	// edited source before it navigated anything or reproduced the problem.
	if (workEntries.length > 0 && workEntries[0]?.phase === "patch") {
		const offender = workEntries[0];
		signals.push({
			signal: "premature-patching",
			plan_violation: true,
			description: `First work of the session was a patch (turn ${offender.turnIndex}) with no prior navigate or reproduce phase`,
			...evidenceOf([offender]),
			phase: "patch",
		});
	}

	// ── skip-validation ──
	// Something was patched and the session ended without validating after the
	// final patch. A validate after the LAST patch keeps this quiet — iterating
	// patch → test → patch → test is the healthy cycle.
	if (lastPatch >= 0 && !workEntries.some((e, i) => i > lastPatch && e.phase === "validate")) {
		signals.push({
			signal: "skip-validation",
			plan_violation: true,
			description: `Session patched (last at turn ${workEntries[lastPatch]!.turnIndex}) but never validated afterwards`,
			...evidenceOf([workEntries[lastPatch]!]),
			phase: "patch",
		});
	}

	// ── no-patch-termination ──
	// Real work happened — navigation or reproduction or validation — yet the
	// agent never reached the patch phase at all. A session of pure chat stays
	// quiet: there was no plan to violate when there was no work either.
	if (firstPatch < 0 && workEntries.length > 0) {
		signals.push({
			signal: "no-patch-termination",
			plan_violation: true,
			description: `Session did ${workEntries.length} turn(s) of work but never entered the patch phase`,
			...evidenceOf(workEntries),
		});
	}

	// ── phase-order-violation ──
	// Generic canonical-order check: the order in which the plan phases FIRST
	// appear must be the canonical order filtered to the phases present.
	const seen: PhaseNameType[] = [];
	for (const e of entries) {
		if ((config.canonicalOrder as readonly string[]).includes(e.phase) && !seen.includes(e.phase)) {
			seen.push(e.phase);
		}
	}
	const expected = config.canonicalOrder.filter((p) => seen.includes(p));
	for (let i = 0; i < Math.min(seen.length, expected.length); i++) {
		const observed = seen[i];
		const canonical = expected[i];
		if (observed !== canonical) {
			const offender = entries.find((e) => e.phase === observed);
			signals.push({
				signal: "phase-order-violation",
				plan_violation: true,
				description: `Phase "${observed}" appeared out of canonical order (expected "${canonical}" first) — canonical order is ${config.canonicalOrder.join(" → ")}`,
				...(offender ? evidenceOf([offender]) : { turn_indices: [], user_message_ids: [] }),
				...(observed ? { phase: observed } : {}),
			});
			break; // one violation per session: name the first divergence
		}
	}

	// ── prolonged-stagnation ──
	// Maximal runs of consecutive same-phase turns at or past the threshold.
	// Every phase participates, including `other`: seven straight turns of
	// planning is stagnation too.
	let runStart = 0;
	while (runStart < entries.length) {
		const phase = entries[runStart]!.phase;
		let end = runStart + 1;
		while (end < entries.length && entries[end]?.phase === phase) end++;
		const length = end - runStart;
		if (length >= config.stagnationMin) {
			const run = entries.slice(runStart, end);
			signals.push({
				signal: "prolonged-stagnation",
				plan_violation: false,
				description: `${length} consecutive turns in the "${phase}" phase (threshold ${config.stagnationMin})`,
				...evidenceOf(run),
				phase,
				count: length,
			});
		}
		runStart = end;
	}

	return signals;
}


