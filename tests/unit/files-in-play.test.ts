/**
 * Unit tests for the files-in-play analyzer's deterministic extraction and
 * churn heuristic (issue #103). Pure functions over hand-written synthetic
 * message rows — no database, no mocks, no real session data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILES_IN_PLAY_CONFIG } from "../../src/analyze/analyzers/files-in-play/config.js";
import type { FilesInPlayConfig } from "../../src/analyze/analyzers/files-in-play/config.js";
import {
	bashPathTargets,
	extractFileInteractions,
	fileStatistics,
	isWindowChurning,
	scanSessionChurn,
	churnRelevantMessageIds,
	type FileInteraction,
} from "../../src/analyze/analyzers/files-in-play/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG: FilesInPlayConfig = { ...DEFAULT_FILES_IN_PLAY_CONFIG };

// ─────────────────────────── row helpers ───────────────────────────

let seq = 0;

function assistantCall(name: string, args: Record<string, unknown>): MessageRow {
	const id = `am-${seq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role: "assistant",
		content_text: null,
		content_thinking: null,
		tool_calls: JSON.stringify([{ id: `tc-${id}`, name, arguments: args }]),
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: "toolUse",
		error_message: null,
	};
}

function toolResult(): MessageRow {
	const id = `tr-${seq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role: "toolResult",
		content_text: "ok",
		content_thinking: null,
		tool_calls: null,
		tool_results: JSON.stringify([{ toolCallId: "", toolName: "", isError: false, textLength: 2 }]),
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
	};
}

/** One structured tool call plus its paired result. */
function touch(name: string, args: Record<string, unknown>): MessageRow[] {
	return [assistantCall(name, args), toolResult()];
}

// ─────────────────────────── path extraction ───────────────────────────

describe("extractFileInteractions", () => {
	it("reads Pi's `path`, Claude's normalized `file_path`, and priority order", () => {
		const msgs = [
			...touch("read", { path: "src/pi-style.ts" }),
			...touch("read", { file_path: "/abs/claude-style.ts" }),
			// `path` wins over later keys when several are present.
			...touch("edit", { path: "src/chosen.ts", filename: "src/not-chosen.ts" }),
		];
		const its = extractFileInteractions(msgs);
		assert.deepEqual(
			its.map((i) => [i.path, i.direction]),
			[
				["src/pi-style.ts", "read"],
				["/abs/claude-style.ts", "read"],
				["src/chosen.ts", "edit"],
			],
		);
	});

	it("classifies write/create/edit/patch tools and treats unknown path-bearing tools as reads", () => {
		const msgs = [
			...touch("write", { path: "src/new.ts" }),
			...touch("create", { path: "src/other.ts" }),
			...touch("patch", { path: "src/patched.ts" }),
			...touch("mysteryTool", { path: "src/mystery.ts" }),
			// No path argument at all → nothing extracted.
			...touch("grep", { pattern: "needle", path: undefined }),
		];
		const its = extractFileInteractions(msgs);
		assert.deepEqual(
			its.map((i) => [i.path, i.direction]),
			[
				["src/new.ts", "write"],
				["src/other.ts", "write"],
				["src/patched.ts", "edit"],
				["src/mystery.ts", "read"],
			],
		);
	});

	it("ignores calls with empty or non-string path arguments", () => {
		const msgs = [
			...touch("read", { path: "" }),
			...touch("read", { path: 42 }),
			...touch("read", {}),
		];
		assert.equal(extractFileInteractions(msgs).length, 0);
	});

	it("extracts bash reads, redirects, tee and output-flag writes; skips non-paths", () => {
		const targets = bashPathTargets(
			"cat src/a.ts && npm test --silent > /dev/null && grep -rn needle lib/ ; echo done | tee out.log",
		);
		const paths = targets.map((t) => t.path);
		assert.ok(paths.includes("src/a.ts"), "plain path token is a read target");
		assert.ok(!paths.includes("test"), "bare subcommand words are not paths");
		assert.ok(!paths.includes("--silent"), "flags are not paths");
		assert.ok(paths.includes("lib/") || paths.includes("lib"), "slash-bearing token is a read target");
		assert.ok(targets.find((t) => t.path === "out.log")?.direction === "write", "tee target is a write");

		const redirected = bashPathTargets("node scripts/gen.ts > src/generated.ts");
		assert.ok(redirected.find((t) => t.path === "src/generated.ts")?.direction === "write");
		assert.ok(bashPathTargets("curl -o pkg.json https://example.com/data").find((t) => t.path === "pkg.json")?.direction === "write");
		// URLs never count as files.
		assert.ok(!bashPathTargets("wget https://example.com/f.tar.gz").some((t) => t.path.includes("example.com")));
	});
});

// ─────────────────────────── per-file statistics ───────────────────────────

function inter(path: string, direction: FileInteraction["direction"]): FileInteraction {
	return { path, direction, tool: direction === "edit" ? "edit" : "read", ordinal: 0, messageId: `m-${seq++}` };
}

