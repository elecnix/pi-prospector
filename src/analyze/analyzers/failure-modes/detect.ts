/**
 * Turning a session's failures into countable, priced, safe-to-store groups —
 * and into proposals with measured evidence behind them.
 *
 * Every number a proposal quotes is computed here from the transcript. Nothing
 * is estimated: a failure with no recorded cost contributes nothing to a dollar
 * figure and is counted as unpriced instead, so a total is always a lower bound
 * that says so rather than a confident guess.
 */

import { shortHash } from "../../input-hash.js";
import type { ToolStream } from "../../tool-stream.js";
import { Type, type Static } from "typebox";
import {
	classifyChildRun,
	classifyFailure,
	failureClass,
	UNCLASSIFIED,
	type ChildRunFacts,
	FailureAxis,
} from "./classes.js";
import type { FailureModesConfig } from "./config.js";
import type { InstalledPackages } from "./installed.js";

/** One recognised cause within a class, counted. */
export const FailureCause = Type.Object({
	/** The curated matcher label. Never text taken from the error. */
	label: Type.String(),
	/**
	 * A short digest of the raw error text, so distinct underlying errors within
	 * one cause stay countable without any of them being readable. Recovering the
	 * text means opening the session — which is the point.
	 */
	fingerprint: Type.String(),
	count: Type.Number(),
});
export type FailureCause = Static<typeof FailureCause>;

/** All failures of one class (and, on the tool axis, one tool), aggregated. */
export const FailureGroup = Type.Object({
	axis: FailureAxis,
	class_id: Type.String(),
	/** The tool involved, for tool-axis groups, or the child agent's name on the child axis; "" on the turn axis. */
	tool: Type.String(),
	count: Type.Number(),
	/** The messages that failed, so the finding can be walked back to the turns. Empty on the child axis — a failed child run may have written no messages at all. */
	message_ids: Type.Array(Type.String()),
	causes: Type.Array(FailureCause),
	/** Summed billed cost of the *priced* failures, or null when none was priced. */
	cost_usd: Type.Union([Type.Number(), Type.Null()]),
	priced_count: Type.Number(),
	unpriced_count: Type.Number(),
});
export type FailureGroup = Static<typeof FailureGroup>;

export const RawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type RawProposal = Static<typeof RawProposal>;

