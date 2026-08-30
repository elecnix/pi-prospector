/**
 * Component tests for the language-mismatch analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #151). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction and
 * prove the analyzer stays deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	mockFrameworkWithOverrides,
	readAnalyzerNodes,
	nodeEdges,
	sessionProposals,
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	type TestMessage,
} from "./helpers.js";
import { languageMismatchAnalyzer } from "../../src/analyze/analyzers/language-mismatch/index.js";

const ANALYZER_ID = "language-mismatch";

// Long synthetic sentences, well past the 40-letter default minimum.
const FR = "Pourquoi le serveur refuse-t-il les connexions depuis ce matin alors que rien n'a changé dans la configuration ?";
const FR2 = "Merci peux-tu vérifier les journaux et me dire ce qui bloque exactement dans le déploiement d'aujourd'hui ?";
const RU = "Похоже проблема в конфигурации сети надо проверить настройки файрвола и перезапустить сервис.";
const RU2 = "Сейчас посмотрю журналы и скажу что именно вызывает ошибку подключения к базе данных приложения.";
const EN = "And here is a perfectly ordinary reply written in plain English words for an English question.";


/** Two turns: French questions answered in Russian — recurrence clears the default proposal threshold of 2. */
function mismatchedSession(): TestMessage[] {
	return [
		{ role: "user", text: FR },
		{ role: "assistant", text: RU },
		{ role: "user", text: FR2 },
		{ role: "assistant", text: RU2 },
	];
}

/** English throughout: judged, but with zero mismatches. */
function cleanSession(): TestMessage[] {
	return [
		{ role: "user", text: "Why does the build fail every time the cache directory is missing on this machine here?" },
		{ role: "assistant", text: EN },
	];
}

/** Short texts everywhere: nothing judgable, so no unit is planned at all. */
function tinySession(): TestMessage[] {
	return [
		{ role: "user", text: "ok" },
		{ role: "assistant", text: "sure" },
		{ role: "user", text: "fix it" },
		{ role: "assistant", text: "done" },
	];
}

/** A French conversation whose compaction summary switches to Cyrillic. The
 * turns themselves are too short to judge, so compaction is the only axis. */
function compactedSession(): TestMessage[] {
	return [
		{ role: "user", text: FR },
		{ role: "assistant", text: "Je regarde ça." },
		{
			role: "compactionSummary",
			text: RU,
		},
		{ role: "user", text: FR2 },
		{ role: "assistant", text: "Bien sûr." },
	];
}

// ─────────────────────────── tests ───────────────────────────

