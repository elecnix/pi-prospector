/**
 * message-answers asks the registered classifier questions about each typed
 * message, once, in one request.
 *
 * The messages and the questions are invented, and the decision model is a mock
 * that records each request. The tests pin the two properties the layer exists
 * for: a request carries the questions of every analyzer that registered one, and
 * a question that already has an answer for a message is never sent again.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, nodeEdges, readAnalyzerNodes } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { messageOriginAnalyzer } from "../../src/analyze/analyzers/message-origin/index.js";
import { messageAnswersAnalyzer, MESSAGE_ANSWERS_DEF, type MessageAnswersProperties } from "../../src/analyze/analyzers/message-answers/index.js";
import { registerMessageQuestion, resetMessageQuestions, type MessageQuestion } from "../../src/analyze/message-questions.js";
import type { DecisionAnswer } from "../../src/analyze/decision-model.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

const MODEL = "jev/jev-1.13.0";

const GREETING: MessageQuestion = {
	id: "is-greeting",
	version: 1,
	owner: "demo-a",
	origins: ["typed"],
	question: { type: "noul", instructions: "Is `message` a greeting?" },
};

const POLITE: MessageQuestion = {
	id: "tone",
	version: 1,
	owner: "demo-b",
	origins: ["typed"],
	question: {
		type: "choice",
		instructions: "Which tone is `message` written in?",
		criteria: { polite: "Courteous wording", curt: "Short and blunt" },
	},
};

const SUMMARY: MessageQuestion = {
	id: "needs-summary",
	version: 1,
	owner: "demo-c",
	origins: ["typed"],
	question: { type: "noul", instructions: "Does `message` ask for a summary?" },
};

const CONVERSATION = [
	{ role: "user", text: "hello there, could you look at the build?" },
	{ role: "assistant", text: "Looking." },
	{ role: "user", text: "<system-reminder>Background work finished.</system-reminder>" },
	{ role: "assistant", text: "Noted." },
	{ role: "user", text: "thanks, now summarize it" },
	{ role: "assistant", text: "Done." },
];

function answerAll(questions: Record<string, { type: string; criteria?: unknown }>): Record<string, DecisionAnswer> {
	const out: Record<string, DecisionAnswer> = {};
	for (const [key, q] of Object.entries(questions)) {
		out[key] =
			q.type === "noul"
				? { type: "noul", noul: 0.9 }
				: { type: "choice", choice: "polite", confidence: 0.9, probabilities: { polite: 0.9, curt: 0.1 } };
	}
	return out;
}

function setup() {
	const model = createMockDecisionModel({ responder: (request) => answerAll(request.questions) });
	return { model };
}

async function frameworkFor(db: AsyncDatabase, model: ReturnType<typeof setup>["model"], decisionModel: string | null = MODEL) {
	const framework = new AnalyzerFramework({
		db,
		llm: createThrowingLLM("message-answers must not call the generative model"),
		decide: model.caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: decisionModel ? { [MESSAGE_ANSWERS_DEF.id]: { decisionModel } } : undefined,
	});
	await framework.register(messageOriginAnalyzer);
	await framework.register(messageAnswersAnalyzer);
	return framework;
}

async function answers(db: AsyncDatabase): Promise<MessageAnswersProperties[]> {
	return (await readAnalyzerNodes(db, MESSAGE_ANSWERS_DEF.id)).map((n) => JSON.parse(n.content_json) as MessageAnswersProperties);
}

beforeEach(() => {
	resetMessageQuestions();
	registerMessageQuestion(GREETING);
	registerMessageQuestion(POLITE);
});
afterEach(() => resetMessageQuestions());

describe("message-answers", () => {
	it("sends the questions of two analyzers about a typed message in one request", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", CONVERSATION);
			const { model } = setup();
			await (await frameworkFor(db, model)).run("s1");
			assert.equal(model.calls.length, 2, "one request per typed message, none for the harness notification");
			for (const call of model.calls) {
				assert.deepEqual(Object.keys(call.questions).sort(), ["is-greeting.v1", "tone.v1"]);
				assert.equal(call.model, MODEL);
			}
			const found = await answers(db);
			assert.equal(found.length, 2);
			assert.deepEqual(Object.keys(found[0]!.answers).sort(), ["is-greeting.v1", "tone.v1"]);
		} finally {
			await close();
		}
	});

	it("shows the model the person's words alone", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", [
				{ role: "user", text: "why does this fail when I run the whole suite twice in a row on a clean checkout?\n\n```\nerror: boom\n```" },
				{ role: "assistant", text: "Checking." },
			]);
			const { model } = setup();
			await (await frameworkFor(db, model)).run("s1");
			assert.deepEqual(model.calls[0]!.state, { message: { text: "why does this fail when I run the whole suite twice in a row on a clean checkout?", shortened: false } });
		} finally {
			await close();
		}
	});

	it("never sends a question again once it has an answer", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", CONVERSATION);
			const { model } = setup();
			const framework = await frameworkFor(db, model);
			await framework.run("s1");
			const sent = model.calls.length;
			await framework.run("s1");
			assert.equal(model.calls.length, sent, "a plain re-run sends nothing");
			await framework.run("s1", { revise: ["config"] });
			assert.equal(model.calls.length, sent, "a revise with nothing new sends nothing");
		} finally {
			await close();
		}
	});

	it("sends only the new question when a third one is registered, and carries the old answers forward", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", CONVERSATION);
			const { model } = setup();
			await (await frameworkFor(db, model)).run("s1");
			const sent = model.calls.length;

			registerMessageQuestion(SUMMARY);
			const framework = await frameworkFor(db, model);
			await framework.run("s1");
			assert.equal(model.calls.length, sent, "a plain run leaves the stale nodes alone");
			await framework.run("s1", { revise: ["config"] });
			const fresh = model.calls.slice(sent);
			assert.equal(fresh.length, 2);
			for (const call of fresh) assert.deepEqual(Object.keys(call.questions), ["needs-summary.v1"]);

			const nodes = await readAnalyzerNodes(db, MESSAGE_ANSWERS_DEF.id);
			assert.equal(nodes.length, 4, "two messages, each with a first node and a revised one");
			const newest = (await answers(db)).filter((a) => Object.keys(a.answers).length === 3);
			assert.equal(newest.length, 2);
			const revised = await Promise.all(nodes.map((n) => nodeEdges(db, n.id)));
			assert.equal(revised.flat().filter((e) => e["edge_kind"] === "revises").length, 2);
		} finally {
			await close();
		}
	});

	it("asks again only the question whose version was raised", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", CONVERSATION);
			const { model } = setup();
			await (await frameworkFor(db, model)).run("s1");
			const sent = model.calls.length;

			registerMessageQuestion({ ...GREETING, version: 2, question: { type: "noul", instructions: "Is `message` a greeting or a farewell?" } });
			await (await frameworkFor(db, model)).run("s1", { revise: ["config"] });
			for (const call of model.calls.slice(sent)) assert.deepEqual(Object.keys(call.questions), ["is-greeting.v2"]);
			const newest = (await answers(db)).filter((a) => "is-greeting.v2" in a.answers);
			assert.ok(newest.every((a) => !("is-greeting.v1" in a.answers) && "tone.v1" in a.answers), "the old version is dropped and the other answer kept");
		} finally {
			await close();
		}
	});

	it("asks a question again when its wording changed without a version bump, as when the code was edited between runs", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", CONVERSATION);
			const { model } = setup();
			await (await frameworkFor(db, model)).run("s1");
			const sent = model.calls.length;

			resetMessageQuestions();
			registerMessageQuestion({ ...GREETING, question: { type: "noul", instructions: "Is `message` a greeting or a thank-you?" } });
			registerMessageQuestion(POLITE);
			await (await frameworkFor(db, model)).run("s1", { revise: ["config"] });
			const fresh = model.calls.slice(sent);
			assert.equal(fresh.length, 2);
			for (const call of fresh) assert.deepEqual(Object.keys(call.questions), ["is-greeting.v1"], "only the edited question is asked");
		} finally {
			await close();
		}
	});

	it("asks nothing and writes nothing when no decision model is configured", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", CONVERSATION);
			const { model } = setup();
			await (await frameworkFor(db, model, null)).run("s1");
			assert.equal(model.calls.length, 0);
			assert.equal((await readAnalyzerNodes(db, MESSAGE_ANSWERS_DEF.id)).length, 0);
		} finally {
			await close();
		}
	});

	it("records the message-origin node it read as an input, by a consumes edge", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", CONVERSATION);
			const { model } = setup();
			await (await frameworkFor(db, model)).run("s1");
			const node = (await readAnalyzerNodes(db, MESSAGE_ANSWERS_DEF.id))[0]!;
			const edges = await nodeEdges(db, node.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "consumes").length, 1);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors").length, 1);
		} finally {
			await close();
		}
	});
});