/** Group a session's failures by class, on both axes. */
export function groupFailures(stream: ToolStream): FailureGroup[] {
	const groups = new Map<string, FailureGroup>();

	const add = (
		axis: FailureAxis,
		tool: string,
		text: string,
		messageId: string,
		costUsd: number | null,
		command = "",
	): void => {
		const { classId, label } = classifyFailure(text, axis, { command });
		const key = `${axis}|${classId}|${tool}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				axis,
				class_id: classId,
				tool,
				count: 0,
				message_ids: [],
				causes: [],
				cost_usd: null,
				priced_count: 0,
				unpriced_count: 0,
			};
			groups.set(key, group);
		}
		group.count++;
		group.message_ids.push(messageId);
		if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0) {
			group.cost_usd = (group.cost_usd ?? 0) + costUsd;
			group.priced_count++;
		} else {
			group.unpriced_count++;
		}

		// The fingerprint is of the *normalised* text so that two occurrences of
		// the same error — differing only in a request id or a retry count — count
		// as one cause rather than as two. When the result said nothing at all, the
		// command is the only thing that distinguishes one occurrence from another,
		// so it is fingerprinted instead — hashed, never stored, exactly like the
		// error text it stands in for.
		const fingerprint = shortHash(normalizeForFingerprint(text || command));
		const cause = group.causes.find((c) => c.label === label && c.fingerprint === fingerprint);
		if (cause) cause.count++;
		else group.causes.push({ label, fingerprint, count: 1 });
	};

	for (const tf of stream.turnFailures) {
		// A host that recorded a failure with no text still gets classified: the
		// stop reason is the only thing it said, so it is what we read.
		add("turn", "", tf.errorText || tf.stopReason || "", tf.messageId, tf.costUsd);
	}

	for (const inv of stream.invocations) {
		if (!inv.outcome?.isError) continue;
		// A failed result whose text could not be attributed unambiguously still
		// counts — as `unclassified`. Dropping it would understate the failure rate.
		//
		// The command is passed alongside the result because some failures leave no
		// trace in the result at all: a `grep` that finds nothing exits non-zero and
		// prints nothing, so the call is the only evidence there is.
		add("tool", inv.name, inv.outcome.errorText ?? "", inv.messageId, inv.costUsd, commandOf(inv.args));
	}

	// Deterministic order: the classes as catalogued, then by tool. An analyzer's
	// output is content-addressed, so a stable order is identity, not cosmetics.
	return [...groups.values()].sort(compareGroups);
}

/** The canonical ordering of failure groups — axis, then class, then tool. */
export function compareGroups(a: FailureGroup, b: FailureGroup): number {
	return a.axis !== b.axis
		? a.axis.localeCompare(b.axis)
		: a.class_id !== b.class_id
			? a.class_id.localeCompare(b.class_id)
			: a.tool.localeCompare(b.tool);
}

/** The command a tool call ran, when it has one. Non-shell tools have none. */
function commandOf(args: Record<string, unknown>): string {
	const raw = args["command"];
	return typeof raw === "string" ? raw : "";
}

/**
 * The slice of a `subagent_runs` row that child-run classification reads.
 *
 * A structural subset rather than the DB row type, so detection stays decoupled
 * from storage and a test can pass plain objects.
 */
export interface ChildRunInput {
	run_id: string;
	agent: string | null;
	exit_code: number | null;
	error: string | null;
	model_attempts: string | null;
	usage: string | null;
}

/**
 * Whether every recorded model attempt failed.
 *
 * False — not an exception — when nothing was recorded: a run with no attempt
 * list is classified by its other facts, and "no evidence of success" must not
 * be read as "evidence of total failure". Unrecorded stays unrecorded.
 */
function allModelAttemptsFailed(modelAttemptsJson: string | null): boolean {
	if (!modelAttemptsJson) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(modelAttemptsJson);
	} catch {
		return false;
	}
	if (!Array.isArray(parsed) || parsed.length === 0) return false;
	return parsed.every((a) => (a as { success?: unknown } | null)?.success !== true);
}

/** The recorded billed cost of a child run, or null when it was not priced. */
function childRunCost(usageJson: string | null): number | null {
	if (!usageJson) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(usageJson);
	} catch {
		return null;
	}
	const cost = (parsed as { cost?: unknown } | null)?.cost;
	return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

/**
 * Group failed child runs by class and agent, from artifact metadata.
 *
 * A healthy run classifies as `unclassified` and is dropped — on this axis,
 * unlike the transcript axes, unclassified means "did not fail", not "the
 * catalogue has a gap", because the classification starts from the run's own
 * claim about itself. Groups carry no message ids: a spawn-level failure wrote
 * no messages anywhere, which is precisely why it is visible only here.
 */
export function groupChildRunFailures(runs: readonly ChildRunInput[]): FailureGroup[] {
	const groups = new Map<string, FailureGroup>();

	for (const run of runs) {
		const facts: ChildRunFacts = {
			error: run.error ?? "",
			exitCode: run.exit_code,
			allModelAttemptsFailed: allModelAttemptsFailed(run.model_attempts),
		};
		const { classId, label } = classifyChildRun(facts);
		if (classId === UNCLASSIFIED.classId) continue;

		const agent = run.agent ?? "unknown";
		const key = `child|${classId}|${agent}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				axis: "child",
				class_id: classId,
				tool: agent,
				count: 0,
				message_ids: [],
				causes: [],
				cost_usd: null,
				priced_count: 0,
				unpriced_count: 0,
			};
			groups.set(key, group);
		}
		group.count++;

		const cost = childRunCost(run.usage);
		if (cost !== null && cost > 0) {
			group.cost_usd = (group.cost_usd ?? 0) + cost;
			group.priced_count++;
		} else {
			group.unpriced_count++;
		}

		// Same discipline as the transcript axes: the fingerprint covers the
		// normalised error text so repeat occurrences count as one cause. When the
		// artifact recorded no text at all, the curated label is all there is.
		const fingerprint = shortHash(normalizeForFingerprint(facts.error || label));
		const cause = group.causes.find((c) => c.label === label && c.fingerprint === fingerprint);
		if (cause) cause.count++;
		else group.causes.push({ label, fingerprint, count: 1 });
	}

	return [...groups.values()].sort(compareGroups);
}

