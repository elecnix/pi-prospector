/**
 * failure-modes — what went wrong, of every kind the system can name.
 *
 * The index could already see one kind of problem: a tool ran and returned an
 * error. It could not see the larger one. When a generation fails outright — the
 * provider refuses it, the connection drops mid-stream, the model emits a tool
 * call the host cannot parse — no tool is ever reached, so nothing in the
 * trajectory records it, and the turn reads as an ordinary short reply. On a
 * real corpus those failures outnumber tool errors, and every one of them was
 * billed. They were invisible because sync discarded the two fields that name
 * them; it now keeps them, and this analyzer reads them.
 *
 * Both axes are handled here, deliberately, because they are the same question
 * asked twice — *what failed, how often, and what would stop it* — and the
 * answer has one shape: a class from the curated catalogue, a count, a price,
 * and a remedy. Splitting them across two analyzers would duplicate the
 * catalogue and let the two halves drift. The child-run axis (subagent artifact
 * metadata) is here for the same reason: a spawn-level child failure leaves no
 * transcript at all, and its classification belongs to the same catalogue.
 *
 * Deterministic: no LLM, no network, no guessing. Every figure is counted from
 * the transcript, unrecorded costs stay unrecorded rather than becoming zero,
 * and the raw error text is never copied into the graph — only the curated
 * label that matched it, plus a digest that keeps distinct errors countable.
 *
 * Where it recommends an extension, the package comes from the hand-verified
 * catalogue in `classes.ts` and is checked against what is already installed.
 * It never installs anything.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { buildToolStream } from "../../tool-stream.js";
import { getSubagentRunsForSession } from "../../../db/queries.js";
import { DEFAULT_FAILURE_MODES_CONFIG, type FailureModesConfig } from "./config.js";
import { curatedPackages } from "./classes.js";
import { readInstalledPackages, type InstalledPackages } from "./installed.js";
import {
	buildProposals,
	compareGroups,
	groupChildRunFailures,
	groupFailures,
	normalizeForFingerprint,
	unclassifiedCount,
	type FailureGroup,
	type RawProposal,
} from "./detect.js";

export const FAILURE_MODES_DEF: AnalyzerDef = {
	id: "failure-modes",
	label: "Failure Modes (deterministic)",
	description:
		"Classifies every recorded failure in a session — failed generations (rate limits, transport drops, malformed tool calls, context ceilings, auth), failed tool calls, and failed child-agent runs read from subagent artifact metadata — against a curated catalogue, prices them, and proposes the remedy, including hand-verified extensions that address the class. Never installs anything. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
};

export const FAILURE_MODES_VERSION: AnalyzerVersion = {
	analyzerId: FAILURE_MODES_DEF.id,
	// 1.0: turn failures (from the stop_reason/error_message columns sync now
	// keeps) and tool failures, both classified against the curated catalogue,
	// priced from recorded billed cost, and proposed on above a threshold.
	// 1.1: child-run failures, classified from subagent artifact metadata — the
	// only record a spawn-level child failure leaves — with a remedy-kind axis
	// that keeps environment classes away from extension proposals.
	major: 1,
	minor: 1,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/failure-modes/index.ts",
};

export interface FailureModesProperties {
	session_id: string;
	/** Every failure, grouped by class (and by tool on the tool axis). */
	groups: FailureGroup[];
	/** Failed generations. */
	turn_failure_count: number;
	/** Failed tool calls. */
	tool_failure_count: number;
	/** Failed child runs, counted from artifact metadata. */
	child_run_failure_count: number;
	/** Every child run visible for this session's project — the coverage figure the failure count reads against. */
	child_run_count: number;
	/** Denominator for the turn-failure rate. */
	assistant_turn_count: number;
	/** Denominator for the tool-failure rate. */
	tool_call_count: number;
	/** Failures the catalogue could not name — the honest measure of its gaps. */
	unclassified_failure_count: number;
	/** Summed billed cost of the *priced* failures, or null when none was priced. */
	failure_cost_usd: number | null;
	priced_failure_count: number;
	unpriced_failure_count: number;
	/**
	 * Whether this session's rows carry the host's stop reason at all.
	 *
	 * False means they were indexed before sync kept it, so a turn-failure count
	 * of zero means "not known", not "none happened". Stating it is the
	 * difference between a clean session and an unread one.
	 */
	turn_failure_capture: "present" | "absent";
	/** Whether the installed-package list could be read, for the already-installed check. */
	installed_check: "performed" | "unavailable";
	improvement_proposals: RawProposal[];
}

/** Config plus the resolved install state — everything the run needs beyond the messages. */
function resolveConfig(raw: unknown): FailureModesConfig {
	return (raw as FailureModesConfig) ?? DEFAULT_FAILURE_MODES_CONFIG;
}

