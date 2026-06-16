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
