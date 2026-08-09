import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	mapWithConcurrency,
	createSemaphore,
	withTimeout,
	callWithRetry,
	classifyRetryable,
	DEFAULT_RETRY_POLICY,
	DEFAULT_LLM_CONCURRENCY,
	DEFAULT_DETERMINISTIC_CONCURRENCY,
	type RetryPolicy,
} from "../../src/analyze/concurrency.js";

const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("defaults are 10 (LLM) and 20 (deterministic)", () => {
	assert.equal(DEFAULT_LLM_CONCURRENCY, 10);
	assert.equal(DEFAULT_DETERMINISTIC_CONCURRENCY, 20);
});

test("mapWithConcurrency preserves input order regardless of completion order", async () => {
	const items = [50, 10, 30, 5, 40];
	const out = await mapWithConcurrency(items, 3, async (n, i) => {
		await tick(n);
		return `${i}:${n}`;
	});
	assert.deepEqual(out, ["0:50", "1:10", "2:30", "3:5", "4:40"]);
});

test("mapWithConcurrency processes every item exactly once", async () => {
	const items = Array.from({ length: 50 }, (_, i) => i);
	const seen = new Set<number>();
	await mapWithConcurrency(items, 7, async (n) => {
		assert.ok(!seen.has(n), `duplicate ${n}`);
		seen.add(n);
		await tick();
		return n;
	});
	assert.equal(seen.size, 50);
});

test("mapWithConcurrency never exceeds the limit", async () => {
	let active = 0;
	let peak = 0;
	await mapWithConcurrency(Array.from({ length: 30 }), 4, async () => {
		active++;
		peak = Math.max(peak, active);
		await tick(2);
		active--;
	});
	assert.ok(peak <= 4, `peak ${peak} exceeded 4`);
	assert.equal(peak, 4, "should reach the limit");
});

test("mapWithConcurrency clamps a too-large limit and handles empty input", async () => {
	assert.deepEqual(await mapWithConcurrency([], 10, async () => 1), []);
	const out = await mapWithConcurrency([1, 2], 100, async (n) => n * 2);
	assert.deepEqual(out, [2, 4]);
});

test("mapWithConcurrency propagates the first error", async () => {
	await assert.rejects(
		mapWithConcurrency([1, 2, 3], 2, async (n) => {
			if (n === 2) throw new Error("boom");
			await tick();
			return n;
		}),
		/boom/,
	);
});

test("createSemaphore never runs more than `limit` bodies at once", async () => {
	const gate = createSemaphore(3);
	let active = 0;
	let peak = 0;
	await Promise.all(
		Array.from({ length: 20 }, () =>
			gate(async () => {
				active++;
				peak = Math.max(peak, active);
				await tick(2);
				active--;
			}),
		),
	);
	assert.ok(peak <= 3, `peak ${peak} exceeded 3`);
	assert.equal(peak, 3);
});

test("createSemaphore releases its slot even when the body throws", async () => {
	const gate = createSemaphore(1);
	await assert.rejects(gate(async () => { throw new Error("x"); }), /x/);
	// If the slot leaked, this second call would hang forever.
	assert.equal(await gate(async () => 42), 42);
});

test("createSemaphore serializes with limit 1 (FIFO)", async () => {
	const gate = createSemaphore(1);
	const order: number[] = [];
	await Promise.all(
		[1, 2, 3].map((n) =>
			gate(async () => {
				order.push(n);
				await tick(2);
			}),
		),
	);
	assert.deepEqual(order, [1, 2, 3]);
});

describe("classifyRetryable", () => {
	const withStatus = (status: number): Error =>
		Object.assign(new Error(`http ${status}`), { status });

	it("treats 429 and 5xx as retryable, other 4xx as terminal", () => {
		for (const s of [408, 409, 429, 500, 502, 503, 504]) {
			assert.equal(classifyRetryable(withStatus(s)).retryable, true, `status ${s}`);
		}
		for (const s of [400, 401, 403, 404, 422]) {
			assert.equal(classifyRetryable(withStatus(s)).retryable, false, `status ${s}`);
		}
	});

	it("falls back to message text only for unmistakable transient signatures", () => {
		assert.equal(classifyRetryable(new Error("429 Too Many Requests")).retryable, true);
		assert.equal(classifyRetryable(new Error("rate limit exceeded")).retryable, true);
		assert.equal(classifyRetryable(new Error("ECONNRESET")).retryable, true);
		assert.equal(classifyRetryable(new Error("502 Bad Gateway")).retryable, true);
		assert.equal(classifyRetryable(new Error("Model not found in Pi registry")).retryable, false);
		assert.equal(classifyRetryable(new Error("No credentials for openrouter/x")).retryable, false);
	});

	it("surfaces a provider Retry-After delay", () => {
		const headers = new Headers({ "retry-after": "3" });
		const err = Object.assign(new Error("throttled"), { status: 429, headers });
		const d = classifyRetryable(err);
		assert.equal(d.retryable, true);
		assert.ok(d.retryAfterMs && Math.abs(d.retryAfterMs - 3000) < 50);
	});

	it("does not surface a delay on a terminal error", () => {
		const err = Object.assign(new Error("nope"), { status: 404 });
		assert.deepEqual(classifyRetryable(err), { retryable: false, retryAfterMs: undefined });
	});
});

