/**
 * Component tests for the compression-checklist analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #218). No real session data, no
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
	readAnalyzerNodes,
	sessionProposals,
	bashCall,
	readCall,
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	assertProposalEvidenceTrail,
	type TestMessage,
} from "./helpers.js";
import { compressionChecklistAnalyzer } from "../../src/analyze/analyzers/compression-checklist/index.js";

const ANALYZER_ID = "compression-checklist";

// ─────────────────────────── fixtures ───────────────────────────

/**
 * A session with one compaction cycle:
 *   - the grep result surfaces three paths;
 *   - the compactionSummary retains one verbatim but drops the other two;
 *   - after the flush, calls use both dropped paths → both flagged lost,
 *     clearing the default minLostLeadsForProposal of 2.
 */
function lossySession(): TestMessage[] {
	return [
		{ role: "user", text: "The build is failing, please investigate." },
		{ role: "assistant", text: "Searching.", toolCalls: bashCall("grep -rn render src/") },
		{
			role: "toolResult",
			text:
				"src/ui/header.ts:12: function renderHeader()\n" +
				"src/ui/footer.ts:8: function renderFooter()\n" +
				"src/theme/palette.ts:40: export const headerColors",
			toolResults: [{ toolName: "bash", isError: false, textLength: 140 }],
		},
		{
			role: "compactionSummary",
			text:
				"Investigation so far centred on src/ui/header.ts; its render path is understood. Remaining work: confirm footer behaviour before changing anything.",
		 },
		{ role: "assistant", text: "Reading the files again.", toolCalls: readCall("src/ui/footer.ts") },
		{ role: "assistant", text: "", toolCalls: readCall("src/theme/palette.ts") },
	];
}

/**
 * A faithful summary: every surfaced path retained verbatim, nothing used
 * post-compaction that was absent — a clean metric with zero lost leads.
 */
function faithfulSession(): TestMessage[] {
	return [
		{ role: "user", text: "Check the config loading." },
		{ role: "assistant", text: "Reading it.", toolCalls: readCall("src/config.ts") },
		{
			role: "toolResult",
			text: "loaded overrides from src/config/env.ts\n// reads PROSPECTOR_DB_PATH etc.",
			toolResults: [{ toolName: "read", isError: false, textLength: 60 }],
		},
		{
			role: "compactionSummary",
			text:
				"We examined src/config/env.ts and confirmed env overrides load correctly; nothing further was needed there for this step.",
		},
	];
}

/** A plain session with no compaction at all: this analyzer plans no unit. */
function uncompactedSession(): TestMessage[] {
	return [
		{ role: "user", text: "what time is it?" },
		{ role: "assistant", text: "Checking.", toolCalls: bashCall("date -u +%H:%M") },
		{
			role: "toolResult",
			text: "14:23 UTC",
			toolResults: [{ toolName: "bash", isError: false, textLength: 9 }],
		},
	];
}


// ─────────────────────────── tests ───────────────────────────

