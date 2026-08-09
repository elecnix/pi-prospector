/**
 * Bounded concurrency primitives for the analysis run.
 *
 * The analysis pipeline is dominated by sequential, network-bound LLM calls;
 * running independent sessions concurrently is what turns a multi-hour corpus
 * run into a parallel one. Two limits, both hard-coded defaults but overridable
 * per run from the CLI:
 *
 *   - LLM concurrency (default 10): the maximum number of in-flight LLM calls.
 *     Enforced by a global semaphore wrapped around the LLM caller, so the cap
 *     holds no matter how work is dispatched above it.
 *   - Deterministic concurrency (default 20): the fan-out for runs that touch no
 *     LLM analyzer (e.g. a turn-pair-core-only pass), where there is no provider
 *     to protect and the only ceiling is local bookkeeping.
 */

/** Maximum concurrent LLM calls, and the session fan-out for LLM-bearing runs. */
export const DEFAULT_LLM_CONCURRENCY = 10;

/** Session fan-out for runs that involve no LLM analyzer. */
export const DEFAULT_DETERMINISTIC_CONCURRENCY = 20;

/**
 * Bound a promise to `ms` milliseconds of wall-clock time. If `promise` has not
 * settled by then, reject with `onTimeout()` so the caller can turn a stalled
 * dependency — a provider call that neither resolves nor rejects — into a real
 * terminal error instead of hanging forever.
 *
 * The winner invalidates the loser: a settled promise clears the timer, and a
 * fired timer rejects only once. This is the load-bearing piece of the analyzer's
 * terminal-state contract: a hung LLM call otherwise holds a semaphore slot
 * forever, which is how an overlay could stall part-way through a run and leave a
 * partial result indistinguishable from a complete one.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	onTimeout: () => Error,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(onTimeout()), ms);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Verdict on one failed attempt: retry it or treat it as terminal. */
export interface RetryDecision {
	/** True when the failure is transient and worth retrying. */
	retryable: boolean;
	/** Provider-requested delay in ms (from Retry-After), if any. */
	retryAfterMs?: number;
}

/** Bounds for one retry policy — attempts and total added wall-clock. */
export interface RetryPolicy {
	/** Total attempts, including the first. Clamped to >= 1. */
	maxAttempts: number;
	/** Exponential backoff base for the first retry delay (ms). */
	baseDelayMs: number;
	/** Upper bound on a single backoff delay, before jitter (ms). */
	maxDelayMs: number;
	/** Cap on total wall-clock added by retry sleeps (ms). */
	maxTotalDelayMs: number;
	/** Classify a failure as retryable or terminal. */
	isRetryable: (err: unknown) => RetryDecision;
}

/** Live counters a caller feeds batches into and reads back once at the end. */
export interface RetryStats {
	/** Number of retries performed so far (backoff sleeps entered). */
	retries: number;
}

/**
 * Default retry budget for the LLM call path. Bounded in both attempts and total
 * added wall-clock so a rate-limited run *degrades in duration* rather than
 * hanging — the prior defect in this exact path was an unbounded call deadlocking
 * the whole overlay, so the fix must not reintroduce an unbounded wait while
 * fixing an unbounded failure. 8 attempts / ~5 min of added backoff is generous
 * enough to ride out a transient shared-pool throttle, but a call that still
 * fails afterwards is terminal and frees its slot so the run can continue.
 */
export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, "isRetryable"> = {
	maxAttempts: 8,
	baseDelayMs: 1000,
	maxDelayMs: 60_000,
	maxTotalDelayMs: 300_000,
};

/**
 * Retry `fn` on retryable failures with exponential backoff and jitter,
 * honouring a provider-requested delay. Bounded in both the number of attempts
 * and the total wall-clock added by backoff sleeps.
 *
 * - A **retryable** failure (rate limit, 5xx) backs off and tries again.
 * - A **terminal** failure propagates immediately.
 * - A retryable failure that would blow the delay budget propagates too, so a
 *   call that is still throttled after the budget is spent fails its session
 *   fast and lets the rest of the run continue.
 *
 * `stats` (when given) accumulates the retry count for run-level reporting;
 * `report` (when given) is called with each backoff so a caller can surface
 * throttling without awaiting the final result.
 */