export const failureModesAnalyzer: Analyzer = {
	def: FAILURE_MODES_DEF,
	version: FAILURE_MODES_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: FAILURE_MODES_DEF.id,
		configHash: computeConfigHash(DEFAULT_FAILURE_MODES_CONFIG),
		configJson: DEFAULT_FAILURE_MODES_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	/**
	 * The installed-package set is part of this analyzer's config identity.
	 *
	 * Installing one of the recommended extensions changes what the right
	 * recommendation is, so a conclusion drawn before the install should read as
	 * stale for the `config` reason rather than standing unchallenged. Only the
	 * curated packages are folded in — the operator's unrelated installs are none
	 * of this analyzer's business, and folding them in would churn every node
	 * whenever anything at all was installed.
	 */
	identityExtras(): readonly string[] {
		const installed = readInstalledPackages();
		if (!installed.known) return ["installed:unknown"];
		const relevant = curatedPackages().filter((pkg) => installed.names.has(pkg));
		return [`installed:${shortHash(relevant.join(","))}`];
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		// Child runs are ingested beside the sessions they belong to; a session of a
		// project with failed child runs is worth a node even if its own transcript
		// is empty, because the artifacts are its corpus's evidence.
		const childRuns = await getSubagentRunsForSession(ctx.db, ctx.sessionId);
		if (ctx.messages.length === 0 && childRuns.length === 0) return [];

		const stream = buildToolStream(ctx.messages);

		// Identity folds in *what failed*, not merely which messages exist.
		//
		// A re-sync that fills in error text for messages already indexed leaves
		// every message id unchanged, so a source set of ids alone would classify
		// the unit `current` and quietly keep serving a conclusion drawn from data
		// that was not there yet. Hashing the failure-bearing content makes the
		// unit re-identify as missing and recompute, which is what actually
		// happened: the inputs changed.
		const failureFingerprint = shortHash(
			[
				...stream.turnFailures.map((f) => `t:${f.messageId}:${f.stopReason ?? ""}:${normalizeForFingerprint(f.errorText)}`),
				...stream.invocations
					.filter((i) => i.outcome?.isError)
					.map((i) => `x:${i.messageId}:${i.name}:${normalizeForFingerprint(i.outcome?.errorText ?? "")}`),
				...childRuns.map((r) => `c:${r.run_id}:${r.exit_code ?? ""}:${normalizeForFingerprint(r.error ?? "")}:${r.model_attempts ?? ""}`),
				`n:${stream.coverage.assistantTurnCount}:${stream.coverage.toolCallCount}:${stream.coverage.stopReasonRecorded}:${childRuns.length}`,
			].join("\n"),
		);

		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#failures=${failureFingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`failure-modes(${ctx.sessionId}|${failureFingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const stream = buildToolStream(messages);
		const childRuns = await ctx.getSubagentRuns(ctx.sessionId);
		const groups = [...groupFailures(stream), ...groupChildRunFailures(childRuns)].sort(compareGroups);

		// `recommendExtensions: false` is expressed by making every curated package
		// look already-present, so the proposal falls through to the non-package
		// remedy instead of being dropped. The finding is the operator's; only the
		// shopping list is optional.
		const installed: InstalledPackages = config.recommendExtensions
			? readInstalledPackages()
			: { names: new Set(curatedPackages()), known: true };

		const proposals = buildProposals({
			sessionId: ctx.sessionId,
			groups,
			assistantTurnCount: stream.coverage.assistantTurnCount,
			toolCallCount: stream.coverage.toolCallCount,
			installed,
			config,
		});

		let pricedCount = 0;
		let unpricedCount = 0;
		let costSum = 0;
		let turnFailures = 0;
		let toolFailures = 0;
		let childFailures = 0;
		for (const g of groups) {
			pricedCount += g.priced_count;
			unpricedCount += g.unpriced_count;
			if (typeof g.cost_usd === "number") costSum += g.cost_usd;
			if (g.axis === "turn") turnFailures += g.count;
			else if (g.axis === "tool") toolFailures += g.count;
			else childFailures += g.count;
		}

		const properties: FailureModesProperties = {
			session_id: ctx.sessionId,
			groups,
			turn_failure_count: turnFailures,
			tool_failure_count: toolFailures,
			child_run_failure_count: childFailures,
			child_run_count: childRuns.length,
			assistant_turn_count: stream.coverage.assistantTurnCount,
			tool_call_count: stream.coverage.toolCallCount,
			unclassified_failure_count: unclassifiedCount(groups),
			// Money is never invented: with nothing priced the total is null, not 0.
			failure_cost_usd: pricedCount > 0 ? costSum : null,
			priced_failure_count: pricedCount,
			unpriced_failure_count: unpricedCount,
			turn_failure_capture: stream.coverage.stopReasonRecorded ? "present" : "absent",
			installed_check: config.recommendExtensions
				? readInstalledPackages().known
					? "performed"
					: "unavailable"
				: "performed",
			improvement_proposals: proposals,
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor to each failing message so a finding can be walked back to the
		// exact turn that produced it — the trail `prospect show` follows.
		let ordinal = 1;
		const anchored = new Set<string>();
		for (const g of groups) {
			for (const id of g.message_ids) {
				if (anchored.has(id)) continue;
				anchored.add(id);
				edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: id, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
			}
		}

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
