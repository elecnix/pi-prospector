/**
 * The message-question registry: analyzers register the classifier questions
 * they want asked about a message, and the shared `message-answers` analyzer
 * asks them. The registry holds the questions and their identity, nothing else.
 */

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	messageQuestionsHash,
	questionKey,
	registerMessageQuestion,
	registeredMessageQuestions,
	resetMessageQuestions,
	type MessageQuestion,
} from "../../src/analyze/message-questions.js";

function question(over: Partial<MessageQuestion> = {}): MessageQuestion {
	return {
		id: "is-greeting",
		version: 1,
		owner: "demo",
		origins: ["typed"],
		question: { type: "noul", instructions: "Is `message` a greeting?" },
		...over,
	};
}

afterEach(() => resetMessageQuestions());

describe("registerMessageQuestion", () => {
	it("lists registered questions in id order, whatever the order of registration", () => {
		registerMessageQuestion(question({ id: "b-second" }));
		registerMessageQuestion(question({ id: "a-first" }));
		assert.deepEqual(registeredMessageQuestions().map((q) => q.id), ["a-first", "b-second"]);
	});

	it("accepts the same question twice, because a module can load twice", () => {
		registerMessageQuestion(question());
		registerMessageQuestion(question());
		assert.equal(registeredMessageQuestions().length, 1);
	});

	it("rejects a different question under a registered id, and tells the author to raise the version", () => {
		registerMessageQuestion(question());
		assert.throws(
			() => registerMessageQuestion(question({ question: { type: "noul", instructions: "Is `message` a thank-you?" } })),
			/is-greeting.*raise its version/,
		);
	});

	it("replaces a question when its version is higher", () => {
		registerMessageQuestion(question());
		registerMessageQuestion(question({ version: 2, question: { type: "noul", instructions: "Is `message` a greeting or a farewell?" } }));
		assert.deepEqual(registeredMessageQuestions().map((q) => questionKey(q)), ["is-greeting.v2"]);
	});
});

describe("messageQuestionsHash", () => {
	it("changes when a question is added or its version moves, and not with the order of registration", () => {
		registerMessageQuestion(question({ id: "a" }));
		const one = messageQuestionsHash();
		registerMessageQuestion(question({ id: "b" }));
		const two = messageQuestionsHash();
		assert.notEqual(one, two);
		resetMessageQuestions();
		registerMessageQuestion(question({ id: "b" }));
		registerMessageQuestion(question({ id: "a" }));
		assert.equal(messageQuestionsHash(), two);
	});
});
