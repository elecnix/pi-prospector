/**
 * Unit tests for the compression-checklist scorer and lost-lead diff (issue
 * #218).
 *
 * Pure functions over hand-written synthetic message rows — no database, no
 * LLM, no real session content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countCoveredFacets, gradeSummaryFacets } from "../../src/analyze/analyzers/compression-checklist/checklist.js";
import { scanSessionChecklist } from "../../src/analyze/analyzers/compression-checklist/detect.js";
import {
	DEFAULT_COMPRESSION_CHECKLIST_CONFIG,
	type CompressionChecklistConfig,
} from "../../src/analyze/analyzers/compression-checklist/config.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG: CompressionChecklistConfig = { ...DEFAULT_COMPRESSION_CHECKLIST_CONFIG };

// ──────────────────── message-row helpers ────────────────────

let seq = 0;

function bareRow(id: string, role: string, text: string | null): MessageRow {
	seq += 1;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
		role,
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
	};
}

function assistantWithCalls(id: string, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): MessageRow {
	const row = bareRow(id, "assistant", null);
	return { ...row, tool_calls: JSON.stringify(calls) };
}

function toolResultRow(id: string, callId: string, text: string, isError = false): MessageRow {
	const row = bareRow(id, "toolResult", text);
	return {
		...row,
		tool_results: JSON.stringify([{ toolCallId: callId, toolName: "bash", isError, textLength: text.length }]),
	};
}

// ──────────────────── checklist scoring ────────────────────

describe("gradeSummaryFacets", () => {
	it("flags a summary that names unresolved items", () => {
		const text = "We fixed the parser bug and the tests pass. Remaining work: the auth token refresh path is unresolved and needs review before Friday.";
		const coverage = gradeSummaryFacets(text, []);
		assert.equal(coverage.unresolved_items, true);
		assert.equal(coverage.conclusions_present, true);
	});

	it("scores false for unresolved and abandoned on a conclusions-only summary", () => {
		const text = "The migration completed successfully. All 42 records moved to the new schema, and the verification queries confirm every row matches.";
		const coverage = gradeSummaryFacets(text, []);
		assert.equal(coverage.conclusions_present, true);
		assert.equal(coverage.unresolved_items, false);
		assert.equal(coverage.abandoned_directions, false);
	});

	it("flags abandoned directions from an explicit cue", () => {
		const text = "The cache layer was reverted after the invalidation bugs. We settled on direct SQL instead of the ORM approach for the hot path.";
		assert.equal(gradeSummaryFacets(text, []).abandoned_directions, true);
	});

	it("flags abandoned directions from a tried-X-but-Y span without lexicon words", () => {
		const text = "For batching we tried grouping writes by table but the ordering guarantees broke under concurrency.";
		assert.equal(gradeSummaryFacets(text, []).abandoned_directions, true);
	});

	it("counts verbatim source-reference retention per surfaced lead", () => {
		const leads = [
			{ type: "path" as const, value: "/src/auth/login.ts" },
			{ type: "url" as const, value: "https://docs.example.com/guide" },
			{ type: "path" as const, value: "/src/auth/session.ts" },
			{ type: "path" as const, value: "/src/auth/login.ts" }, // duplicate — deduped
		];
		const text = "Auth work continues in /src/auth/login.ts; see the summary of findings below.";
		const coverage = gradeSummaryFacets(text, leads);
		assert.deepEqual(coverage.source_references, { total_leads: 3, retained_leads: 1 });
	});

	it("treats zero surfaced leads as vacuous source coverage", () => {
		const coverage = gradeSummaryFacets("A short note.", []);
		assert.deepEqual(coverage.source_references, { total_leads: 0, retained_leads: 0 });
	});

	it("requires substance before crediting facet 1", () => {
		const coverage = gradeSummaryFacets("done.", []);
		assert.equal(coverage.conclusions_present, false);
	});
});

describe("countCoveredFacets", () => {
	it("counts all four when everything is covered", () => {
		const text = "Remaining work is unresolved auth refresh; we tried Redis but reverted it.";
		const coverage = gradeSummaryFacets(text, [{ type: "path", value: "/src/auth/login.ts" }]);
		assert.equal(coverage.conclusions_present, true);
		assert.equal(coverage.unresolved_items, true);
		assert.equal(coverage.abandoned_directions, true);
		// Retention counted separately below.
		const withRetention = gradeSummaryFacets(`${text} /src/auth/login.ts stays open.`, [
			{ type: "path", value: "/src/auth/login.ts" },
		]);
		assert.equal(countCoveredFacets(withRetention), 4);
	});

	it("credits only the two earned facets to a conclusions-only summary", () => {
		const coverage = gradeSummaryFacets(
			"The refactor landed cleanly; all checks pass and no follow-up remains.",
			[],
		);
		assert.equal(countCoveredFacets(coverage), 2, "facet 1 plus vacuous source coverage; naming nothing unresolved or abandoned scores false on facet 3");
	});
});

// ──────────────────── lost-lead detection ────────────────────

/**
 * One compaction cycle:
 *   grep result surfaces /src/auth/login.ts and https://docs.example.com/guide
 *   summary retains the URL (verbatim) but drops the path
 *   post-compaction read call uses the dropped path → flagged
 *   post-compaction webfetch uses the retained URL → NOT flagged (it was retained)
 */