describe("language-mismatch component test", () => {
	it("flags recurring turn mismatches and materialises a proposal anchored to the user messages", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "lang-e2e");
			const ids = await insertMessages(db, "lang-e2e", mismatchedSession());

			const fw = mockFramework(db);
			await fw.register(languageMismatchAnalyzer);
			const summary = await fw.run("lang-e2e", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 1, "one session-level node");
			assert.equal(nodes[0]!.node_kind, "proposal", "two mismatches clear the default threshold");

			const content = JSON.parse(nodes[0]!.content_json) as {
				session_id: string;
				turns: Array<{ pair_index: number; user_message_id: string; user_script: string; assistant_script: string; mismatched: boolean }>;
				judged_turn_count: number;
				mismatched_turn_count: number;
				compaction_checked_count: number;
				improvement_proposals: Array<{ title: string; severity: string; target_type: string }>;
			};
			assert.equal(content.judged_turn_count, 2);
			assert.equal(content.mismatched_turn_count, 2);
			assert.equal(content.compaction_checked_count, 0);
			assert.ok(content.turns.every((t) => t.mismatched && t.user_script === "latin" && t.assistant_script === "cyrillic"));
			assert.deepEqual(
				content.turns.map((t) => t.user_message_id).sort(),
				[ids[0], ids[2]].sort(),
				"verdicts name the two user messages",
			);
			assert.equal(content.improvement_proposals.length, 1);
			assert.equal(content.improvement_proposals[0]!.severity, "friction");

			// Evidence trail: session anchor + each judged turn's user message +
			// the produces edge into the fast store.
			const edges = await nodeEdges(db, nodes[0]!.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message").length, 2);
			assert.ok(edges.find((e) => e["edge_kind"] === "produces"), "proposal node must produce its proposal");

			const proposals = await sessionProposals(db, "lang-e2e", ANALYZER_ID);
			assert.equal(proposals.length, 1, "exactly one materialised proposal");
			assert.match(String(proposals[0]!.title), /wrong language 2 times/);
			assert.equal(proposals[0]!.status, "open");
		} finally {
			await close();
		}
	});

	it("a same-language session is a clean metric node with no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "lang-clean");
			await insertMessages(db, "lang-clean", cleanSession());

			const fw = mockFramework(db);
			await fw.register(languageMismatchAnalyzer);
			const summary = await fw.run("lang-clean", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as { mismatched_turn_count: number; improvement_proposals: unknown[] };
			assert.equal(content.mismatched_turn_count, 0);
			assert.equal(content.improvement_proposals.length, 0);

			const proposals = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'language-mismatch'")
				.get()) as unknown as { c: number };
			assert.equal(proposals.c, 0);
		} finally {
			await close();
		}
	});

	it("a session where nothing is judgable plans no unit at all", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, languageMismatchAnalyzer, "lang-tiny", tinySession());
			assert.equal(nodes.length, 0, "nothing to judge");
		} finally {
			await close();
		}
	});

	it("a compaction summary in a different script than its conversation is flagged and anchored", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "lang-compaction");
			await insertMessages(db, "lang-compaction", compactedSession());

			const fw = mockFramework(db);
			await fw.register(languageMismatchAnalyzer);
			const summary = await fw.run("lang-compaction", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric", "one mismatch below the default threshold of 2 earns no proposal");

			const content = JSON.parse(nodes[0]!.content_json) as {
				turns: Array<{ mismatched: boolean }>;
				compactions: Array<{ message_id: string; conversation_script: string; summary_script: string; mismatched: boolean }>;
				mismatched_compaction_count: number;
				improvement_proposals: unknown[];
			};
			assert.equal(content.turns.length, 0, "the short turns are skipped, not guessed at");
			assert.equal(content.compactions.length, 1);
			assert.equal(content.mismatched_compaction_count, 1);
			assert.equal(content.improvement_proposals.length, 0);
			const c = content.compactions[0]!;
			assert.equal(c.conversation_script, "latin");
			assert.equal(c.summary_script, "cyrillic");
			assert.equal(c.mismatched, true);

			const edges = (await nodeEdges(db, nodes[0]!.id)).filter(
				(e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message",
			);
			assert.deepEqual(edges.map((e) => e["to_ref_id"]), [c.message_id], "the finding anchors to the compaction entry itself");
		} finally {
			await close();
		}
	});

	it("checkCompaction: false skips compaction-only sessions entirely (stale/config lineage preserved)", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "lang-no-compaction-check");
			await insertMessages(db, "lang-no-compaction-check", compactedSession());

			const fw = mockFrameworkWithOverrides(db, ANALYZER_ID, { checkCompaction: false });
			await fw.register(languageMismatchAnalyzer);
			const summary = await fw.run("lang-no-compaction-check", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 0, "with compaction checks off, nothing else in this session is judgable");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, languageMismatchAnalyzer, "lang-idem", mismatchedSession());
		} finally {
			await close();
		}
	});

	it("raising minMismatchesForProposal marks the node stale for `config` and revises beside it", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, languageMismatchAnalyzer, "lang-config", mismatchedSession(), {
				minMismatchesForProposal: 5,
			});
			assert.equal(before[0]!.node_kind, "proposal");

			const newNode = after.find((n) => n.input_key !== before[0]!.input_key);
			assert.ok(newNode);
			assert.equal(newNode!.node_kind, "metric", "with the threshold raised, two mismatches no longer earn a proposal");
		} finally {
			await close();
		}
	});
});
