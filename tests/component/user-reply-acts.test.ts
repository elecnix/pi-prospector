/**
 * Component test for the `user-reply-acts` + `user-reply-acts-distribution`
 * custom analyzers (loaded from .prospector/analyzers/ on disk). Seeds a
 * realistic multi-turn session where the user's replies exercise every act —
 * full acceptance, refusal, a decision-answer (closing a fork the assistant
 * opened), a clarify-question, a request-question, a multi-act reply (accept +
 * request), and a continuation — then runs both analyzers with a scripted mock
 * LLM and asserts the graph, anchoring, the consumes edge, idempotent re-runs,
 * the unbiased turn-order cap, and the session-level distribution roll-up.
 *
 * Real SQLite (temp file), hand-written synthetic messages, mock LLM keyed on
 * the user reply text. No network, no API key.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as url from "node:url";
import { tempDb, insertSession, insertMessages, type TempDb } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM, type MockLLMReply } from "../../src/analyze/mock-llm.js";
import { registerAll } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import type { LLMRequest } from "../../src/analyze/types.js";
import type { UserReplyActsProperties } from "../../.prospector/analyzers/user-reply-acts.analyzer.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ANALYZER_DIR = path.resolve(__dirname, "..", "..", ".prospector", "analyzers");

/** Scripted mock keyed on the USER (reply) text. */
function responder(req: LLMRequest): MockLLMReply {
	if (req.tool?.name !== "classify_reply" && req.responseSchema?.name !== "classify_reply" && req.responseSchema?.name !== "classify_reply_retry") return { text: "{}" };
	const replyText = extractReplyText(req.user);
	const base = { acceptances: [], refusals: [], questions: [], answers: [], commands: [], information_provisions: [], memories: [], continuation: false, other: false };

	if (replyText.includes("Looks good, ship it")) {
		return { text: "ok", structured: { ...base, acceptances: [{ level: "full", quote: "Looks good, ship it", rationale: "approves" }] } };
	}
	if (replyText.includes("No, don't")) {
		return { text: "ok", structured: { ...base, refusals: [{ level: "full", quote: "No, don't ship that, revert it", rationale: "rejects" }] } };
	}
	if (replyText.includes("Let's go with option A")) {
		return { text: "ok", structured: { ...base, acceptances: [{ level: "full", quote: "Let's go with option A", rationale: "endorses A" }], answers: [{ quote: "Let's go with option A", rationale: "answers A-or-B" }] } };
	}
	if (replyText.includes("What do you mean by")) {
		return { text: "ok", structured: { ...base, questions: [{ purpose: "clarify", quote: "What do you mean by option A? How does it work?", rationale: "re-explain" }] } };
	}
	if (replyText.includes("Can you also add tests")) {
		return {
			text: "ok",
			structured: {
				...base,
				acceptances: [{ level: "full", quote: "The backoff looks right", rationale: "backoff ok" }],
				questions: [{ purpose: "request", quote: "Can you also add tests for it?", rationale: "add tests" }],
				memories: [{ scope: "project", quote: "The backoff looks right", rationale: "project uses exponential backoff for retries" }],
			},
		};
	}
	if (replyText.includes("Now help me with the CSS")) {
		return { text: "ok", structured: { ...base, continuation: true } };
	}
	return { text: "ok", structured: base };
}

function extractReplyText(prompt: string): string {
	const marker = "USER (reply):";
	const idx = prompt.indexOf(marker);
	return idx < 0 ? "" : prompt.slice(idx + marker.length).trim();
}

interface ReplyNode {
	user_message_id: string;
	acceptances: Array<{ level: string; rationale: string }>;
	refusals: Array<{ level: string; rationale: string }>;
	questions: Array<{ purpose: string; rationale: string }>;
	answers: Array<{ rationale: string }>;
	memories: Array<{ scope: string; quote: string; rationale: string }>;
	continuation: boolean;
	other: boolean;
}