function lossCycle(): MessageRow[] {
	return [
		bareRow("u1", "user", "Investigate the login failure."),
		assistantWithCalls("a1", [{ id: "c1", name: "bash", arguments: { command: "grep -rn login /src/auth/" } }]),
		toolResultRow(
			"r1",
			"c1",
			"/src/auth/login.ts:42: export async function login()\nsee also https://docs.example.com/guide",
		),
		bareRow(
			"s1",
			"compactionSummary",
			"Login investigation so far used https://docs.example.com/guide. Findings summarised above.",
		),
		assistantWithCalls("a2", [
			{ id: "c2", name: "read", arguments: { file_path: "/src/auth/login.ts" } },
		]),
		assistantWithCalls("a3", [
			{ id: "c3", name: "webfetch", arguments: { url: "https://docs.example.com/guide" } },
		]),
	];
}

describe("scanSessionChecklist", () => {
	it("flags a lead used post-compaction and absent from the summary", () => {
		const grades = scanSessionChecklist(lossCycle(), CONFIG);
		assert.equal(grades.length, 1);
		const g = grades[0]!;
		assert.equal(g.message_id, "s1");
		assert.equal(g.leads_total, 2);
		assert.equal(g.leads_retained, 1);
		assert.equal(g.leads_lost.length, 1);

		const lost = g.leads_lost[0]!;
		assert.equal(lost.type, "path");
		assert.equal(lost.value, "/src/auth/login.ts");
		assert.equal(lost.source_message_id, "r1");
		assert.equal(lost.used_by_message_id, "a2");

		assert.deepEqual(g.facet_coverage.source_references, { total_leads: 2, retained_leads: 1 });
	});

	it("does not flag a lead present verbatim in the summary even when used afterwards", () => {
		const grades = scanSessionChecklist(lossCycle(), CONFIG);
		const values = grades[0]!.leads_lost.map((l) => l.value);
		assert.ok(!values.includes("https://docs.example.com/guide"), "retained URL must not be flagged");
	});

	it("does not flag a dropped lead that was never used again", () => {
		const messages = lossCycle();
		// Replace the post-compaction read with an unrelated one.
		messages[4] = assistantWithCalls("a2", [{ id: "c2", name: "read", arguments: { file_path: "/tmp/notes.md" } }]);
		const grades = scanSessionChecklist(messages, CONFIG);
		assert.equal(grades[0]!.leads_lost.length, 0, "a dropped lead nobody needed was not necessarily lost");
	});

	it("detects a suggested command re-run after compaction", () => {
		const messages: MessageRow[] = [
			assistantWithCalls("a1", [{ id: "c1", name: "bash", arguments: { command: "npm test" } }]),
			toolResultRow("r1", "c1", "failures detected\nRun `npm rebuild` if native deps are stale."),
			bareRow("s1", "compactionSummary", "Tests fail; investigating. Summary continues."),
			assistantWithCalls("a2", [{ id: "c2", name: "bash", arguments: { command: "npm rebuild" } }]),
		];
		const grades = scanSessionChecklist(messages, CONFIG);
		const lost = grades[0]!.leads_lost;
		assert.equal(lost.length, 1);
		assert.equal(lost[0]!.type, "command");
		assert.equal(lost[0]!.value, "npm rebuild");
		assert.equal(lost[0]!.used_by_message_id, "a2");
	});

	it("bounds each summary's grading at the previous flush", () => {
		const messages: MessageRow[] = [
			assistantWithCalls("a1", [{ id: "c1", name: "bash", arguments: { command: "grep -rn x ." } }]),
			toolResultRow("r1", "c1", "hit: /src/early/thing.ts"),
			bareRow("s1", "compactionSummary", "First flush. /src/early/thing.ts noted."),
			assistantWithCalls("a2", [{ id: "c2", name: "bash", arguments: { command: "grep -rn y ." } }]),
			toolResultRow("r2", "c2", "hit: /src/later/other.ts"),
			bareRow("s2", "compactionSummary", "Second flush summarises later findings only."),
			assistantWithCalls("a3", [{ id: "c3", name: "read", arguments: { file_path: "/src/later/other.ts" } }]),
		];
		const grades = scanSessionChecklist(messages, CONFIG);
		assert.equal(grades.length, 2);
		assert.deepEqual(grades[0]!.leads_lost.map((l) => l.value), [], "first summary retained its lead");
		assert.deepEqual(
			grades[0]!.facet_coverage.source_references,
			{ total_leads: 1, retained_leads: 1 },
			"the first cycle's grading sees only the first cycle's results",
		);
		assert.deepEqual(grades[1]!.leads_lost.map((l) => l.value), ["/src/later/other.ts"]);
	});

	it("returns no grades when the session never compacted", () => {
		const messages: MessageRow[] = [
			assistantWithCalls("a1", [{ id: "c1", name: "bash", arguments: { command: "grep -rn x ." } }]),
			toolResultRow("r1", "c1", "hit: /src/auth/login.ts"),
		];
		assert.deepEqual(scanSessionChecklist(messages, CONFIG), []);
	});
});
