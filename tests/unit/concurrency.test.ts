import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mapWithConcurrency,
	createSemaphore,
	DEFAULT_LLM_CONCURRENCY,
	DEFAULT_DETERMINISTIC_CONCURRENCY,
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