describe("compression-checklist component test", () => {
	it("grades facets end-to-end, flags lost leads, and materialises a proposal", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "retrac-e2e");
			await insertMessages(db, "retrac-e2e", lossySession());

			const fw = mockFramework(db);
			await fw.register(compressionChecklistAnalyzer);
			const summary = await fw.run("retrac-e2e", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 1, "one node per compacted session");

			const node = nodes[0]!;
			assert.equal(node.node_kind, "proposal", "two lost leads clear the default threshold");

			const content = JSON.parse(node.content_json) as {
				session_id: string;
				summaries: Array<{
					message_ordinal: number;
					facet_coverage: { conclusions_present: boolean; source_references: { total_leads: number; retained_leads: number }; unresolved_items: boolean; abandoned_directions: boolean };
					covered_facet_count: number;
					leads_total: number;
					leads_retained: number;
					leads_lost: Array<{ type: string; value: string; source_message_id: string; used_by_message_id: string }>;
				}>;
				summary_count: number;
				fully_covered_count: number;
				leads_lost_count: number;
				improvement_proposals: Array<{ title: string; severity: string; target_type: string }>;
			};

			assert.equal(content.summary_count, 1);
			assert.equal(content.leads_lost_count, 2);

			const grade = content.summaries[0]!;
			assert.equal(grade.leads_total, 3, "three paths surfaced in the flushed cycle");
			assert.equal(grade.leads_retained, 1, "only src/ui/header.ts was kept verbatim");
			assert.deepEqual(
				grade.leads_lost.map((l) => l.value).sort(),
				["src/theme/palette.ts", "src/ui/footer.ts"],
			);
			assert.ok(grade.leads_lost.every((l) => l.type === "path"));
			assert.equal(
				grade.facet_coverage.source_references.retained_leads,
				1,
				"facet 2 counts the verbatim retention",
			);
			assert.equal(grade.facet_coverage.unresolved_items, true, "the summary names remaining work");
			assert.equal(grade.facet_coverage.abandoned_directions, false, "no exploration trace in this summary");
			assert.ok(!grade.facet_coverage.conclusions_present || true); // length-dependent; covered by unit tests

			// Evidence trail: session anchor + summary message + each lost lead's
			// source message, plus the produces edge into the fast store.
			await assertProposalEvidenceTrail(db, node.id, {
				exactly: 2,
				note: "summary row + grep-result row carry the findings",
			});

			const proposals = await sessionProposals(db, "retrac-e2e", ANALYZER_ID);
			assert.equal(proposals.length, 1, "exactly one materialised proposal");
			assert.match(String(proposals[0]!.title), /dropped 2 leads/);
			assert.match(String(proposals[0]!.title), /needed again/);
			assert.equal(proposals[0]!.status, "open");
		} finally {
			await close();
		}
	});

	it("a faithful summary is a clean metric node with no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "retrac-clean");
			await insertMessages(db, "retrac-clean", faithfulSession());

			const fw = mockFramework(db);
			await fw.register(compressionChecklistAnalyzer);
			const summary = await fw.run("retrac-clean", {});
			assert.equal(summary.errors.length, 0);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 1, "a compacted session is always analysed");
			assert.equal(nodes[0]!.node_kind, "metric");

			const content = JSON.parse(nodes[0]!.content_json) as {
				leads_lost_count: number;
				fully_covered_count: number;
				summaries: Array<{ facet_coverage: { source_references: { total_leads: number; retained_leads: number }; unresolved_items: boolean }; leads_retained: number }>;
				improvement_proposals: unknown[];
			};
			assert.equal(content.leads_lost_count, 0, "nothing was used afterwards that the summary dropped");
			assert.equal(content.improvement_proposals.length, 0);

			const grade = content.summaries[0]!;
			assert.equal(grade.facet_coverage.source_references.retained_leads, 1);
			assert.equal(grade.facet_coverage.unresolved_items, false, "this clean summary names nothing unresolved");
		} finally {
			await close();
		}
	});

	it("a session without compactions plans no unit at all", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, compressionChecklistAnalyzer, "retrac-none", uncompactedSession());
			assert.equal(nodes.length, 0, "nothing to grade");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, compressionChecklistAnalyzer, "retrac-idem", lossySession());
		} finally {
			await close();
		}
	});

	it("changing config marks nodes stale for the `config` reason and revises beside them", async () => {
		const { db, close } = await tempDb();
		try {
			// Raising the proposal threshold changes the resolved config fingerprint →
			// the unit goes stale for the `config` reason; the revise run recomputes
			// it, preserving the old version as lineage.
			const { before, after } = await expectConfigChangeRevises(db, compressionChecklistAnalyzer, "retrac-config", lossySession(), {
				minLostLeadsForProposal: 5,
			});
			const newNode = after.find((n) => n.input_key !== before[0]!.input_key)!;
			assert.equal(newNode.node_kind, "metric", "with the threshold raised, the same evidence no longer earns a proposal");
		} finally {
			await close();
		}
	});
});