/**
 * Collapse the incidental parts of an error message before fingerprinting.
 *
 * Request ids, timestamps, counts, paths, and parenthesised account names differ
 * between two occurrences of what is plainly the same failure. Folding them away
 * is what makes "this happened 40 times" true rather than "40 distinct errors".
 */
export function normalizeForFingerprint(text: string): string {
	return text
		.slice(0, 400)
		.replace(/https?:\/\/\S+/g, "<url>")
		.replace(/\/[\w.\-/]{4,}/g, "<path>")
		.replace(/\([^)]*\)/g, "(…)")
		.replace(/\b[0-9a-f]{8,}\b/gi, "<id>")
		.replace(/\d+/g, "N")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

export interface ProposalInputs {
	sessionId: string;
	groups: FailureGroup[];
	/** Assistant generations in the session — the denominator for a turn-failure rate. */
	assistantTurnCount: number;
	/** Tool calls issued — the denominator for a tool-failure rate. */
	toolCallCount: number;
	installed: InstalledPackages;
	config: FailureModesConfig;
}

/**
 * Build proposals from grouped failures.
 *
 * A class earns a proposal only when it cleared its threshold — a single
 * transient failure is noise, and proposing on it trains the reader to ignore
 * the output. When the class's remedy kind is `extension` and one of its
 * verified extensions is not already installed, the proposal targets an
 * `extension`; otherwise it targets the ordinary remedy, because a class whose
 * fix is "top up the account" or "fix PATH" should not be dressed up as a
 * package recommendation.
 */