describe("user-reply-acts custom analyzer", () => {
	it("classifies user replies into multi-act arrays, anchored and idempotent", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s1";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "Fix the login bug in auth.ts" },
				{ id: "a0", role: "assistant", text: "I'll look at auth.ts and propose a fix." },
				{ id: "u1", role: "user", text: "Looks good, ship it." },
				{ id: "a1", role: "assistant", text: "Shipping the fix now." },
				{ id: "u2", role: "user", text: "No, don't ship that, revert it." },
				{ id: "a2", role: "assistant", text: "Reverting the change." },
				{ id: "a3pre", role: "assistant", text: "Should I use option A or option B for the retry?" },
				{ id: "u3", role: "user", text: "Let's go with option A." },
				{ id: "a3", role: "assistant", text: "Using option A." },
				{ id: "u4", role: "user", text: "What do you mean by option A? How does it work?" },
				{ id: "a4", role: "assistant", text: "Option A retries with exponential backoff." },
				{ id: "u5", role: "user", text: "The backoff looks right. Can you also add tests for it?" },
				{ id: "a5", role: "assistant", text: "Adding tests for the backoff." },
				{ id: "u6", role: "user", text: "Now help me with the CSS for the login page." },
				{ id: "a6", role: "assistant", text: "Looking at the CSS." },
			]);

			const mock = createMockLLM({ responder, tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { customRegistered, errors } = await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			assert.deepEqual(errors, [], JSON.stringify(errors));
			assert.ok(customRegistered.includes("user-reply-acts"));
			assert.ok(customRegistered.includes("user-reply-acts-distribution"));

			const summary = await fw.run(sid, { analyzerIds: ["user-reply-acts", "user-reply-acts-distribution"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			assert.ok(summary.nodesProduced > 0);

			const rows = t.db
				.prepare("SELECT content_json, node_kind FROM analysis_nodes WHERE analyzer_id = 'user-reply-acts' ORDER BY created_at")
				.all() as Array<{ content_json: string; node_kind: string }>;
			assert.ok(rows.length >= 6, `expected ≥6 reply nodes, got ${rows.length}`);
			for (const r of rows) assert.equal(r.node_kind, "classification");

			const byMsg = new Map(rows.map((r) => [((JSON.parse(r.content_json)) as ReplyNode).user_message_id, JSON.parse(r.content_json) as ReplyNode]));
			assertReply(byMsg, "u1", { acceptances: ["full"], refusals: [], questions: [], answers: [] });
			assertReply(byMsg, "u2", { acceptances: [], refusals: ["full"], questions: [], answers: [] });
			assertReply(byMsg, "u3", { acceptances: ["full"], refusals: [], questions: [], answers: ["yes"] });
			assertReply(byMsg, "u4", { acceptances: [], refusals: [], questions: ["clarify"], answers: [] });
			assertReply(byMsg, "u5", { acceptances: ["full"], refusals: [], questions: ["request"], answers: [] });
			assertReply(byMsg, "u6", { acceptances: [], refusals: [], questions: [], answers: [], continuation: true });

			// consumes + anchors + uses_prompt edges
			const consumes = (t.db.prepare("SELECT COUNT(*) AS c FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id=n.id WHERE n.analyzer_id='user-reply-acts' AND e.edge_kind='consumes'").get() as { c: number }).c;
			assert.ok(consumes >= 6, `expected ≥6 consumes, got ${consumes}`);
			const anchors = (t.db.prepare("SELECT COUNT(*) AS c FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id=n.id WHERE n.analyzer_id='user-reply-acts' AND e.edge_kind='anchors'").get() as { c: number }).c;
			assert.equal(anchors, rows.length);
			const usesPrompt = (t.db.prepare("SELECT COUNT(*) AS c FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id=n.id WHERE n.analyzer_id='user-reply-acts' AND e.edge_kind='uses_prompt'").get() as { c: number }).c;
			assert.equal(usesPrompt, rows.length);

			// ── distribution node ──
			const distRow = t.db.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id='user-reply-acts-distribution'").get() as { content_json: string } | undefined;
			assert.ok(distRow, "distribution node produced");
			const dist = JSON.parse(distRow!.content_json) as {
				replies_classified: number;
				replies_with_acceptance: number;
				replies_with_refusal: number;
				replies_with_clarify_question: number;
				questions_by_purpose: Record<string, number>;
				acceptance_refusal_ratio: number | null;
			};
			assert.equal(dist.replies_classified, 6);
			assert.equal(dist.replies_with_acceptance, 3); // u1, u3, u5
			assert.equal(dist.replies_with_refusal, 1); // u2
			assert.equal(dist.replies_with_clarify_question, 1); // u4
			assert.equal(dist.questions_by_purpose.clarify, 1);
			assert.equal(dist.questions_by_purpose.request, 1);
			// acceptances(3) / (3 + 1) = 0.75
			assert.equal(dist.acceptance_refusal_ratio, 0.75);
			// memories: u5 has one project-scoped memory
			assert.equal(dist.replies_with_memory, 1);
			assert.equal(dist.total_memories, 1);
			assert.equal(dist.memories_by_scope.project, 1);

			// idempotent re-run
			const fw2 = new AnalyzerFramework({ db: t.db, llm: createMockLLM({ responder }).caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw2, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			const rerun = await fw2.run(sid, { analyzerIds: ["user-reply-acts", "user-reply-acts-distribution"] });
			assert.equal(rerun.nodesProduced, 0, "fill re-run produces nothing new");
			assert.equal(rerun.errors.length, 0, rerun.errors.join("; "));
		} finally {
			t.close();
		}
	});

	it("rejects unusable model output with an error node and self-heals on re-run", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s2";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "Do something" },
				{ id: "a0", role: "assistant", text: "I propose X." },
				{ id: "u1", role: "user", text: "Looks good, ship it." },
				{ id: "a1", role: "assistant", text: "Done." },
			]);
			const bad = createMockLLM({ responder: () => ({ text: "I cannot do that" }), tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: bad.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			const summary = await fw.run(sid, { analyzerIds: ["user-reply-acts"] });
			assert.ok(summary.errors.length > 0, "unusable output should error");
			assert.ok(summary.errors.some((e) => e.includes("no usable classify_reply verdict")), summary.errors.join("; "));
			const errNodes = t.db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id='user-reply-acts' AND node_kind='error'").get() as { c: number };
			assert.ok(errNodes.c >= 1, "error node recorded");
			const okNodes = t.db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id='user-reply-acts' AND node_kind='classification'").get() as { c: number };
			assert.equal(okNodes.c, 0);

			const good = createMockLLM({ responder, tokensPerCall: 10, costPerCall: 0.0001 });
			const fw2 = new AnalyzerFramework({ db: t.db, llm: good.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw2, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			const heal = await fw2.run(sid, { analyzerIds: ["user-reply-acts"] });
			assert.equal(heal.errors.length, 0, heal.errors.join("; "));
			assert.ok(heal.nodesProduced >= 1, "self-healed");
		} finally {
			t.close();
		}
	});

	it("classifies replies in turn order, not friction-ranked (unbiased cap)", async () => {
		// Seed many replies (> default cap of 100 is impractical here; instead
		// verify the ordering is turn order by checking pair_index is monotonic
		// across produced nodes when the cap is set low).
		const t: TempDb = await tempDb();
		try {
			const sid = "s3";
			await insertSession(t.db, sid);
			const msgs: Array<{ id: string; role: string; text?: string }> = [];
			for (let i = 0; i < 6; i++) {
				msgs.push({ id: `u${i}`, role: "user", text: i === 0 ? "start" : `reply ${i}` });
				msgs.push({ id: `a${i}`, role: "assistant", text: `assistant ${i}` });
			}
			await insertMessages(t.db, sid, msgs);

			const mock = createMockLLM({ responder: () => ({ text: "ok", structured: { acceptances: [], refusals: [], questions: [], answers: [], commands: [], information_provisions: [], memories: [], continuation: true, other: false } }), tokensPerCall: 1, costPerCall: 0 });
			// Override the cap to 3 via configOverrides.
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS, configOverrides: { "user-reply-acts": { maxRepliesPerSession: 3 } } });
			await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			const summary = await fw.run(sid, { analyzerIds: ["user-reply-acts"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const rows = t.db.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id='user-reply-acts' ORDER BY created_at").all() as Array<{ content_json: string }>;
			assert.equal(rows.length, 3, "cap=3 applied");
			const indices = rows.map((r) => (JSON.parse(r.content_json) as { pair_index: number }).pair_index);
			// Turn order → monotonic increasing pair_index (u1,u2,u3 → indices 1,2,3).
			assert.deepEqual(indices, [1, 2, 3], "turn order, not friction-ranked");
		} finally {
			t.close();
		}
	});
});

function assertReply(
	byMsg: Map<string, ReplyNode>,
	msgId: string,
	expected: {
		acceptances: string[];
		refusals: string[];
		questions: string[];
		answers: string[];
		continuation?: boolean;
	},
): void {
	const node = byMsg.get(msgId);
	assert.ok(node, `no node for ${msgId}`);
	assert.deepEqual(node.acceptances.map((a) => a.level), expected.acceptances, `${msgId}: acceptances`);
	assert.deepEqual(node.refusals.map((r) => r.level), expected.refusals, `${msgId}: refusals`);
	assert.deepEqual(node.questions.map((q) => q.purpose), expected.questions, `${msgId}: questions`);
	assert.equal(node.answers.length, expected.answers.length, `${msgId}: answers count`);
	if (expected.continuation !== undefined) assert.equal(node.continuation, expected.continuation, `${msgId}: continuation`);
}

describe("user-reply-acts agentic retry", () => {
	it("retries with the abstention tool when the first attempt fails, and stores an abstention", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s-retry";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "Do something" },
				{ id: "a0", role: "assistant", text: "I propose X. Should I use A or B?" },
				{ id: "u1", role: "user", text: "gzxbqwk" },  // nonsense the model can't classify
				{ id: "a1", role: "assistant", text: "Done." },
			]);

			let callCount = 0;
			const mock = createMockLLM({
				responder: (req: LLMRequest): MockLLMReply => {
					callCount++;
					if (req.tool?.name === "classify_reply" || req.responseSchema?.name === "classify_reply" || req.responseSchema?.name === "classify_reply_retry") {
						// First call uses CLASSIFY_TOOL (no abstention). Second uses CLASSIFY_TOOL_RETRY.
						// Distinguish by the system prompt: retry uses RETRY_PROMPT.
						const isRetry = req.system?.includes("classifier_abstention") ?? false;
						if (!isRetry) {
							// First attempt: return garbage (no structured output).
							return { text: "I cannot classify this" };
						} else {
							// Second attempt: abstain with a reason and proposed class.
							return {
								text: "ok",
								structured: {
									acceptances: [],
									refusals: [],
									questions: [],
									answers: [],
									continuation: false, commands: [], information_provisions: [], memories: [],
									other: false,
									classifier_abstention: {
										reason: "reply is nonsensical text with no discernible act",
										proposed_class: "other",
									},
								},
							};
						}
					}
					return { text: "{}" };
				},
				tokensPerCall: 10,
				costPerCall: 0.0001,
			});
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["user-reply-acts"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			assert.equal(callCount, 2, "exactly 2 LLM calls (first fail + retry)");

			const row = t.db.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'user-reply-acts' AND node_kind = 'classification'").get() as { content_json: string } | undefined;
			assert.ok(row, "produced a classification node");
			const c = JSON.parse(row!.content_json) as UserReplyActsProperties;
			assert.equal(c.attempt, 2, "attempt is 2");
			assert.ok(c.abstention, "abstention is present");
			assert.equal(c.abstention!.proposed_class, "other");
			assert.ok(c.abstention!.reason.length > 0, "abstention has a reason");
			assert.equal(c.acceptances.length, 0, "no acts when abstaining");
		} finally {
			t.close();
		}
	});

	it("retries and succeeds on the second attempt when the first returns garbage", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s-retry2";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "Do something" },
				{ id: "a0", role: "assistant", text: "I propose X." },
				{ id: "u1", role: "user", text: "Yes, go ahead." },
				{ id: "a1", role: "assistant", text: "Done." },
			]);

			let callCount = 0;
			const mock = createMockLLM({
				responder: (req: LLMRequest): MockLLMReply => {
					callCount++;
					if (req.tool?.name !== "classify_reply" && req.responseSchema?.name !== "classify_reply" && req.responseSchema?.name !== "classify_reply_retry") return { text: "{}" };
					const isRetry = req.system?.includes("classifier_abstention") ?? false;
					if (!isRetry) {
						// First attempt: garbage.
						return { text: "I don't know" };
					} else {
						// Second attempt: valid classification.
						return {
							text: "ok",
							structured: {
								acceptances: [{ level: "full", quote: "Yes, go ahead.", rationale: "accepts" }],
								refusals: [],
								questions: [],
								answers: [],
								continuation: false, commands: [], information_provisions: [], memories: [],
								other: false,
							},
						};
					}
				},
				tokensPerCall: 10,
				costPerCall: 0.0001,
			});
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			const summary = await fw.run(sid, { analyzerIds: ["user-reply-acts"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			assert.equal(callCount, 2);

			const row = t.db.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'user-reply-acts' AND node_kind = 'classification'").get() as { content_json: string };
			const c = JSON.parse(row.content_json) as UserReplyActsProperties;
			assert.equal(c.attempt, 2, "succeeded on attempt 2");
			assert.equal(c.acceptances.length, 1);
			assert.equal(c.acceptances[0]!.level, "full");
			assert.equal(c.abstention, null, "no abstention on success");
		} finally {
			t.close();
		}
	});

	it("does not retry when the first attempt succeeds", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s-noretry";
			await insertSession(t.db, sid);
			await insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "Do something" },
				{ id: "a0", role: "assistant", text: "I propose X." },
				{ id: "u1", role: "user", text: "Yes, go ahead." },
				{ id: "a1", role: "assistant", text: "Done." },
			]);

			let callCount = 0;
			const mock = createMockLLM({
				responder: (req: LLMRequest): MockLLMReply => {
					callCount++;
					if (req.tool?.name !== "classify_reply" && req.responseSchema?.name !== "classify_reply" && req.responseSchema?.name !== "classify_reply_retry") return { text: "{}" };
					return {
						text: "ok",
						structured: {
							acceptances: [{ level: "full", quote: "Yes, go ahead.", rationale: "accepts" }],
							refusals: [],
							questions: [],
							answers: [],
							continuation: false, commands: [], information_provisions: [], memories: [],
							other: false,
						},
					};
				},
				tokensPerCall: 10,
				costPerCall: 0.0001,
			});
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			await fw.run(sid, { analyzerIds: ["user-reply-acts"] });
			assert.equal(callCount, 1, "only 1 call — no retry when first attempt succeeds");
		} finally {
			t.close();
		}
	});
});