export async function callWithRetry<T>(
	fn: () => Promise<T>,
	policy: RetryPolicy,
	stats?: RetryStats,
	report?: (info: { attempt: number; delayMs: number; error: unknown }) => void,
): Promise<T> {
	const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts) || 1);
	let totalDelayMs = 0;
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (err) {
			const decision = attempt >= maxAttempts ? { retryable: false as const } : policy.isRetryable(err);
			if (!decision.retryable) throw err;

			// Honour the provider's Retry-After directly (it is authoritative for how
			// long to wait); the total-delay budget below is what keeps the run bounded
			// rather than a single-delay cap silently shortening an explicit wait.
			let delayMs: number;
			if (decision.retryAfterMs && decision.retryAfterMs > 0) {
				delayMs = decision.retryAfterMs;
			} else {
				const exp = Math.min(policy.baseDelayMs * 2 ** (attempt - 1), policy.maxDelayMs);
				delayMs = exp * (1 - 0.25 + Math.random() * 0.5); // ±25% jitter
			}

			// Budget spent → give up now. The caller sees the current failure, not a
			// hung run; this is what keeps a rate-limited run degrading in duration
			// instead of never returning.
			if (totalDelayMs + delayMs > policy.maxTotalDelayMs) throw err;
			totalDelayMs += delayMs;
			if (stats) stats.retries++;
			report?.({ attempt, delayMs, error: err });
			await sleep(delayMs);
		}
	}
}

/**
 * Classify a thrown failure as retryable or terminal. Mirrors the pinned
 * OpenAI/Anthropic SDK policy: 408/409/429 and any 5xx are transient; every other
 * 4xx is terminal. When a provider error carries a `Retry-After`, that delay is
 * surfaced so the retry can honour it.
 *
 * Errors thrown by the provider layer carry an HTTP `status` (and `headers`) once
 * the broker's own internal retries are spent, so classification is exact for the
 * common case. A failure with no status falls back to its message text, but only
 * for unmistakable transient signatures (rate-limit / connection-reset wording) —
 * never swallowing what could be a genuine configuration or business error.
 */
export function classifyRetryable(err: unknown): RetryDecision {
	const status = providerStatus(err);
	if (typeof status === "number") {
		const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
		return { retryable, retryAfterMs: retryable ? retryAfterMs(err) : undefined };
	}
	const msg = err instanceof Error ? err.message : String(err);
	const retryable =
		/\b429\b|rate limit|too many requests|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ESOCKETTIMEDOUT|socket hang up|\b50[1234]\b/.test(
			msg,
		);
	return { retryable, retryAfterMs: retryable ? retryAfterMs(err) : undefined };
}

/** The numeric HTTP status of a provider error, if it carries one. */
function providerStatus(err: unknown): number | undefined {
	const s = (err as { status?: unknown } | null)?.status;
	return typeof s === "number" && Number.isFinite(s) ? s : undefined;
}

/** The provider-requested retry delay in ms (Retry-After), if the error carries one. */
function retryAfterMs(err: unknown): number | undefined {
	const headers = (err as { headers?: unknown } | null)?.headers;
	if (!(headers instanceof Headers)) return undefined;
	const ms = headers.get("retry-after-ms");
	if (ms) {
		const v = Number.parseFloat(ms);
		if (Number.isFinite(v) && v > 0) return v;
	}
	const seconds = headers.get("retry-after");
	if (seconds) {
		const n = Number.parseFloat(seconds);
		if (Number.isFinite(n) && n >= 0) return n * 1000;
		const when = Date.parse(seconds);
		if (Number.isFinite(when)) return Math.max(0, when - Date.now());
	}
	return undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map `fn` over `items` with at most `limit` invocations in flight at once.
 * Results are returned in input order regardless of completion order, so
 * callers that assign ordinals by index stay deterministic. `limit` is clamped
 * to at least 1.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const n = items.length;
	const results = new Array<R>(n) as R[];
	if (n === 0) return results;
	const max = Math.max(1, Math.min(Math.floor(limit) || 1, n));

	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= n) return;
			results[i] = await fn(items[i] as T, i);
		}
	};

	const workers: Promise<void>[] = [];
	for (let w = 0; w < max; w++) workers.push(worker());
	await Promise.all(workers);
	return results;
}

/** A guarded async section: never more than `limit` bodies run concurrently. */
export type Gate = <R>(fn: () => Promise<R>) => Promise<R>;

/**
 * A counting semaphore. `gate(fn)` waits until a slot is free, runs `fn`, and
 * releases the slot (even if `fn` throws). FIFO so no caller is starved.
 */
export function createSemaphore(limit: number): Gate {
	const max = Math.max(1, Math.floor(limit) || 1);
	let active = 0;
	const waiters: Array<() => void> = [];

	const acquire = (): Promise<void> => {
		if (active < max) {
			active++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			waiters.push(() => {
				active++;
				resolve();
			});
		});
	};

	const release = (): void => {
		active--;
		const wake = waiters.shift();
		if (wake) wake();
	};

	return async <R>(fn: () => Promise<R>): Promise<R> => {
		await acquire();
		try {
			return await fn();
		} finally {
			release();
		}
	};
}
