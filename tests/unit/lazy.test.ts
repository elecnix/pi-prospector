import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadOnce } from "../../src/lazy.js";

describe("loadOnce", () => {
	it("does not load until first use", async () => {
		let loads = 0;
		const get = loadOnce(async () => {
			loads++;
			return { value: "loaded" };
		});

		assert.equal(loads, 0, "building the loader must not load anything");
		assert.deepEqual(await get(), { value: "loaded" });
		assert.equal(loads, 1);
	});

	it("loads once across repeated calls", async () => {
		let loads = 0;
		const get = loadOnce(async () => {
			loads++;
			return loads;
		});

		assert.equal(await get(), 1);
		assert.equal(await get(), 1);
		assert.equal(await get(), 1);
		assert.equal(loads, 1);
	});

	it("shares one in-flight load between concurrent callers", async () => {
		let loads = 0;
		const get = loadOnce(async () => {
			loads++;
			await new Promise((resolve) => setTimeout(resolve, 1));
			return loads;
		});

		const results = await Promise.all([get(), get(), get()]);
		assert.deepEqual(results, [1, 1, 1]);
		assert.equal(loads, 1);
	});

	it("retries after a failed load instead of caching the failure", async () => {
		let loads = 0;
		const get = loadOnce(async () => {
			loads++;
			if (loads === 1) throw new Error("first load failed");
			return "second load";
		});

		await assert.rejects(get(), /first load failed/);
		assert.equal(await get(), "second load", "a failed load must not poison the command for the rest of the session");
		assert.equal(loads, 2);
	});
});
