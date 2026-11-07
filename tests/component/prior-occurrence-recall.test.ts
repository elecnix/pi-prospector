import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM, type MockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { selectPriorOccurrences } from "../../src/analyze/analyzers/session-overview/recall.js";
import { DEFAULT_SESSION_OVERVIEW_CONFIG } from "../../src/analyze/analyzers/session-overview/config.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import type { LLMRequest } from "../../src/analyze/types.js";

const ON = { ...DEFAULT_SESSION_OVERVIEW_CONFIG, recallPriorOccurrences: true };
const T = (n: number): string => new Date(Date.UTC(2026, 0, n)).toISOString();

async function seedEarlier(db: AsyncDatabase, id: string, day: number, text: string): Promise<void> {
	await insertSession(db, id, `/tmp/${id}.jsonl`, "/repo/app");
	await insertMessages(db, id, [
		{ id: `${id}-u`, role: "user", text, timestamp: T(day) },
		{ id: `${id}-a`, role: "assistant", text: "understood", timestamp: T(day) },
	]);
}

async function seedTarget(db: AsyncDatabase, id: string, day: number): Promise<void> {
	await insertSession(db, id, `/tmp/${id}.jsonl`, "/repo/app");
	await insertMessages(db, id, [
		{ id: `${id}-m0`, role: "user", text: "fix the login bug", timestamp: T(day) },
		{ id: `${id}-m1`, role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }], timestamp: T(day) },
		{ id: `${id}-m2`, role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }], timestamp: T(day) },
		{ id: `${id}-m3`, role: "user", text: "no, that's wrong, use the authentication module instead", timestamp: T(day) },
		{ id: `${id}-m4`, role: "assistant", text: "understood, fixing now", timestamp: T(day) },
	]);
}

const QUERY = [{ messageId: "q", text: "no, that's wrong, use the authentication module instead" }];

describe("selectPriorOccurrences", () => {
	it("returns raw text of earlier sessions only, oldest first", async () => {
		const { db, close } = await tempDb();
		try {
			await seedEarlier(db, "old-b", 3, "always use the authentication module for login");
			await seedEarlier(db, "old-a", 2, "the authentication module is the right place, not utils");
			await seedEarlier(db, "later", 20, "use the authentication module please");
			await seedEarlier(db, "unrelated", 4, "bump the dependency versions");
			await seedTarget(db, "target", 10);

			const r = await selectPriorOccurrences(db, "target", QUERY, ON);
			assert.equal(r.unavailable, null);
			assert.deepEqual(r.windows.map((w) => w.sessionId), ["old-a", "old-b"], "earlier only, chronological, no later/unrelated/self");
			assert.equal(r.windows[0]!.text, "the authentication module is the right place, not utils", "raw, unsummarised");
			assert.equal(r.sourceRefs.length, 2);
			assert.ok(r.sourceRefs.every((s) => s.kind === "message" && s.id.includes(":")));
		} finally {
			await close();
		}
	});

	it("shows a complete message, and only the best window of one over the budget", async () => {
		const { db, close } = await tempDb();
		try {
			const filler = "lorem ipsum dolor sit amet ".repeat(80);
			const short = "first line\nuse the authentication module\nlast line";
			const long = `${filler}use the authentication module ${filler}`;
			await seedEarlier(db, "short-one", 2, short);
			await seedEarlier(db, "long-one", 3, long);
			await seedTarget(db, "target", 10);

			const r = await selectPriorOccurrences(db, "target", QUERY, ON);
			const byId = new Map(r.windows.map((w) => [w.messageId, w]));
			assert.equal(byId.get("short-one-u")?.text, short, "whole message, not a clipped window");
			assert.equal(byId.get("short-one-u")?.expanded, true);
			const over = byId.get("long-one-u");
			assert.equal(over?.expanded, false);
			assert.ok(over && over.text.length <= ON.recallWindowChars && over.text.includes("authentication module"), "best window of the over-budget message");
		} finally {
			await close();
		}
	});

	it("shows a message once even when two friction turns match it", async () => {
		const { db, close } = await tempDb();
		try {
			await seedEarlier(db, "old", 2, "the authentication module handles login and the session token");
			await seedTarget(db, "target", 10);
			const two = [
				{ messageId: "q1", text: "use the authentication module" },
				{ messageId: "q2", text: "the session token is wrong" },
			];
			const r = await selectPriorOccurrences(db, "target", two, ON);
			assert.deepEqual(r.windows.map((w) => w.messageId), ["old-u"]);
		} finally {
			await close();
		}
	});

	it("is off unless enabled, and says so loudly when it cannot run", async () => {
		const { db, close } = await tempDb();
		try {
			await seedEarlier(db, "old", 2, "use the authentication module");
			await seedTarget(db, "target", 10);
			assert.equal((await selectPriorOccurrences(db, "target", QUERY, DEFAULT_SESSION_OVERVIEW_CONFIG)).windows.length, 0);

			await insertSession(db, "undated", "/tmp/undated.jsonl", "/repo/app");
			await db.prepare("INSERT INTO messages (id, session_id, source, role, content_text) VALUES ('u1','undated','pi','user','x')").run();
			const r = await selectPriorOccurrences(db, "undated", QUERY, ON);
			assert.equal(r.windows.length, 0);
			assert.match(r.unavailable ?? "", /no timestamped messages/);
		} finally {
			await close();
		}
	});

	it("does not choke on FTS operators in the friction text", async () => {
		const { db, close } = await tempDb();
		try {
			await seedEarlier(db, "old", 2, "NEAR the authentication module");
			await seedTarget(db, "target", 10);
			const r = await selectPriorOccurrences(db, "target", [{ messageId: "q", text: 'NOT "authentication" AND (module OR near*)' }], ON);
			assert.equal(r.windows.length, 1);
		} finally {
			await close();
		}
	});
});

