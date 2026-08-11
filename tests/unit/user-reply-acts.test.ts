/**
 * Unit tests for the pure functions of the `user-reply-acts` custom analyzer
 * and the `user-reply-acts-distribution` roll-up.
 * No DB, no LLM — pure functions only (per AGENTS.md: mock nothing).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildClassifyPrompt,
	parseReply,
	parseAbstention,
	CLASSIFY_PROMPT,
	CLASSIFY_SCHEMA,
	CLASSIFY_SCHEMA_RETRY,
	CLASSIFY_RESPONSE_SCHEMA,
	CLASSIFY_RESPONSE_SCHEMA_RETRY,
	RETRY_PROMPT,
	type UserReplyActsProperties,
} from "../../.prospector/analyzers/user-reply-acts.analyzer.js";
import { rollUp } from "../../.prospector/analyzers/user-reply-acts-distribution.analyzer.js";

describe("user-reply-acts: buildClassifyPrompt", () => {
	it("renders the assistant-then-user pair with labels", () => {
		const p = buildClassifyPrompt({ priorAssistantText: "I propose X.", userText: "Looks good." });
		assert.ok(p.includes("ASSISTANT (previous):"));
		assert.ok(p.includes("I propose X."));
		assert.ok(p.includes("USER (reply):"));
		assert.ok(p.includes("Looks good."));
	});

	it("truncates very long text with head+tail", () => {
		const long = "x".repeat(5000);
		const p = buildClassifyPrompt({ priorAssistantText: long, userText: long });
		assert.ok(!p.includes("x".repeat(2400)), "no unbroken 2400-char run");
		assert.ok(p.includes("…"), "has gap marker");
		assert.ok(p.includes("chars omitted"), "has omission marker");
		assert.ok(p.endsWith(long.slice(-960)), "ends with tail fragment");
	});
});

describe("user-reply-acts: parseReply (array-based schema with quotes)", () => {
	it("parses a full verdict with quotes, an acceptance, a clarify-question, and an answer", () => {
		const v = parseReply({
			acceptances: [{ level: "full", quote: "Looks good, ship it", rationale: "ok" }],
			refusals: [],
			questions: [{ purpose: "clarify", quote: "What do you mean by option A?", rationale: "what?" }],
			answers: [{ quote: "Let's go with option A", rationale: "picks A" }],
			commands: [],
			information_provisions: [],
			continuation: false,
			other: false,
		});
		assert.ok(v);
		assert.equal(v!.acceptances.length, 1);
		assert.equal(v!.acceptances[0]!.level, "full");
		assert.equal(v!.acceptances[0]!.quote, "Looks good, ship it");
		assert.equal(v!.questions.length, 1);
		assert.equal(v!.questions[0]!.purpose, "clarify");
		assert.equal(v!.questions[0]!.quote, "What do you mean by option A?");
		assert.equal(v!.answers.length, 1);
		assert.equal(v!.answers[0]!.quote, "Let's go with option A");
	});

	it("acceptances and refusals can coexist (partial both)", () => {
		const v = parseReply({
			acceptances: [{ level: "partial", quote: "this part is ok", rationale: "this part" }],
			refusals: [{ level: "partial", quote: "that part is wrong", rationale: "that part" }],
			questions: [],
			answers: [], commands: [], information_provisions: [],
			continuation: false,
			other: false,
		});
		assert.ok(v);
		assert.equal(v!.acceptances[0]!.level, "partial");
		assert.equal(v!.acceptances[0]!.quote, "this part is ok");
		assert.equal(v!.refusals[0]!.level, "partial");
		assert.equal(v!.refusals[0]!.quote, "that part is wrong");
	});

	it("parses all four question purposes with quotes", () => {
		const v = parseReply({
			acceptances: [],
			refusals: [],
			questions: [
				{ purpose: "request", quote: "add tests", rationale: "r" },
				{ purpose: "decision", quote: "which option?", rationale: "d" },
				{ purpose: "clarify", quote: "what do you mean?", rationale: "c" },
				{ purpose: "information", quote: "what does X do?", rationale: "i" },
			],
			answers: [], commands: [], information_provisions: [],
			continuation: false,
			other: false,
		});
		assert.ok(v);
		assert.deepEqual(v!.questions.map((q) => q.purpose), ["request", "decision", "clarify", "information"]);
		assert.deepEqual(v!.questions.map((q) => q.quote), ["add tests", "which option?", "what do you mean?", "what does X do?"]);
	});

	it("returns null when any required array is missing", () => {
		assert.equal(parseReply({ acceptances: [], refusals: [], questions: [], information_provisions: [], continuation: false, other: false }), null, "missing answers array → null");
	});

	it("returns null for an invalid acceptance level", () => {
		assert.equal(
			parseReply({ acceptances: [{ level: "bogus", quote: "x", rationale: "x" }], refusals: [], questions: [], answers: [], commands: [], information_provisions: [], continuation: false, other: false }),
			null,
		);
	});

	it("returns null when a question has no valid purpose", () => {
		const v = parseReply({
			acceptances: [],
			refusals: [],
			questions: [{ purpose: "bogus", quote: "x", rationale: "x" }],
			answers: [], commands: [], information_provisions: [],
			continuation: false,
			other: false,
		});
		assert.equal(v, null);
	});

	it("returns null when an acceptance has no quote", () => {
		const v = parseReply({
			acceptances: [{ level: "full", quote: "", rationale: "ok" }],
			refusals: [],
			questions: [],
			answers: [], commands: [], information_provisions: [],
			continuation: false,
			other: false,
		});
		assert.equal(v, null, "an act without a quote is unusable");
	});

	it("returns null when a question has no quote", () => {
		const v = parseReply({
			acceptances: [],
			refusals: [],
			questions: [{ purpose: "clarify", quote: "", rationale: "x" }],
			answers: [], commands: [], information_provisions: [],
			continuation: false,
			other: false,
		});
		assert.equal(v, null, "an act without a quote is unusable");
	});

	it("returns null when an answer has no quote", () => {
		const v = parseReply({
			acceptances: [],
			refusals: [],
			questions: [],
			answers: [{ quote: "", rationale: "x" }],
			continuation: false,
			other: false,
		});
		assert.equal(v, null, "an act without a quote is unusable");
	});

	it("truncates a very long rationale and quote to 300 chars", () => {
		const long = "r".repeat(1000);
		const v = parseReply({
			acceptances: [{ level: "full", quote: long, rationale: long }],
			refusals: [],
			questions: [],
			answers: [], commands: [], information_provisions: [],
			continuation: false,
			other: false,
		});
		assert.ok(v);
		assert.equal(v!.acceptances[0]!.rationale.length, 300);
		assert.equal(v!.acceptances[0]!.quote.length, 300);
	});

	it("tolerates a continuation-only reply", () => {
		const v = parseReply({
			acceptances: [],
			refusals: [],
			questions: [],
			answers: [], commands: [], information_provisions: [],
			continuation: true,
			other: false,
		});
		assert.ok(v);
		assert.equal(v!.continuation, true);
	});
});

describe("user-reply-acts: prompt + schema shape", () => {
	it("the shipped prompt requires quotes, steers away from other, and covers all purposes", () => {
		assert.ok(CLASSIFY_PROMPT.includes("ASSISTANT (previous)"));
		assert.ok(CLASSIFY_PROMPT.includes("acceptances"));
		assert.ok(CLASSIFY_PROMPT.includes("refusals"));
		assert.ok(CLASSIFY_PROMPT.includes("clarify"));
		assert.ok(CLASSIFY_PROMPT.includes("decision"));
		assert.ok(CLASSIFY_PROMPT.includes("information"));
		assert.ok(CLASSIFY_PROMPT.includes("NOT mutually exclusive"));
		assert.ok(CLASSIFY_PROMPT.includes("classify_reply"), "prompt mentions classify_reply");
		// quote requirement
		assert.ok(CLASSIFY_PROMPT.includes("quote"), "prompt requires quotes");
		assert.ok(CLASSIFY_PROMPT.includes("exact substring"), "prompt says exact substring");
		assert.ok(CLASSIFY_PROMPT.includes("verbatim"), "prompt says verbatim");
		// other is a last resort
		assert.ok(CLASSIFY_PROMPT.includes("last resort"), "prompt says other is a last resort");
		assert.ok(CLASSIFY_PROMPT.includes("correction"), "prompt mentions corrections as refusals");
	});

	it("the response schema requires a quote on every act and enumerates levels/purposes", () => {
		const schema = CLASSIFY_SCHEMA as unknown as {
			properties: {
				acceptances: { items: { properties: { level: { anyOf: Array<{ const: string }> }; quote: unknown } } };
				refusals: { items: { properties: { level: { anyOf: Array<{ const: string }> }; quote: unknown } } };
				questions: { items: { properties: { purpose: { anyOf: Array<{ const: string }> }; quote: unknown } } };
				answers: { items: { properties: { quote: unknown } } };
			};
			additionalProperties: false;
		};
		// quote is present on every act
		assert.ok(schema.properties.acceptances.items.properties.quote, "acceptances have quote");
		assert.ok(schema.properties.refusals.items.properties.quote, "refusals have quote");
		assert.ok(schema.properties.questions.items.properties.quote, "questions have quote");
		assert.ok(schema.properties.answers.items.properties.quote, "answers have quote");
		// levels and purposes
		const levels = schema.properties.acceptances.items.properties.level.anyOf.map((x) => x.const);
		const purposes = schema.properties.questions.items.properties.purpose.anyOf.map((x) => x.const);
		assert.deepEqual([...levels].sort(), ["full", "partial"]);
		assert.deepEqual([...purposes].sort(), ["clarify", "decision", "information", "request"]);
		// strict mode: additionalProperties: false
		assert.equal(schema.additionalProperties, false, "schema has additionalProperties: false for strict mode");
	});
});

describe("user-reply-acts: retry schema + abstention", () => {
	it("the retry schema includes classifier_abstention but the primary schema does not", () => {
		const retrySchema = CLASSIFY_SCHEMA_RETRY as unknown as { properties: { classifier_abstention?: unknown } };
		const primarySchema = CLASSIFY_SCHEMA as unknown as { properties: { classifier_abstention?: unknown } };
		assert.ok(retrySchema.properties.classifier_abstention, "retry schema has abstention");
		assert.ok(!primarySchema.properties.classifier_abstention, "primary schema has no abstention");
	});

	it("the retry prompt mentions abstention, reason, and proposed_class", () => {
		assert.ok(RETRY_PROMPT.includes("classifier_abstention"));
		assert.ok(RETRY_PROMPT.includes("reason"));
		assert.ok(RETRY_PROMPT.includes("propose the closest class"));
		assert.ok(RETRY_PROMPT.includes("last resort"));
	});

	it("parseAbstention extracts a valid abstention", () => {
		const a = parseAbstention({
			classifier_abstention: { reason: "reply is in a language I don't understand", proposed_class: "other" },
		});
		assert.ok(a);
		assert.equal(a!.reason, "reply is in a language I don't understand");
		assert.equal(a!.proposed_class, "other");
	});

	it("parseAbstention accepts all proposed_class values", () => {
		for (const c of ["acceptance", "refusal", "question", "continuation", "other"]) {
			const a = parseAbstention({ classifier_abstention: { reason: "x", proposed_class: c } });
			assert.ok(a, `should parse proposed_class=${c}`);
			assert.equal(a!.proposed_class, c);
		}
	});

	it("parseAbstention returns null for missing reason or proposed_class", () => {
		assert.equal(parseAbstention({ classifier_abstention: { reason: "x" } }), null);
		assert.equal(parseAbstention({ classifier_abstention: { proposed_class: "other" } }), null);
		assert.equal(parseAbstention({ classifier_abstention: { reason: "x", proposed_class: "bogus" } }), null);
		assert.equal(parseAbstention({}), null);
	});
});

describe("user-reply-acts-distribution: rollUp", () => {
	function reply(over: Partial<UserReplyActsProperties>): UserReplyActsProperties {
		return {
			user_message_id: over.user_message_id ?? "m",
			prior_user_message_id: null,
			prior_core_output_key: null,
			pair_index: over.pair_index ?? 0,
			acceptances: over.acceptances ?? [],
			refusals: over.refusals ?? [],
			questions: over.questions ?? [],
			answers: over.answers ?? [],
			commands: over.commands ?? [],
			information_provisions: over.information_provisions ?? [],
			continuation: over.continuation ?? false,
			other: over.other ?? false,
			abstention: over.abstention ?? null,
			attempt: over.attempt ?? 1,
		};
	}

	it("counts replies with each act and totals acts by level/purpose", () => {
		const d = rollUp("s1", [
			reply({ acceptances: [{ level: "full", quote: "ok", rationale: "" }] }),
			reply({ refusals: [{ level: "full", quote: "no", rationale: "" }], questions: [{ purpose: "clarify", quote: "what?", rationale: "" }] }),
			reply({ acceptances: [{ level: "partial", quote: "this", rationale: "" }], refusals: [{ level: "partial", quote: "that", rationale: "" }], questions: [{ purpose: "request", quote: "add tests", rationale: "" }], answers: [{ quote: "A", rationale: "" }] }),
			reply({ continuation: true }),
		]);
		assert.equal(d.replies_classified, 4);
		assert.equal(d.replies_with_acceptance, 2);
		assert.equal(d.replies_with_refusal, 2);
		assert.equal(d.replies_with_question, 2);
		assert.equal(d.replies_with_clarify_question, 1);
		assert.equal(d.replies_with_answer, 1);
		assert.equal(d.replies_continuation, 1);
		assert.equal(d.acceptances_by_level.full, 1);
		assert.equal(d.acceptances_by_level.partial, 1);
		assert.equal(d.refusals_by_level.full, 1);
		assert.equal(d.refusals_by_level.partial, 1);
		assert.equal(d.questions_by_purpose.clarify, 1);
		assert.equal(d.questions_by_purpose.request, 1);
		assert.equal(d.total_answers, 1);
		// acceptances(2) / (acceptances(2) + refusals(2)) = 0.5
		assert.equal(d.acceptance_refusal_ratio, 0.5);
	});

	it("returns a null ratio when no acceptances or refusals", () => {
		const d = rollUp("s1", [reply({ continuation: true }), reply({ questions: [{ purpose: "information", quote: "what?", rationale: "" }] })]);
		assert.equal(d.acceptance_refusal_ratio, null);
		assert.equal(d.replies_classified, 2);
		assert.equal(d.questions_by_purpose.information, 1);
	});

	it("produces an empty distribution for no replies", () => {
		const d = rollUp("s1", []);
		assert.equal(d.replies_classified, 0);
		assert.equal(d.acceptance_refusal_ratio, null);
	});
});