export function buildProposals(input: ProposalInputs): RawProposal[] {
	const proposals: RawProposal[] = [];

	for (const group of input.groups) {
		const cls = failureClass(group.class_id);
		// An unrecognised failure is a gap in the catalogue, not a finding to act
		// on: proposing "something went wrong 9 times" gives the reader nothing to
		// do. The count is on the node, where it is evidence that a matcher is
		// missing.
		if (!cls || !cls.actionable) continue;

		const threshold = group.axis === "turn" ? input.config.minTurnFailures : input.config.minToolFailures;
		if (group.count < threshold) continue;

		// A child run has no per-session denominator of its own kind here — only
		// failed runs are grouped, so a rate would need the healthy-run count, which
		// the grouping deliberately does not carry. The absolute count speaks.
		const denominator = group.axis === "turn" ? input.assistantTurnCount : group.axis === "tool" ? input.toolCallCount : 0;
		const rate = denominator > 0 ? group.count / denominator : null;
		const subject =
			group.axis === "turn" ? "turns" : group.axis === "child" ? `${group.tool} child runs` : `${group.tool} calls`;

		const costNote =
			group.priced_count > 0
				? ` ${group.priced_count}/${group.count} priced occurrences sum to $${group.cost_usd!.toFixed(4)} (lower bound).`
				: " None of these occurrences carried a recorded cost, so the money lost is unknown.";
		const rateNote = rate === null ? "" : ` That is ${(rate * 100).toFixed(1)}% of the session's ${denominator} ${group.axis === "turn" ? "assistant turns" : "tool calls"}.`;

		// The remedy-kind gate: only a class whose fix *is* a package may name one.
		// An environment class with extensions in its entry (a curation mistake this
		// gate exists to contain) falls through to its prose remedy instead of
		// producing an install suggestion that cannot work.
		const candidates = cls.remedyKind === "extension"
			? cls.extensions.filter((e) => !input.installed.names.has(e.pkg))
			: [];
		const alreadyInstalled = cls.extensions.filter((e) => input.installed.names.has(e.pkg));

		if (candidates.length > 0) {
			const pick = candidates[0]!;
			const alternatives = candidates.slice(1);
			const installedNote = alreadyInstalled.length > 0
				? ` Already installed and evidently not covering this: ${alreadyInstalled.map((e) => e.pkg).join(", ")}.`
				: input.installed.known
					? ""
					: " (The installed-package list could not be read, so this may already be installed.)";

			proposals.push({
				target_type: "extension",
				target_path: `npm:${pick.pkg}`,
				title: `${cls.label}: ${group.count} ${subject} — consider ${pick.pkg}`,
				summary:
					`${group.count} ${subject} in this session ended in ${cls.label}.${rateNote}${costNote}`,
				detail:
					`${cls.remedy} ${pick.pkg} (v${pick.verifiedVersion}, ${pick.license}) ${lowerFirst(pick.note)}` +
					(alternatives.length > 0
						? ` Alternatives addressing the same class: ${alternatives.map((e) => e.pkg).join(", ")}.`
						: "") +
					installedNote +
					" Review it before installing — this is a pointer to a package, not an endorsement, and nothing is installed for you.",
				evidence: evidenceFor(group),
				confidence: confidenceFor(group.count, threshold),
				severity: "waste",
			});
			continue;
		}

		// No package to recommend — the class is environment or prompt kind, or
		// every candidate is already installed. Both mean the same thing for the
		// reader: here is the finding and the fix that does not involve installing
		// anything.
		const exhaustedNote = cls.remedyKind === "extension" && cls.extensions.length > 0
			? ` Every extension this system knows of for this class is already installed (${alreadyInstalled.map((e) => e.pkg).join(", ")}), so the remaining fix is not a package.`
			: "";

		// Where the finding lives: an environment failure points at the machine's
		// setup; everything else at configuration or the standing instructions.
		const targetType = cls.remedyKind === "environment"
			? "environment"
			: group.axis === "turn"
				? "config"
				: "agents_md";

		proposals.push({
			target_type: targetType,
			title: `${cls.label}: ${group.count} ${subject}`,
			summary: `${group.count} ${subject} in this session ended in ${cls.label}.${rateNote}${costNote}`,
			detail: cls.remedy + exhaustedNote,
			evidence: evidenceFor(group),
			confidence: confidenceFor(group.count, threshold),
			severity: "waste",
		});
	}

	return proposals;
}

/**
 * What the proposal quotes as evidence.
 *
 * Transcript-axis groups walk back to the exact messages; child-run groups have
 * no messages to point at — a spawn-level failure wrote none — so they state
 * the run count instead. Either way the number is counted, never estimated.
 */
function evidenceFor(group: FailureGroup): string {
	const byLabel = new Map<string, number>();
	for (const c of group.causes) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + c.count);
	const causeNote = [...byLabel.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([label, count]) => `${label} ×${count}`)
		.join("; ");
	return group.message_ids.length > 0
		? `${causeNote}; ${group.count} occurrence(s) across ${new Set(group.message_ids).size} message(s)`
		: `${causeNote}; ${group.count} child run(s) recorded in artifact metadata`;
}

/**
 * Confidence in the *finding*, not in the fix.
 *
 * It rises with how far the count cleared its threshold and stops at 0.9: a
 * deterministic count is strong evidence that something failed repeatedly, and
 * weak evidence that a particular package is the right answer.
 */
function confidenceFor(count: number, threshold: number): number {
	const over = Math.max(0, count - threshold);
	return Math.min(0.9, 0.6 + over * 0.05);
}

function lowerFirst(s: string): string {
	return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Count failures that the catalogue could not name — the measure of its gaps. */
export function unclassifiedCount(groups: FailureGroup[]): number {
	return groups.filter((g) => g.class_id === UNCLASSIFIED.classId).reduce((n, g) => n + g.count, 0);
}
