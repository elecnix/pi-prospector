/**
 * Unit tests for the navigation-efficiency analyzer's deterministic extraction,
 * structural metrics, and the four Graphectory anti-pattern detectors (issue
 * #254). Pure functions over hand-written synthetic message rows — no database,
 * no mocks, no real session data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_NAVIGATION_EFFICIENCY_CONFIG,
	type NavigationEfficiencyConfig,
} from "../../src/analyze/analyzers/navigation-efficiency/config.js";
import {
	detectOverlyDeepZoom,
	detectRepeatedView,
	detectScroll,
	detectZoomOut,
	extractNavigation,
	isAncestor,
	looksLikeFile,
	scanNavigation,
	sliceOverlap,
	splitShellSegments,
	structuralMetrics,
} from "../../src/analyze/analyzers/navigation-efficiency/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow } from "./helpers.js";

const CONFIG: NavigationEfficiencyConfig = { ...DEFAULT_NAVIGATION_EFFICIENCY_CONFIG };

let seq = 0;

/** One tool call plus its paired result. */
function call(name: string, args: Record<string, unknown>, isError = false): MessageRow[] {
	const id = `nav-${seq++}`;
	return [
		makeMessageRow({
			id: `am-${id}`,
			role: "assistant",
			stop_reason: "toolUse",
			tool_calls: JSON.stringify([{ id: `tc-${id}`, name, arguments: args }]),
		}),
		makeMessageRow({
			id: `tr-${id}`,
			role: "toolResult",
			content_text: isError ? "error" : "ok",
			tool_results: JSON.stringify([{ toolCallId: `tc-${id}`, toolName: name, isError, textLength: 2 }]),
		}),
	];
}

const read = (path: string, offset?: number, limit?: number): MessageRow[] =>
	call("read", { path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) });
const ls = (path: string): MessageRow[] => call("ls", { path });
const edit = (path: string, isError = false): MessageRow[] => call("edit", { path }, isError);
const bash = (command: string): MessageRow[] => call("bash", { command });

const nav = (...rows: MessageRow[][]) => extractNavigation(rows.flat());

// ─────────────────────────── extraction ───────────────────────────

describe("extractNavigation", () => {
	it("gives each view a structural level from its path depth, plus one for a block", () => {
		const actions = nav(ls("."), ls("src"), read("src/a.ts"), read("src/a.ts", 10, 20), edit("src/a.ts"));
		assert.deepEqual(
			actions.map((a) => [a.kind, a.level, a.path, a.depth]),
			[
				["view", "dir", ".", 0],
				["view", "dir", "src", 1],
				["view", "file", "src/a.ts", 2],
				["view", "block", "src/a.ts", 3],
				["edit", "file", "src/a.ts", 2],
			],
		);
		assert.deepEqual([actions[3]!.start, actions[3]!.end], [10, 30]);
	});

	it("makes absolute paths relative to the root they share, and cleans `./` and trailing slashes", () => {
		const actions = nav(read("/repo/src/deep/x.ts"), ls("/repo/src/"), read("./src/y.ts"));
		assert.deepEqual(
			actions.map((a) => [a.path, a.depth]),
			[
				["src/deep/x.ts", 3],
				["src", 1],
				["src/y.ts", 2],
			],
		);
	});

	it("reads bash navigation: ls/rg over directories, cat/sed ranges over files, redirects as edits", () => {
		const actions = nav(
			bash("ls src/analyze && rg -n needle src/analyze/tool-stream.ts"),
			bash("sed -n '2820,2850p' src/big.ts"),
			bash("cat src/a.ts | head -5"),
			bash("rg TODO"),
			bash("echo hi > out/log.txt"),
			bash("npm test"),
		);
		assert.deepEqual(
			actions.map((a) => [a.kind, a.level, a.path]),
			[
				["view", "dir", "src/analyze"],
				["view", "file", "src/analyze/tool-stream.ts"],
				["view", "block", "src/big.ts"],
				["view", "file", "src/a.ts"],
				["view", "dir", "."],
				["edit", "file", "out/log.txt"],
			],
		);
		assert.deepEqual([actions[2]!.start, actions[2]!.end], [2820, 2851]);
	});

	it("treats sed -i as an edit and records whether an edit succeeded", () => {
		const actions = nav(bash("sed -i 's/a/b/' src/a.ts"), edit("src/b.ts", true));
		assert.deepEqual(
			actions.map((a) => [a.kind, a.path, a.ok]),
			[
				["edit", "src/a.ts", true],
				["edit", "src/b.ts", false],
			],
		);
	});

	it("ignores non-navigation calls", () => {
		assert.equal(nav(call("webFetch", { url: "https://example.com/x.html" }), bash("npm test")).length, 0);
	});
});

