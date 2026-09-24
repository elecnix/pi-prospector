/**
 * Component tests for the navigation-efficiency analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #254). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	sessionProposals,
	assertProposalEvidenceTrail,
	type TestMessage,
} from "./helpers.js";
import {
	navigationEfficiencyAnalyzer,
	type NavigationEfficiencyProperties,
} from "../../src/analyze/analyzers/navigation-efficiency/index.js";

const ANALYZER_ID = "navigation-efficiency";

// ─────────────────────────── fixtures ───────────────────────────

let callSeq = 0;
function tool(name: string, args: Record<string, unknown>, isError = false): TestMessage[] {
	const id = `nav${callSeq++}`;
	return [
		{ role: "assistant", stopReason: "toolUse", toolCalls: [{ id, name, arguments: args }] },
		{ role: "toolResult", text: isError ? "no match" : "ok", toolResults: [{ toolCallId: id, toolName: name, isError, textLength: 2 }] },
	];
}

/**
 * A session that finds the right file the wrong way: it scrolls one file in
 * overlapping slices, keeps backing out of deep files to `src` or a top-level
 * config file and diving again, and keeps returning to files it already read
 * before it finally patches one of them.
 */
function wanderingSessionMessages(): TestMessage[] {
	return [
		{ role: "user", text: "The retry limit is ignored; please fix it." },
		...tool("read", { path: "src/net/http/client.ts", offset: 100, limit: 40 }),
		...tool("read", { path: "src/net/http/client.ts", offset: 110, limit: 40 }),
		...tool("read", { path: "src/net/http/client.ts", offset: 120, limit: 60 }),
		...tool("ls", { path: "src" }),
		...tool("read", { path: "src/core/retry/policy.ts" }),
		...tool("read", { path: "src/config.ts" }),
		...tool("bash", { command: "ls src" }),
		...tool("read", { path: "src/core/queue/worker.ts" }),
		...tool("read", { path: "src/config.ts" }),
		...tool("read", { path: "src/core/retry/policy.ts", offset: 1, limit: 30 }),
		...tool("read", { path: "src/config.ts" }),
		...tool("read", { path: "src/core/retry/policy.ts", offset: 10, limit: 20 }),
		...tool("edit", { path: "src/core/retry/policy.ts" }),
	];
}

/** Linear work: list, read, edit, read the next file, edit it. */
function linearSessionMessages(): TestMessage[] {
	return [
		{ role: "user", text: "Rename the helper in both modules." },
		...tool("ls", { path: "src" }),
		...tool("read", { path: "src/a.ts" }),
		...tool("edit", { path: "src/a.ts" }),
		...tool("read", { path: "src/b.ts" }),
		...tool("edit", { path: "src/b.ts" }),
	];
}

// ─────────────────────────── tests ───────────────────────────

describe("navigation-efficiency component tests", () => {
	it("detects the patterns end-to-end, emits a proposal node, and materialises it", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, navigationEfficiencyAnalyzer, "nav-e2e", wanderingSessionMessages());
			assert.equal(nodes.length, 1, "one node per session");
			const node = nodes[0]!;
			assert.equal(node.node_kind, "proposal");

			const content = JSON.parse(node.content_json) as NavigationEfficiencyProperties;
			assert.equal(content.session_id, "nav-e2e");
			assert.equal(content.view_count, 12);
			assert.equal(content.edit_count, 1);
			assert.equal(content.pattern_counts.scroll, 1);
			assert.equal(content.pattern_counts.zoom_out, 4, "every dive back from src or src/config.ts into a depth-4 file");
			assert.equal(content.pattern_counts.repeated_view, 2, "src/config.ts and src/core/retry/policy.ts are revisited");
			assert.equal(content.pattern_counts.overly_deep_zoom, 0);
			assert.ok(content.structural_edge_count > 0);
			assert.ok(content.structural_breadth >= 2, "src has several viewed children");

			const titles = content.improvement_proposals.map((p) => p.title);
			assert.equal(titles.length, 2, "zoom-out and repeated-view clear proposalMinEpisodes; one scroll does not");
			assert.ok(titles.some((t) => /descending again/.test(t)));
			assert.ok(titles.some((t) => /already viewed/.test(t)));

			await assertProposalEvidenceTrail(db, node.id, { atLeast: 3, note: "the episodes' turns anchor the finding" });

			const proposals = await sessionProposals(db, "nav-e2e", ANALYZER_ID);
			assert.equal(proposals.length, 2);
			for (const p of proposals) {
				assert.equal(p["status"], "open");
				assert.equal(p["severity"], "waste");
			}
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, navigationEfficiencyAnalyzer, "nav-idem", wanderingSessionMessages());
		} finally {
			await close();
		}
	});

	it("linear navigation stays a clean metric node with no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, navigationEfficiencyAnalyzer, "nav-linear", linearSessionMessages());
			assert.equal(nodes.length, 1, "a clean session is still analysed");
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as NavigationEfficiencyProperties;
			assert.equal(content.episodes.length, 0);
			assert.equal(content.improvement_proposals.length, 0);
			assert.equal(content.structural_edge_count, 2, "both files hang under the viewed src directory");
			assert.equal((await sessionProposals(db, "nav-linear", ANALYZER_ID)).length, 0);
		} finally {
			await close();
		}
	});

	it("changing config marks nodes stale for the `config` reason and revises beside them", async () => {
		const { db, close } = await tempDb();
		try {
			const { after, revised } = await expectConfigChangeRevises(
				db,
				navigationEfficiencyAnalyzer,
				"nav-config",
				wanderingSessionMessages(),
				{ proposalMinEpisodes: 1 },
			);
			const newest = after.find((n) => (JSON.parse(n.content_json) as NavigationEfficiencyProperties).improvement_proposals.length === 3);
			assert.ok(newest, "a looser gate lets the single scroll episode propose too");

			const rerun = await revised.run("nav-config", {});
			assert.equal(rerun.nodesProduced, 0, "revised unit is current afterwards");
		} finally {
			await close();
		}
	});
});
