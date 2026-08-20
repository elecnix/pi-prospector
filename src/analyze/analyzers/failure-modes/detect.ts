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
import {
	classifyFailure,
	failureClass,
	UNCLASSIFIED,
	type FailureAxis,
} from "./classes.js";
import type { FailureModesConfig } from "./config.js";
import type { InstalledPackages } from "./installed.js";

/** One recognised cause within a class, counted. */
export interface FailureCause {
	/** The curated matcher label. Never text taken from the error. */
	label: string;
	/**
	 * A short digest of the raw error text, so distinct underlying errors within
	 * one cause stay countable without any of them being readable. Recovering the
	 * text means opening the session — which is the point.
	 */
	fingerprint: string;
	count: number;
}

/** All failures of one class (and, on the tool axis, one tool), aggregated. */
export interface FailureGroup {
	axis: FailureAxis;
	class_id: string;
	/** The tool involved, for tool-axis groups; "" on the turn axis. */
	tool: string;
	count: number;
	/** The messages that failed, so the finding can be walked back to the turns. */
	message_ids: string[];
	causes: FailureCause[];
	/** Summed billed cost of the *priced* failures, or null when none was priced. */
	cost_usd: number | null;
	priced_count: number;
	unpriced_count: number;
}

export interface RawProposal {
	target_type: string;
	target_path?: string;
	title: string;
	summary: string;
	detail: string;
	evidence: string;
	confidence: number;
	severity: string;
}

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
	return [...groups.values()].sort((a, b) =>
		a.axis !== b.axis
			? a.axis.localeCompare(b.axis)
			: a.class_id !== b.class_id
				? a.class_id.localeCompare(b.class_id)
				: a.tool.localeCompare(b.tool),
	);
}

/** The command a tool call ran, when it has one. Non-shell tools have none. */
function commandOf(args: Record<string, unknown>): string {
	const raw = args["command"];
	return typeof raw === "string" ? raw : "";
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
 * the output. When the class has verified extensions and none of them is
 * already installed, the proposal targets an `extension`; otherwise it targets
 * the ordinary remedy, because a class whose fix is "top up the account" should
 * not be dressed up as a package recommendation.
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

		const denominator = group.axis === "turn" ? input.assistantTurnCount : input.toolCallCount;
		const rate = denominator > 0 ? group.count / denominator : null;
		const subject = group.axis === "turn" ? "turns" : `${group.tool} calls`;

		const costNote =
			group.priced_count > 0
				? ` ${group.priced_count}/${group.count} priced occurrences sum to $${group.cost_usd!.toFixed(4)} (lower bound).`
				: " None of these occurrences carried a recorded cost, so the money lost is unknown.";
		const rateNote = rate === null ? "" : ` That is ${(rate * 100).toFixed(1)}% of the session's ${denominator} ${group.axis === "turn" ? "assistant turns" : "tool calls"}.`;
		// Merge causes by label for the reader. The node keeps one entry per
		// distinct error (label + fingerprint), which is what makes "the same
		// failure, forty times" distinguishable from "forty different failures" —
		// but a fingerprint means nothing to a person, and listing it repeated
		// reads as "a search that found nothing ×1; a search that found nothing ×1".
		const byLabel = new Map<string, number>();
		for (const c of group.causes) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + c.count);
		const causeNote = [...byLabel.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([label, count]) => `${label} ×${count}`)
			.join("; ");

		const candidates = cls.extensions.filter((e) => !input.installed.names.has(e.pkg));
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
				evidence: `${causeNote}; ${group.count} occurrence(s) across ${new Set(group.message_ids).size} message(s)`,
				confidence: confidenceFor(group.count, threshold),
				severity: "waste",
			});
			continue;
		}

		// No package to recommend — either the class has none, or every candidate
		// is already installed. Both mean the same thing for the reader: here is
		// the finding and the fix that does not involve installing anything.
		const exhaustedNote = cls.extensions.length > 0
			? ` Every extension this system knows of for this class is already installed (${alreadyInstalled.map((e) => e.pkg).join(", ")}), so the remaining fix is not a package.`
			: "";

		proposals.push({
			target_type: group.axis === "turn" ? "config" : "agents_md",
			title: `${cls.label}: ${group.count} ${subject}`,
			summary: `${group.count} ${subject} in this session ended in ${cls.label}.${rateNote}${costNote}`,
			detail: cls.remedy + exhaustedNote,
			evidence: `${causeNote}; ${group.count} occurrence(s) across ${new Set(group.message_ids).size} message(s)`,
			confidence: confidenceFor(group.count, threshold),
			severity: "waste",
		});
	}

	return proposals;
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