describe("splitShellSegments", () => {
	it("splits on unquoted separators only and keeps `&>` redirects", () => {
		assert.deepEqual(splitShellSegments(`cd x && rg 'a|b' src; ls | wc -l`), ["cd x", "rg 'a|b' src", "ls", "wc -l"]);
		assert.deepEqual(splitShellSegments("make &> build.log"), ["make &> build.log"]);
	});
});

describe("structure helpers", () => {
	it("looksLikeFile accepts named and dotfile files and rejects `.`, `..`, and bare directories", () => {
		for (const f of ["a.ts", "src/a.test.ts", ".env", "dir/.gitignore"]) assert.ok(looksLikeFile(f), f);
		for (const d of [".", "..", "src", "src/", "../x/.."]) assert.ok(!looksLikeFile(d), d);
	});

	it("isAncestor treats `.` as the root of every relative path", () => {
		assert.ok(isAncestor(".", "src/a.ts"));
		assert.ok(isAncestor("src", "src/a/b.ts"));
		assert.ok(!isAncestor("src", "src"));
		assert.ok(!isAncestor("src", "srcx/a.ts"));
	});

	it("sliceOverlap measures against the shorter slice and ignores unbounded ranges", () => {
		assert.equal(sliceOverlap({ start: 2820, end: 2851 }, { start: 2827, end: 2851 }), 1);
		assert.equal(sliceOverlap({ start: 0, end: 100 }, { start: 100, end: 200 }), 0);
		assert.equal(sliceOverlap({ start: 0, end: 100 }, { start: 50, end: Infinity }), 0);
		assert.equal(sliceOverlap({ start: 0, end: 100 }, { start: 50, end: 250 }), 0.5);
	});
});

// ─────────────────────────── metrics ───────────────────────────

describe("structuralMetrics", () => {
	it("counts structural edges to the nearest viewed ancestor and the widest sibling fan-out", () => {
		const m = structuralMetrics(
			nav(ls("."), ls("src"), read("src/a.ts"), read("src/b.ts"), read("src/a.ts", 1, 10), read("docs/x.md")),
		);
		// src→., src/a.ts→src, src/b.ts→src, block→src/a.ts, docs/x.md→. (nearest viewed ancestor)
		assert.equal(m.regions, 6);
		assert.equal(m.sec, 5);
		assert.equal(m.sb, 2, "src has two viewed children; . has two as well");
		assert.equal(m.maxDepth, 3);
	});

	it("is all zeros when nothing was viewed", () => {
		assert.deepEqual(structuralMetrics(nav(edit("a.ts"))), { regions: 0, sec: 0, sb: 0, maxDepth: 0 });
	});
});

// ─────────────────────────── detectors ───────────────────────────

describe("detectScroll", () => {
	it("flags the paper's example: three consecutive overlapping slices of one file", () => {
		const eps = detectScroll(nav(read("big.ts", 2820, 31), read("big.ts", 2827, 24), read("big.ts", 2827, 74)), CONFIG);
		assert.equal(eps.length, 1);
		assert.equal(eps[0]!.path, "big.ts");
		assert.equal(eps[0]!.views, 3);
		assert.equal(eps[0]!.ordinals.length, 3);
	});

	it("does not flag disjoint pagination, identical repeats, or runs broken by another view", () => {
		assert.equal(detectScroll(nav(read("big.ts", 0, 100), read("big.ts", 100, 100), read("big.ts", 200, 100)), CONFIG).length, 0);
		assert.equal(detectScroll(nav(read("big.ts", 0, 100), read("big.ts", 0, 100), read("big.ts", 0, 100)), CONFIG).length, 0);
		assert.equal(
			detectScroll(nav(read("big.ts", 0, 100), read("big.ts", 50, 100), read("other.ts"), read("big.ts", 90, 100)), CONFIG).length,
			0,
		);
	});
});

