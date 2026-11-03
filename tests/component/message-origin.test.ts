/**
 * message-origin labels every turn-starting message once, and leaves the
 * messages the rules cannot place to a decision model.
 *
 * The fixtures in `tests/fixtures/text-origin/` are invented pi and Claude Code
 * transcripts. The sync reads them with the real parsers and the framework runs
 * the real analyzers, so the child-agent link and the message roles reach the
 * rules the way they do in a run.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { FIXTURES, tempDb } from "./helpers.js";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { createMockLLM, createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import {
	messageOriginAnalyzer,
	MESSAGE_ORIGIN_DEF,
	type MessageOriginProperties,
} from "../../src/analyze/analyzers/message-origin/index.js";
import { getAnchoredMessageIds, getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import type { DecisionAnswer, DecisionCaller } from "../../src/analyze/decision-model.js";

const ROOT = path.join(FIXTURES, "text-origin");
const PI_PARENT = "0190aaaa-0000-7000-8000-000000000001";
const CLAUDE = "c0ffee00-0000-4000-a000-000000000001";
const CLAUDE_CHILD = "agent-a0001";

async function withSync(check: (db: AsyncDatabase) => Promise<void>): Promise<void> {
	const { db, close } = await tempDb();
	try {
		const sync = await runSync(db, [new PiFileSource(path.join(ROOT, "pi")), new ClaudeFileSource(path.join(ROOT, "claude"))]);
		assert.deepEqual(sync.errors, []);
		await check(db);
	} finally {
		await close();
	}
}

async function run(db: AsyncDatabase, sessionId: string, opts: { decide?: DecisionCaller; config?: Record<string, unknown> } = {}) {
	const framework = new AnalyzerFramework({
		db,
		llm: opts.decide ? createMockLLM().caller : createThrowingLLM("message-origin must not call the generative model"),
		decide: opts.decide,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: opts.config ? { [MESSAGE_ORIGIN_DEF.id]: opts.config } : undefined,
	});
	await framework.register(turnPairCoreAnalyzer);
	await framework.register(messageOriginAnalyzer);
	return framework.run(sessionId);
}

async function nodes(db: AsyncDatabase, sessionId: string): Promise<Map<string, MessageOriginProperties>> {
	const rows = await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, sessionId);
	return new Map(rows.map((n) => [(JSON.parse(n.content_json) as MessageOriginProperties).user_message_id, JSON.parse(n.content_json) as MessageOriginProperties]));
}

function labelOf(found: Map<string, MessageOriginProperties>, id: string): string {
	const node = found.get(id);
	assert.ok(node, `expected a node for ${id}; got ${[...found.keys()].join(", ")}`);
	return `${node.origin}/${node.rule}`;
}

describe("message-origin", () => {
	it("labels each pi turn once, by the rule that decided it", () =>
		withSync(async (db) => {
			await run(db, PI_PARENT);
			const found = await nodes(db, PI_PARENT);
			assert.equal(labelOf(found, "p01"), "typed/no-marker");
			assert.equal(labelOf(found, "p03"), "typed/no-marker", "a quoted line with a reply is the person's reply");
			assert.equal(labelOf(found, "p05"), "pasted/pasted-block");
			assert.equal(labelOf(found, "p07"), "agent/signature");
			assert.equal(labelOf(found, "p09"), "notification/pi-entry");
			assert.equal(found.size, 7, "one node per turn-starting message");
		}));

	it("labels each Claude Code turn, and a child agent's prompts", () =>
		withSync(async (db) => {
			await run(db, CLAUDE);
			const found = await nodes(db, CLAUDE);
			assert.equal(labelOf(found, "c01"), "typed/no-marker");
			assert.equal(labelOf(found, "c03"), "notification/compaction");
			assert.equal(labelOf(found, "c09"), "agent/signature");
			assert.equal(labelOf(found, "c11"), "notification/harness-block");
			await run(db, CLAUDE_CHILD);
			assert.equal(labelOf(await nodes(db, CLAUDE_CHILD), "a01"), "agent/child-session");
		}));

	it("makes no node and no model call twice: a second run changes nothing", () =>
		withSync(async (db) => {
			await run(db, PI_PARENT);
			const before = (await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, PI_PARENT)).length;
			await run(db, PI_PARENT);
			assert.equal((await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, PI_PARENT)).length, before);
		}));

	it("anchors each node to its message, so a consumer joins on the message id", () =>
		withSync(async (db) => {
			await run(db, PI_PARENT);
			const anchored = await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, PI_PARENT);
			const messages = (await Promise.all(anchored.map((n) => getAnchoredMessageIds(db, n.id)))).flat();
			assert.deepEqual(new Set(messages), new Set((await nodes(db, PI_PARENT)).keys()));
		}));
});

describe("message-origin undecided messages", () => {
	/** A decision model that always answers `author` and `copied` as given. */
	function answering(author: string, p: number, copied: number): ReturnType<typeof createMockDecisionModel> {
		return createMockDecisionModel({
			responder: (): Record<string, DecisionAnswer> => ({
				author: { type: "choice", choice: author, confidence: p, probabilities: { [author]: p } },
				copied: { type: "noul", noul: copied },
			}),
		});
	}

	// The fixtures hold no undecided message, so a probe-like operator remark is written into a session of its own.
	async function withUndecided(check: (db: AsyncDatabase, sessionId: string) => Promise<void>): Promise<void> {
		const { makeTempRoot, writeJsonl, piSessionFileName } = await import("./helpers.js");
		const { root, cleanup } = makeTempRoot("message-origin-");
		const id = "0190bbbb-0000-7000-8000-000000000009";
		writeJsonl(path.join(root, "--home-user--demo"), piSessionFileName(id), [
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-03-01T10:00:00.000Z", cwd: "/home/user/demo" }),
			JSON.stringify({ type: "message", id: "u01", parentId: null, timestamp: "2026-03-01T10:00:01.000Z", message: { role: "user", content: "The operator says the login is done, please resume the check." } }),
			JSON.stringify({ type: "message", id: "u02", parentId: "u01", timestamp: "2026-03-01T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
		]);
		const { db, close } = await tempDb();
		try {
			const sync = await runSync(db, [new PiFileSource(root)]);
			assert.deepEqual(sync.errors, []);
			await check(db, id);
		} finally {
			await close();
			cleanup();
		}
	}

	it("keeps the provisional label and says it is undecided when no decision model is configured", () =>
		withUndecided(async (db, id) => {
			await run(db, id);
			const node = (await nodes(db, id)).get("u01")!;
			assert.deepEqual([node.origin, node.rule, node.decided], ["typed", "undecided", false]);
			assert.deepEqual(node.suspicions, ["operator-third-person"]);
		}));

	it("asks the decision model once, with the message alone as its state, and records its distribution", () =>
		withUndecided(async (db, id) => {
			const model = answering("agent", 0.9, 0.1);
			await run(db, id, { decide: model.caller, config: { decisionModel: "jev/jev-1.13.0", minConfidence: 0.6 } });
			assert.equal(model.calls.length, 1);
			assert.deepEqual(model.calls[0]!.state, { message: { text: "The operator says the login is done, please resume the check.", shortened: false } });
			assert.deepEqual(Object.keys(model.calls[0]!.questions).sort(), ["author", "copied"]);
			const node = (await nodes(db, id)).get("u01")!;
			assert.deepEqual([node.origin, node.rule, node.decided], ["agent", "decision-model", true]);
			assert.equal(node.probabilities?.["author"]?.["agent"], 0.9);
		}));

	it("leaves the message undecided when the model is less sure than minConfidence", () =>
		withUndecided(async (db, id) => {
			const model = answering("agent", 0.4, 0.1);
			await run(db, id, { decide: model.caller, config: { decisionModel: "jev/jev-1.13.0", minConfidence: 0.6 } });
			const node = (await nodes(db, id)).get("u01")!;
			assert.deepEqual([node.origin, node.rule, node.decided], ["typed", "undecided", false]);
			assert.ok(node.probabilities, "the distribution is kept so a reader can see how close the call was");
		}));

	it("never asks the model about a message a rule decided", () =>
		withSync(async (db) => {
			const model = answering("agent", 0.9, 0.1);
			await run(db, PI_PARENT, { decide: model.caller, config: { decisionModel: "jev/jev-1.13.0", minConfidence: 0.6 } });
			assert.equal(model.calls.length, 0);
		}));
});
