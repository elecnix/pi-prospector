/**
 * The metric-definition registry.
 *
 * Each analyzer declares its metrics in a `metrics.ts` beside its code, and this
 * module collects them the way `defaults.ts` collects analyzers. Importing it
 * pulls in only definitions (plain data), not the analyzers, so rendering the
 * reference loads no analysis code.
 *
 * An analyzer with no entry here has a visible gap: `METRICS_PENDING` lists them,
 * and a test fails when the list and the real gap disagree. The list may shrink
 * as families get their definitions. Adding an analyzer to it is a review
 * decision, and the test says the analyzer is undefined.
 */

import { Check } from "typebox/value";
import { CORE_METRICS } from "./core.js";
import { CORE_OWNER, MetricDefinition } from "./types.js";
import { metrics as activityWindows } from "../analyzers/activity-windows/metrics.js";
import { metrics as attentionGaps } from "../analyzers/attention-gaps/metrics.js";
import { metrics as delegationOutcomes } from "../analyzers/delegation-outcomes/metrics.js";
import { metrics as cacheEconomy } from "../analyzers/cache-economy/metrics.js";
import { metrics as contextEconomy } from "../analyzers/context-economy/metrics.js";
import { metrics as failureModes } from "../analyzers/failure-modes/metrics.js";
import { metrics as frictionAccumulation } from "../analyzers/friction-accumulation/metrics.js";
import { metrics as compressionChecklist } from "../analyzers/compression-checklist/metrics.js";
import { metrics as filesInPlay } from "../analyzers/files-in-play/metrics.js";
import { metrics as frustrationLexicon } from "../analyzers/frustration-lexicon/metrics.js";
import { metrics as gitCommands } from "../analyzers/git-commands/metrics.js";
import { metrics as groundedClaims } from "../analyzers/grounded-claims/metrics.js";
import { metrics as messageOrigin } from "../analyzers/message-origin/metrics.js";
import { metrics as repoIdentity } from "../analyzers/repo-identity/metrics.js";
import { metrics as routingOpportunity } from "../analyzers/routing-opportunity/metrics.js";
import { metrics as phaseTrajectory } from "../analyzers/phase-trajectory/metrics.js";
import { metrics as planCompliance } from "../analyzers/plan-compliance/metrics.js";
import { metrics as prOpened } from "../analyzers/pr-opened/metrics.js";
import { metrics as sessionEnding } from "../analyzers/session-ending/metrics.js";
import { metrics as similarityCluster } from "../analyzers/similarity-cluster/metrics.js";
import { metrics as skillUse } from "../analyzers/skill-use/metrics.js";
import { metrics as navigationEfficiency } from "../analyzers/navigation-efficiency/metrics.js";
import { metrics as reviveChains } from "../analyzers/revive-chains/metrics.js";
import { metrics as staleVerification } from "../analyzers/stale-verification/metrics.js";
import { metrics as taskToolMismatch } from "../analyzers/task-tool-mismatch/metrics.js";
import { metrics as timeEconomy } from "../analyzers/time-economy/metrics.js";
import { metrics as tokenUnits } from "../analyzers/token-units/metrics.js";
import { metrics as toolInventoryTax } from "../analyzers/tool-inventory-tax/metrics.js";
import { metrics as toolTrajectory } from "../analyzers/tool-trajectory/metrics.js";
import { metrics as turnFrustration } from "../analyzers/turn-frustration/metrics.js";
import { metrics as turnPairCore } from "../analyzers/turn-pair-core/metrics.js";
import { metrics as turnPairLlm } from "../analyzers/turn-pair-llm/metrics.js";
import { metrics as uncompletedLeads } from "../analyzers/uncompleted-leads/metrics.js";
import { metrics as verificationCommands } from "../analyzers/verification-commands/metrics.js";