describe("fileStatistics", () => {
	it("counts a read→edit→read sequence as exactly one cycle and one re-read", () => {
		const stats = fileStatistics([inter("f.ts", "read"), inter("f.ts", "edit"), inter("f.ts", "read")]);
		assert.equal(stats.length, 1);
		assert.equal(stats[0]!.cycles, 1);
		assert.equal(stats[0]!.rereads, 1);
	});

	it("does not open a cycle from an edit before any read, nor from whole-file writes", () => {
		const stats = fileStatistics([
			inter("a.ts", "edit"),
			inter("a.ts", "read"),
			inter("b.ts", "write"),
			inter("b.ts", "read"),
		]);
		const a = stats.find((s) => s.path === "a.ts")!;
		assert.equal(a.cycles, 0, "edit-before-read opens no cycle");
		const b = stats.find((s) => s.path === "b.ts")!;
		assert.equal(b.writes, 1);
		assert.equal(b.cycles, 0, "a rewrite is not a partial-edit cycle");
	});

	it("ranks the most-handled file first regardless of insertion order", () => {
		const stats = fileStatistics([
			inter("quiet.ts", "read"),
			...Array.from({ length: 6 }, () => [inter("hot.ts", "read"), inter("hot.ts", "edit")]).flat(),
		]);
		assert.equal(stats[0]!.path, "hot.ts");
	});
});

// ─────────────────────────── window classification ───────────────────────────

describe("isWindowChurning", () => {
	it("classifies by repeat share against the configured ratio", () => {
		assert.equal(isWindowChurning(["a", "b", "c"], 0.5), false, "all-fresh window is quiet");
		assert.equal(isWindowChurning(["a", "a", "a"], 0.5), true, "pure repeats churn");
		// 4 of 8 repeats = exactly 0.5 → at-threshold counts as churning.
		assert.equal(isWindowChurning(["a", "b", "c", "d", "a", "b", "c", "d"], 0.5), true);
		assert.equal(isWindowChurning(["a", "b", "c", "d", "e", "f", "g", "a"], 0.5), false);
		assert.equal(isWindowChurning([], 0.5), false, "an empty window is not evidence");
	});
});

// ─────────────────────────── session scan ───────────────────────────

/** Heavy churn: tight read→edit→read cycling over two files. */
function churningMessages(): MessageRow[] {
	const msgs: MessageRow[] = [];
	for (let round = 0; round < 5; round++) {
		msgs.push(...touch("read", { path: "src/auth/login.ts" }));
		msgs.push(...touch("edit", { path: "src/auth/login.ts" }));
		msgs.push(...touch("read", { path: "src/auth/session.ts" }));
		msgs.push(...touch("edit", { path: "src/auth/session.ts" }));
	}
	return msgs;
}

/** Linear work: every file touched briefly, then never again. */
function linearMessages(): MessageRow[] {
	const msgs: MessageRow[] = [];
	for (let i = 0; i < 12; i++) {
		msgs.push(...touch("read", { path: `src/module${i}/index.ts` }));
		msgs.push(...touch("edit", { path: `src/module${i}/fix.ts` }));
	}
	return msgs;
}

describe("scanSessionChurn", () => {
	it("fires on heavy read/edit cycling over the same small set", () => {
		const scan = scanSessionChurn(churningMessages(), CONFIG);
		assert.equal(scan.distinctFiles, 2);
		assert.equal(scan.interactions.length, 20, "every read and edit is an interaction");
		assert.ok(scan.rereadEvents >= 3, `re-reads recur (${scan.rereadEvents})`);
		assert.ok(scan.editRereadCycles >= 3, `read→edit→read cycles recur (${scan.editRereadCycles})`);
		assert.equal(scan.churnScore, 1, "every window of a pure cycling session churns");
		assert.equal(scan.topFiles[0]!.path, "src/auth/login.ts");
	});

	it("stays quiet for linear work across fresh files", () => {
		const scan = scanSessionChurn(linearMessages(), CONFIG);
		assert.equal(scan.distinctFiles, 24);
		assert.equal(scan.rereadEvents, 0, "no file is ever revisited");
		assert.equal(scan.churnScore, 0, "no window reaches the repeat ratio");
	});

	it("a single-interaction session still gets one window evaluated", () => {
		const msgs = [...touch("read", { path: "solo.ts" })];
		const scan = scanSessionChurn(msgs, CONFIG);
		assert.equal(scan.churnWindows, 1);
		assert.equal(scan.churningWindows, 0);
		assert.equal(scan.churnScore, 0);
	});

	it("distant revisits do not churn: repeats must co-occur inside one window", () => {
		const msgs: MessageRow[] = [];
		for (let i = 0; i < 20; i++) msgs.push(...touch("read", { path: `src/wide${i}.ts` }));
		msgs.push(...touch("read", { path: "src/wide0.ts" }), ...touch("edit", { path: "src/wide1.ts" }));
		const scan = scanSessionChurn(msgs, CONFIG);
		assert.ok(scan.rereadEvents > 0, "the revisit happened");
		assert.equal(scan.churnScore, 0, "but it was far outside any single window");
	});

	it("exposes churn-relevant message ids in stream order, deduplicated", () => {
		const ids = churnRelevantMessageIds(extractFileInteractions(churningMessages()));
		assert.ok(new Set(ids).size === ids.length, "deduplicated");
		assert.ok(ids.length >= 3, "several turns carry churn events");
	});
});
