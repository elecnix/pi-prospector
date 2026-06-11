import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	canonicalJson,
	computeConfigHash,
	computeInputHash,
	computeModelBundleHash,
	computePromptBundleHash,
	computeSourceSetHash,
	fullHash,
	shortHash,
	uuidv7,
} from "../../src/analyze/input-hash.js";

describe("hashing", () => {
	it("shortHash is 16 hex chars, fullHash is 64", () => {
		assert.match(shortHash("x"), /^[0-9a-f]{16}$/);
		assert.match(fullHash("x"), /^[0-9a-f]{64}$/);
	});

	it("source set hash is order-independent", () => {
		const a = computeSourceSetHash([
			{ kind: "message", id: "m1" },
			{ kind: "message", id: "m2" },
		]);
		const b = computeSourceSetHash([
			{ kind: "message", id: "m2" },
			{ kind: "message", id: "m1" },
		]);
		assert.equal(a, b);
	});

	it("source set hash distinguishes different sets", () => {
		const a = computeSourceSetHash([{ kind: "message", id: "m1" }]);
		const b = computeSourceSetHash([{ kind: "message", id: "m2" }]);
		assert.notEqual(a, b);
	});

	it("prompt bundle hash is order-independent and stable for empty", () => {
		assert.equal(computePromptBundleHash(["a", "b"]), computePromptBundleHash(["b", "a"]));
		assert.equal(computePromptBundleHash([]), computePromptBundleHash([]));
	});

	it("model bundle hash is order-independent and stable for empty", () => {
		assert.equal(
			computeModelBundleHash(["anthropic/a", "openai/b"]),
			computeModelBundleHash(["openai/b", "anthropic/a"]),
		);
		assert.equal(computeModelBundleHash([]), computeModelBundleHash([]));
		assert.notEqual(computeModelBundleHash(["anthropic/a"]), computeModelBundleHash(["openai/b"]));
	});

	it("input hash changes when the analyzer version changes", () => {
		const base = {
			analyzerId: "x",
			configId: "c1",
			promptBundleHash: "p1",
			modelBundleHash: "m1",
			sourceSetHash: "s1",
		};
		const v1 = computeInputHash({ ...base, analyzerVersionId: "1.0.0" });
		const v2 = computeInputHash({ ...base, analyzerVersionId: "2.0.0" });
		assert.notEqual(v1, v2);
	});

	it("input hash changes when the resolved model changes", () => {
		const base = {
			analyzerId: "x",
			analyzerVersionId: "1",
			configId: "c",
			promptBundleHash: "p",
			sourceSetHash: "s",
		};
		assert.notEqual(
			computeInputHash({ ...base, modelBundleHash: computeModelBundleHash(["anthropic/haiku"]) }),
			computeInputHash({ ...base, modelBundleHash: computeModelBundleHash(["openai/gpt-5-mini"]) }),
		);
	});

	it("input hash changes when the source set changes", () => {
		const base = { analyzerId: "x", analyzerVersionId: "1", configId: "c", promptBundleHash: "p", modelBundleHash: "m" };
		assert.notEqual(
			computeInputHash({ ...base, sourceSetHash: "s1" }),
			computeInputHash({ ...base, sourceSetHash: "s2" }),
		);
	});

	it("canonicalJson sorts keys recursively", () => {
		assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
	});

	it("config hash is independent of key order", () => {
		assert.equal(computeConfigHash({ a: 1, b: 2 }), computeConfigHash({ b: 2, a: 1 }));
	});

	it("uuidv7 ids are unique and chronologically sortable", () => {
		const ids = Array.from({ length: 50 }, () => uuidv7());
		assert.equal(new Set(ids).size, ids.length);
		assert.match(ids[0]!, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
	});
});
