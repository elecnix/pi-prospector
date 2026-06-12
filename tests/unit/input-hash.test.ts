import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	canonicalJson,
	computeConfigFingerprint,
	computeConfigHash,
	computeInputKey,
	computeOutputKey,
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

	it("config fingerprint is order-independent over models and stable for empty", () => {
		assert.equal(
			computeConfigFingerprint("c1", ["anthropic/a", "openai/b"]),
			computeConfigFingerprint("c1", ["openai/b", "anthropic/a"]),
		);
		assert.equal(computeConfigFingerprint("c1", []), computeConfigFingerprint("c1", []));
		assert.notEqual(computeConfigFingerprint("c1", []), computeConfigFingerprint("c2", []));
		assert.notEqual(
			computeConfigFingerprint("c1", ["anthropic/a"]),
			computeConfigFingerprint("c1", ["openai/b"]),
		);
	});

	it("input hash changes when the analyzer version changes", () => {
		const base = {
			analyzerId: "x",
			configFingerprint: "cf1",
			sourceSetHash: "s1",
		};
		const v1 = computeInputKey({ ...base, analyzerVersionId: "1.0" });
		const v2 = computeInputKey({ ...base, analyzerVersionId: "2.0" });
		assert.notEqual(v1, v2);
	});

	it("input hash changes when the resolved model changes (via the config fingerprint)", () => {
		const base = {
			analyzerId: "x",
			analyzerVersionId: "1.0",
			sourceSetHash: "s",
		};
		assert.notEqual(
			computeInputKey({ ...base, configFingerprint: computeConfigFingerprint("c", ["anthropic/haiku"]) }),
			computeInputKey({ ...base, configFingerprint: computeConfigFingerprint("c", ["openai/gpt-5-mini"]) }),
		);
	});

	it("input hash changes when the source set changes", () => {
		const base = { analyzerId: "x", analyzerVersionId: "1.0", configFingerprint: "cf" };
		assert.notEqual(
			computeInputKey({ ...base, sourceSetHash: "s1" }),
			computeInputKey({ ...base, sourceSetHash: "s2" }),
		);
	});

	it("output key is deterministic and folds in both input key and content", () => {
		const content = { a: 1, b: [2, 3] };
		// Deterministic: same (input_key, content) → same output_key, and key order in content is irrelevant.
		assert.equal(computeOutputKey("ik1", content), computeOutputKey("ik1", { b: [2, 3], a: 1 }));
		// Changes with content.
		assert.notEqual(computeOutputKey("ik1", content), computeOutputKey("ik1", { a: 2, b: [2, 3] }));
		// Changes with input key (same output text under a different recipe is a different node).
		assert.notEqual(computeOutputKey("ik1", content), computeOutputKey("ik2", content));
		assert.match(computeOutputKey("ik1", content), /^[0-9a-f]{16}$/);
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
