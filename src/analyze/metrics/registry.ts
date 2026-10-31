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
import { metrics as failureModes } from "../analyzers/failure-modes/metrics.js";
import { metrics as frustrationLexicon } from "../analyzers/frustration-lexicon/metrics.js";
import { metrics as messageOrigin } from "../analyzers/message-origin/metrics.js";
import { metrics as sessionEnding } from "../analyzers/session-ending/metrics.js";
import { metrics as timeEconomy } from "../analyzers/time-economy/metrics.js";
import { metrics as toolTrajectory } from "../analyzers/tool-trajectory/metrics.js";
import { metrics as turnFrustration } from "../analyzers/turn-frustration/metrics.js";
import { metrics as turnPairCore } from "../analyzers/turn-pair-core/metrics.js";
import { metrics as turnPairLlm } from "../analyzers/turn-pair-llm/metrics.js";

/** Every owner's definitions: an analyzer id, or `sessions`. */
const SOURCES: ReadonlyArray<{ owner: string; metrics: MetricDefinition[] }> = [
	{ owner: CORE_OWNER, metrics: CORE_METRICS },
	{ owner: "failure-modes", metrics: failureModes },
	{ owner: "frustration-lexicon", metrics: frustrationLexicon },
	{ owner: "message-origin", metrics: messageOrigin },
	{ owner: "session-ending", metrics: sessionEnding },
	{ owner: "time-economy", metrics: timeEconomy },
	{ owner: "tool-trajectory", metrics: toolTrajectory },
	{ owner: "turn-frustration", metrics: turnFrustration },
	{ owner: "turn-pair-core", metrics: turnPairCore },
	{ owner: "turn-pair-llm", metrics: turnPairLlm },
];

/**
 * Analyzers that have no metric definitions yet. Fill one family per pull
 * request and delete its ids here. `tests/unit/metrics-registry.test.ts` fails
 * when this list names an analyzer that has definitions, or omits one that has
 * none.
 */
export const METRICS_PENDING: readonly string[] = [
	"assistant-cognition",
	"cache-economy",
	"compression-checklist",
	"context-economy",
	"dataprofiler",
	"decode-collapse",
	"detect-secrets",
	"files-in-play",
	"friction-accumulation",
	"gitleaks",
	"grounded-claims",
	"language-mismatch",
	"lexicon-candidates",
	"navigation-efficiency",
	"nosey-parker",
	"phase-trajectory",
	"piicatcher",
	"plan-compliance",
	"pr-opened",
	"presidio",
	"repetition-collapse",
	"request-classes",
	"revive-chains",
	"routing-opportunity",
	"rule-restatement",
	"secret-leak",
	"secret-scanner",
	"session-overview",
	"similarity-cluster",
	"skill-use",
	"stale-verification",
	"task-tool-mismatch",
	"token-units",
	"tool-inventory-tax",
	"trufflehog",
	"uncompleted-leads",
	"verification-commands",
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