describe("detectZoomOut", () => {
	it("flags deep → ancestor → deep with no edit in between", () => {
		const eps = detectZoomOut(nav(read("src/a/b/c.ts"), ls("src"), read("src/x/y/z.ts")), CONFIG);
		assert.equal(eps.length, 1);
		assert.equal(eps[0]!.path, "src");
		assert.deepEqual(eps[0]!.depths, [4, 1, 4]);
	});

	it("does not flag a descent that an edit interrupts, or a shallow view off the explored branch", () => {
		assert.equal(detectZoomOut(nav(read("src/a/b/c.ts"), edit("src/a/b/c.ts"), ls("src"), read("src/x/y/z.ts")), CONFIG).length, 0);
		assert.equal(detectZoomOut(nav(read("src/a/b/c.ts"), ls("docs"), read("src/x/y/z.ts")), CONFIG).length, 0);
	});

	it("does not flag a zoom out that never descends again", () => {
		assert.equal(detectZoomOut(nav(read("src/a/b/c.ts"), ls("src"), ls(".")), CONFIG).length, 0);
	});

	it("honours zoomOutDepthDelta", () => {
		const actions = nav(read("src/a/b.ts"), ls("src/a"), read("src/a/c/d.ts"));
		assert.equal(detectZoomOut(actions, CONFIG).length, 0, "a one-level step back is below the default delta");
		assert.equal(detectZoomOut(actions, { ...CONFIG, zoomOutDepthDelta: 1 }).length, 1);
	});
});

describe("detectOverlyDeepZoom", () => {
	const run = (path: string, n: number) => Array.from({ length: n }, (_, i) => read(path, i * 10, 10));

	it("flags a long view-only run on a path the session never edits", () => {
		const eps = detectOverlyDeepZoom(nav(...run("src/wrong.ts", 5), edit("src/right.ts")), CONFIG);
		assert.equal(eps.length, 1);
		assert.equal(eps[0]!.path, "src/wrong.ts");
		assert.equal(eps[0]!.views, 5);
	});

	it("does not flag a run that ends in an edit on that path, or a short run", () => {
		assert.equal(detectOverlyDeepZoom(nav(...run("src/a.ts", 6), edit("src/a.ts")), CONFIG).length, 0);
		assert.equal(detectOverlyDeepZoom(nav(...run("src/a.ts", 4), edit("src/b.ts")), CONFIG).length, 0);
	});

	it("counts an edit under a directory as converging on that directory", () => {
		const dirRun = Array.from({ length: 5 }, () => ls("src/pkg"));
		assert.equal(detectOverlyDeepZoom(nav(...dirRun, edit("src/pkg/mod.ts")), CONFIG).length, 0);
	});

	it("does not judge a session that never edits anything", () => {
		assert.equal(detectOverlyDeepZoom(nav(...run("src/a.ts", 8)), CONFIG).length, 0);
	});
});

describe("detectRepeatedView", () => {
	it("flags a region revisited after leaving it, at least structuralRevisitMin times", () => {
		const eps = detectRepeatedView(nav(read("a.ts"), read("b.ts"), read("a.ts"), read("c.ts"), read("a.ts")), CONFIG);
		assert.equal(eps.length, 1);
		assert.equal(eps[0]!.path, "a.ts");
		assert.equal(eps[0]!.views, 3, "the original view plus two returns");
	});

	it("does not count consecutive views, disjoint blocks, or a verification read after a successful edit", () => {
		assert.equal(detectRepeatedView(nav(read("a.ts"), read("a.ts"), read("a.ts")), CONFIG).length, 0);
		assert.equal(
			detectRepeatedView(nav(read("a.ts", 0, 10), read("b.ts"), read("a.ts", 20, 10), read("c.ts"), read("a.ts", 40, 10)), CONFIG)
				.length,
			0,
		);
		assert.equal(
			detectRepeatedView(nav(read("a.ts"), edit("a.ts"), read("a.ts"), edit("a.ts"), read("a.ts")), CONFIG).length,
			0,
		);
	});

	it("counts a re-read after a failed edit", () => {
		const eps = detectRepeatedView(nav(read("a.ts"), edit("a.ts", true), read("a.ts"), edit("a.ts", true), read("a.ts")), CONFIG);
		assert.equal(eps.length, 1);
	});
});

describe("scanNavigation", () => {
	it("a linear session with no revisits produces no episodes", () => {
		const scan = scanNavigation([...ls("src"), ...read("src/a.ts"), ...edit("src/a.ts"), ...read("src/b.ts"), ...edit("src/b.ts")].flat(), CONFIG);
		assert.equal(scan.episodes.length, 0);
		assert.equal(scan.viewCount, 3);
		assert.equal(scan.editCount, 2);
	});
});