describe("callWithRetry", () => {
	const base: Omit<RetryPolicy, "isRetryable"> = {
		maxAttempts: 5,
		baseDelayMs: 5,
		maxDelayMs: 50,
		maxTotalDelayMs: 100_000,
	};
	const policy = (o: Partial<RetryPolicy> = {}): RetryPolicy => ({
		...base,
		...o,
		isRetryable: o.isRetryable ?? classifyRetryable,
	});
	const retryable = Object.assign(new Error("throttled"), { status: 429 });
	const terminal = Object.assign(new Error("bad request"), { status: 400 });

	it("returns the result when the first attempt succeeds", async () => {
		const stats = { retries: 0 };
		const out = await callWithRetry(() => Promise.resolve(7), policy(), stats);
		assert.equal(out, 7);
		assert.equal(stats.retries, 0);
	});

	it("retries a retryable failure and succeeds, counting the retry", async () => {
		const stats = { retries: 0 };
		const calls: number[] = [];
		const out = await callWithRetry(
			() => {
				calls.push(1);
				return calls.length === 1 ? Promise.reject(retryable) : Promise.resolve("ok");
			},
			policy(),
			stats,
		);
		assert.equal(out, "ok");
		assert.equal(stats.retries, 1);
		assert.equal(calls.length, 2);
	});

	it("propagates a terminal failure immediately (no retry)", async () => {
		const stats = { retries: 0 };
		const calls: number[] = [];
		await assert.rejects(
			callWithRetry(
				() => {
					calls.push(1);
					return Promise.reject(terminal);
				},
				policy(),
				stats,
			),
			/bad request/,
		);
		assert.equal(stats.retries, 0);
		assert.equal(calls.length, 1);
	});

	it("gives up after exhausting the attempt budget", async () => {
		const stats = { retries: 0 };
		const p = policy({ maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 });
		await assert.rejects(() => callWithRetry(() => Promise.reject(retryable), p, stats), /throttled/);
		assert.equal(stats.retries, 2); // two retries before the (failed) third attempt
	});

	it("honours a provider Retry-After delay", async () => {
		const stats = { retries: 0 };
		const headers = new Headers({ "retry-after-ms": "300" });
		const ra = Object.assign(new Error("slow throttle"), { status: 429, headers });
		let done = false;
		const start = Date.now();
		await callWithRetry(
			() => {
				if (!done) {
					done = true;
					return Promise.reject(ra);
				}
				return Promise.resolve(1);
			},
			policy(),
			stats,
		);
		assert.equal(stats.retries, 1);
		assert.ok(Date.now() - start >= 250, "should wait out the Retry-After");
	});

	it("stops retrying when the total-delay budget would be exceeded", async () => {
		const stats = { retries: 0 };
		const p = policy({ maxAttempts: 5, baseDelayMs: 40, maxDelayMs: 40, maxTotalDelayMs: 50 });
		await assert.rejects(() => callWithRetry(() => Promise.reject(retryable), p, stats), /throttled/);
		// With a 50ms budget and a >=40ms first delay, it retries once then gives up
		// rather than spending past the budget.
		assert.ok(stats.retries <= 1, `retries ${stats.retries}`);
	});
});

describe("withTimeout", () => {
	it("returns the result when the promise settles first", async () => {
		assert.equal(await withTimeout(Promise.resolve(7), 500, () => new Error("timeout")), 7);
	});

	it("rejects with the timeout error when the promise never settles", async () => {
		const never = new Promise<never>(() => {}); // never resolves nor rejects
		await assert.rejects(() => withTimeout(never, 20, () => new Error("stalled call")), /stalled call/);
	});

	it("does not throw a spurious timeout when the promise rejects first", async () => {
		const slow = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("real boom")), 5));
		await assert.rejects(() => withTimeout(slow, 500, () => new Error("timeout")), /real boom/);
	});

	it("releases the caller promptly even for a hung promise (terminal state)", async () => {
		const start = Date.now();
		const never = new Promise<never>(() => {});
		await assert.rejects(() => withTimeout(never, 15, () => new Error("hang")), /hang/);
		assert.ok(Date.now() - start < 500, "should not wait out the hung promise's full lifetime");
	});
});
