/**
 * Whole-run accounting for an analyze invocation.
 *
 * A partial overlay must be legible, not invisible: if a run over N sessions
 * finishes with some sessions failed, downstream needs to know it was a partial
 * run — not a corpus that "genuinely had little to say". This module folds every
 * per-session outcome into a single run-wide tally that is both persisted (the
 * run record) and reported to the console. It is kept pure and dependency-free so
 * the loop's bookkeeping is unit-testable and cannot silently drop a failure.
 */

/** Cap on distinct error strings retained in a run's record/report. */
export const MAX_ERROR_EXAMPLES = 20;

/** The outcome of analysing one session. */
export interface SessionRunOutcome {
	/**
	 * True when the session's run returned with zero unit errors. A session whose
	 * overlay partially failed (or threw) is `ok: false`.
	 */
	ok: boolean;
	nodesProduced: number;
	nodesRevised: number;
	proposalsCreated: number;
	costUsd: number;
	tokensUsed: number;
	/** Per-unit/session errors, in insertion order (empty when `ok`). */
	errors: string[];
}

/** Aggregate tally for one analyze invocation. */
export interface RunAccounting {
	/** Sessions the run set out to analyse. */
	attempted: number;
	/** Sessions that finished with no failures at all. */
	completed: number;
	/** Sessions that had at least one failure (partial or thrown). */
	failed: number;
	/** Total number of error messages across all failed sessions. */
	errorCount: number;
	/** Up to {@link MAX_ERROR_EXAMPLES} representative error strings. */
	errorExamples: string[];
	nodesProduced: number;
	nodesRevised: number;
	proposalsCreated: number;
	costUsd: number;
	tokensUsed: number;
}

export function emptyAccounting(): RunAccounting {
	return {
		attempted: 0,
		completed: 0,
		failed: 0,
		errorCount: 0,
		errorExamples: [],
		nodesProduced: 0,
		nodesRevised: 0,
		proposalsCreated: 0,
		costUsd: 0,
		tokensUsed: 0,
	};
}

/** Fold one session's outcome into the run tally. */
export function accountOne(acc: RunAccounting, outcome: SessionRunOutcome): RunAccounting {
	return {
		...acc,
		attempted: acc.attempted + 1,
		completed: acc.completed + (outcome.ok ? 1 : 0),
		failed: acc.failed + (outcome.ok ? 0 : 1),
		errorCount: acc.errorCount + (outcome.ok ? 0 : outcome.errors.length),
		errorExamples: pushExamples(acc.errorExamples, outcome.ok ? [] : outcome.errors),
		nodesProduced: acc.nodesProduced + outcome.nodesProduced,
		nodesRevised: acc.nodesRevised + outcome.nodesRevised,
		proposalsCreated: acc.proposalsCreated + outcome.proposalsCreated,
		costUsd: acc.costUsd + outcome.costUsd,
		tokensUsed: acc.tokensUsed + outcome.tokensUsed,
	};
}

/** Fold many session outcomes into the run tally. */
export function accountResults(acc: RunAccounting, outcomes: SessionRunOutcome[]): RunAccounting {
	return outcomes.reduce(accountOne, acc);
}

/** Whether the run reached a clean terminal state (zero failed sessions). */
export function runStatus(acc: RunAccounting): "ok" | "partial" {
	return acc.failed === 0 ? "ok" : "partial";
}

function pushExamples(existing: string[], newErrors: string[]): string[] {
	if (existing.length >= MAX_ERROR_EXAMPLES) return existing;
	const out = existing.slice();
	for (const e of newErrors) {
		if (out.length >= MAX_ERROR_EXAMPLES) break;
		out.push(e);
	}
	return out;
}