describe("session-overview with recall", () => {
	function respond(req: LLMRequest): string {
		const sys = req.system ?? "";
		if (req.tool?.name === "classify_term") return JSON.stringify({ polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "x" });
		if (sys.includes("classify a single turn")) {
			return JSON.stringify({ sentiment: "frustrated", friction_type: "wrong_approach", is_genuine_correction: true, severity: "high", rationale: "r" });
		}
		return JSON.stringify({ session_summary: "S", friction_points: [], key_positive_signals: [], improvement_proposals: [] });
	}

	async function run(db: AsyncDatabase, config: object): Promise<{ mock: MockLLM; nodeId: string | undefined }> {
		const mock = createMockLLM({ responder: respond, tokensPerCall: 100, costPerCall: 0.001 });
		const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS, configOverrides: { "session-overview": config as Record<string, unknown> } });
		await registerDefaults(fw);
		const summary = await fw.run("target", {});
		assert.equal(summary.errors.length, 0, summary.errors.join("; "));
		const row = (await db.prepare("SELECT id FROM analysis_nodes WHERE analyzer_id = 'session-overview' AND session_id = 'target'").get()) as { id: string } | undefined;
		return { mock, nodeId: row?.id };
	}

	it("hands the synthesiser the raw window and records a recalls edge per message", async () => {
		const { db, close } = await tempDb();
		try {
			await seedEarlier(db, "old", 2, "the authentication module is the right place");
			await seedTarget(db, "target", 10);
			const { mock, nodeId } = await run(db, ON);
			assert.ok(nodeId, "overview node written");

			const reduce = mock.calls.find((c) => (c.system ?? "").includes("You analyse a coding-agent session"));
			assert.ok(reduce, "reduce call made");
			assert.match(reduce.user, /PRIOR OCCURRENCES:/);
			assert.match(reduce.user, /the authentication module is the right place/);
			assert.match(reduce.user, /NOT every occurrence/);

			const edges = (await db.prepare("SELECT to_ref_kind, to_ref_id FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'recalls'").all(nodeId)) as Array<{ to_ref_kind: string; to_ref_id: string }>;
			assert.deepEqual(edges, [{ to_ref_kind: "message", to_ref_id: "old-u" }]);
		} finally {
			await close();
		}
	});

	it("leaves the prompt and identity untouched when disabled", async () => {
		const { db, close } = await tempDb();
		try {
			await seedEarlier(db, "old", 2, "the authentication module is the right place");
			await seedTarget(db, "target", 10);
			const { mock } = await run(db, DEFAULT_SESSION_OVERVIEW_CONFIG);
			const reduce = mock.calls.find((c) => (c.system ?? "").includes("You analyse a coding-agent session"));
			assert.ok(reduce);
			assert.doesNotMatch(reduce.user, /PRIOR OCCURRENCES/);
		} finally {
			await close();
		}
	});
});
