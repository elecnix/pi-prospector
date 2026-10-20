import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeDecisionCaller, scoreLevel, DecisionModelError, type DecisionRequest } from "../../src/analyze/decision-model.js";

const REQUEST: DecisionRequest = {
	model: "jev/jev-1.13.0",
	state: { text: "hello" },
	questions: { greeting: { type: "noul", instructions: "Is `text` a greeting?" } },
};

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }> = []): typeof fetch {
	return (async (url: string, init: RequestInit) => {
		seen.push({ url, init });
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
}

describe("makeDecisionCaller", () => {
	it("posts to the provider's System One endpoint and prices input tokens", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const caller = makeDecisionCaller({
			env: { JEV_API_KEY: "test-key" },
			fetch: fakeFetch(200, { model: "jev-1.13.0", answers: { greeting: { type: "noul", noul: 0.97 } }, usage: { input_tokens: 1_000_000, output_tokens: 20 } }, seen),
		});
		const res = await caller(REQUEST);
		assert.equal(seen[0]!.url, "https://api.typesafe.ai/v1/systemone");
		const body = JSON.parse(seen[0]!.init.body as string) as Record<string, unknown>;
		assert.equal(body["model"], "jev-1.13.0", "the provider prefix is stripped");
		assert.equal((seen[0]!.init.headers as Record<string, string>)["Authorization"], "Bearer test-key");
		assert.equal(res.answers["greeting"]!.type, "noul");
		assert.equal(res.costUsd, 0.042);
	});

	it("reaches another provider configured in decisionProviders", async () => {
		const seen: Array<{ url: string; init: RequestInit }> = [];
		const caller = makeDecisionCaller({
			env: { OTHER_KEY: "k" },
			providers: { other: { baseUrl: "https://example.test/api/", apiKeyEnv: ["OTHER_KEY"], inputUsdPerMtok: 1 } },
			fetch: fakeFetch(200, { answers: { greeting: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 10, output_tokens: 0 } }, seen),
		});
		await caller({ ...REQUEST, model: "other/some-model" });
		assert.equal(seen[0]!.url, "https://example.test/api/v1/systemone");
	});

	it("fails with the variable to set, never the key, when no key is present", async () => {
		const caller = makeDecisionCaller({ env: {}, fetch: fakeFetch(200, {}) });
		await assert.rejects(caller(REQUEST), /No credentials for decision provider 'jev': set JEV_API_KEY/);
	});

	it("carries the HTTP status so a 429 is retried", async () => {
		const caller = makeDecisionCaller({ env: { JEV_API_KEY: "k" }, fetch: fakeFetch(429, { detail: "slow down" }) });
		await assert.rejects(caller(REQUEST), (err: unknown) => err instanceof DecisionModelError && err.status === 429);
	});

	it("rejects a response missing an answer", async () => {
		const caller = makeDecisionCaller({ env: { JEV_API_KEY: "k" }, fetch: fakeFetch(200, { answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }) });
		await assert.rejects(caller(REQUEST), /no noul answer for 'greeting'/);
	});
});

describe("scoreLevel", () => {
	it("returns the most probable level, lower on a tie", () => {
		assert.equal(scoreLevel({ type: "score", score: 1, confidence: 0, probabilities: { "0": 0.45, "1": 0.1, "2": 0.45 } }), 0);
		assert.equal(scoreLevel({ type: "score", score: 1.8, confidence: 0.8, probabilities: { "0": 0.05, "1": 0.15, "2": 0.8 } }), 2);
	});
});
