import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { createMockLLM, createThrowingLLM } from "../../src/analyze/mock-llm.js";

const TOOL = {
	name: "submit_test_result",
	description: "Submit a synthetic structured test result.",
	parameters: Type.Object({ ok: Type.Boolean() }),
};

describe("createMockLLM", () => {
	it("returns scripted responses in order and records calls", async () => {
		const mock = createMockLLM({ scripted: ["one", "two"] });
		const r1 = await mock.caller({ model: "cheap", user: "a" });
		const r2 = await mock.caller({ model: "mid", user: "b" });
		assert.equal(r1.text, "one");
		assert.equal(r2.text, "two");
		assert.equal(mock.calls.length, 2);
		assert.equal(mock.calls[0]!.user, "a");
		assert.equal(mock.calls[1]!.model, "mid");
	});

	it("uses a responder function", async () => {
		const mock = createMockLLM({ responder: (req, i) => `${req.model}:${i}` });
		assert.equal((await mock.caller({ model: "x", user: "" })).text, "x:0");
		assert.equal((await mock.caller({ model: "y", user: "" })).text, "y:1");
	});

	it("falls back when scripted runs out", async () => {
		const mock = createMockLLM({ scripted: [], fallback: "fb" });
		assert.equal((await mock.caller({ model: "m", user: "" })).text, "fb");
	});

	it("reports simulated cost and tokens", async () => {
		const mock = createMockLLM({ fallback: "{}", costPerCall: 0.01, tokensPerCall: 42 });
		const r = await mock.caller({ model: "m", user: "" });
		assert.equal(r.costUsd, 0.01);
		assert.equal(r.tokensUsed, 42);
		assert.equal(r.stopReason, "stop");
	});

	it("returns structured scripted replies for tool requests", async () => {
		const mock = createMockLLM({ scripted: [{ structured: { ok: true } }] });
		const r = await mock.caller({ model: "m", user: "", tool: TOOL });
		assert.equal(r.text, "");
		assert.deepEqual(r.structured, { ok: true });
	});

	it("returns text and structured data from object responder replies", async () => {
		const mock = createMockLLM({ responder: () => ({ text: "fallback text", structured: { ok: true } }) });
		const r = await mock.caller({ model: "m", user: "", tool: TOOL });
		assert.equal(r.text, "fallback text");
		assert.deepEqual(r.structured, { ok: true });
	});

	it("only exposes structured mock replies when the request offered a tool", async () => {
		const mock = createMockLLM({ fallback: { text: "{}", structured: { ok: true } } });
		const r = await mock.caller({ model: "m", user: "" });
		assert.equal(r.text, "{}");
		assert.equal(r.structured, undefined);
	});

	it("defaults to empty text", async () => {
		const mock = createMockLLM();
		assert.equal((await mock.caller({ model: "m", user: "" })).text, "");
	});
});

describe("createThrowingLLM", () => {
	it("throws when invoked", async () => {
		const llm = createThrowingLLM("nope");
		await assert.rejects(() => llm({ model: "m", user: "" }), /nope/);
	});
});