/** Every owner's definitions: an analyzer id, or `sessions`. */
const SOURCES: ReadonlyArray<{ owner: string; metrics: MetricDefinition[] }> = [
	{ owner: CORE_OWNER, metrics: CORE_METRICS },
	{ owner: "activity-windows", metrics: activityWindows },
	{ owner: "attention-gaps", metrics: attentionGaps },
	{ owner: "delegation-outcomes", metrics: delegationOutcomes },
	{ owner: "cache-economy", metrics: cacheEconomy },
	{ owner: "context-economy", metrics: contextEconomy },
	{ owner: "failure-modes", metrics: failureModes },
	{ owner: "friction-accumulation", metrics: frictionAccumulation },
	{ owner: "compression-checklist", metrics: compressionChecklist },
	{ owner: "files-in-play", metrics: filesInPlay },
	{ owner: "frustration-lexicon", metrics: frustrationLexicon },
	{ owner: "git-commands", metrics: gitCommands },
	{ owner: "grounded-claims", metrics: groundedClaims },
	{ owner: "message-origin", metrics: messageOrigin },
	{ owner: "repo-identity", metrics: repoIdentity },
	{ owner: "routing-opportunity", metrics: routingOpportunity },
	{ owner: "phase-trajectory", metrics: phaseTrajectory },
	{ owner: "plan-compliance", metrics: planCompliance },
	{ owner: "pr-opened", metrics: prOpened },
	{ owner: "session-ending", metrics: sessionEnding },
	{ owner: "similarity-cluster", metrics: similarityCluster },
	{ owner: "skill-use", metrics: skillUse },
	{ owner: "navigation-efficiency", metrics: navigationEfficiency },
	{ owner: "revive-chains", metrics: reviveChains },
	{ owner: "stale-verification", metrics: staleVerification },
	{ owner: "task-tool-mismatch", metrics: taskToolMismatch },
	{ owner: "time-economy", metrics: timeEconomy },
	{ owner: "token-units", metrics: tokenUnits },
	{ owner: "tool-inventory-tax", metrics: toolInventoryTax },
	{ owner: "tool-trajectory", metrics: toolTrajectory },
	{ owner: "turn-frustration", metrics: turnFrustration },
	{ owner: "turn-pair-core", metrics: turnPairCore },
	{ owner: "turn-pair-llm", metrics: turnPairLlm },
	{ owner: "uncompleted-leads", metrics: uncompletedLeads },
	{ owner: "verification-commands", metrics: verificationCommands },
];

/**
 * Analyzers that have no metric definitions yet. Fill one family per pull
 * request and delete its ids here. `tests/unit/metrics-registry.test.ts` fails
 * when this list names an analyzer that has definitions, or omits one that has
 * none.
 */
export const METRICS_PENDING: readonly string[] = [
	"assistant-cognition",
	"dataprofiler",
	"decode-collapse",
	"detect-secrets",
	"gitleaks",
	"language-mismatch",
	"lexicon-candidates",
	"message-answers",
	"nosey-parker",
	"piicatcher",
	"presidio",
	"prompt-form",
	"repetition-collapse",
	"request-classes",
	"rule-restatement",
	"secret-leak",
	"secret-scanner",
	"session-overview",
	"trufflehog",
];

/** The definitions of one owner, or of all of them in registration order. */
export function listMetrics(owner?: string): MetricDefinition[] {
	return SOURCES.filter((s) => owner === undefined || s.owner === owner).flatMap((s) => s.metrics);
}

export function getMetric(id: string): MetricDefinition | undefined {
	return listMetrics().find((m) => m.id === id);
}

export function hasMetric(id: string): boolean {
	return getMetric(id) !== undefined;
}

/** Owners that have definitions, `sessions` included. */
export function definedOwners(): string[] {
	return SOURCES.filter((s) => s.metrics.length > 0).map((s) => s.owner);
}

/** Problems with the registered definitions: schema, id prefix and duplicates. Empty when sound. */
export function validateRegistry(): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const source of SOURCES) {
		for (const metric of source.metrics) {
			const id: string = metric.id;
			const valid: boolean = Check(MetricDefinition, metric);
			if (!valid) problems.push(`${id}: does not match the MetricDefinition schema`);
			if (!id.startsWith(`${source.owner}.`)) problems.push(`${id}: id does not start with its owner '${source.owner}.'`);
			if (seen.has(id)) problems.push(`${id}: defined twice`);
			seen.add(id);
		}
	}
	return problems;
}

/** Registered analyzer ids that have no definitions. */
export function analyzersWithoutMetrics(analyzerIds: readonly string[]): string[] {
	const defined = new Set(definedOwners());
	return analyzerIds.filter((id) => !defined.has(id)).sort();
}
