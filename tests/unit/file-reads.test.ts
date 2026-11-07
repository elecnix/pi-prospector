/**
 * Unit tests for file-reads: extraction from synthetic message rows, path
 * normalisation, the per-repository fold and its leads. Pure functions, no
 * database, no real session data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FILE_READS_CONFIG } from "../../src/analyze/analyzers/file-reads/config.js";
import {
	SESSION_ROOT,
	extractReads,
	foldReadGraphs,
	leadsFor,
	mermaidGraph,
	normaliseReadPath,
	reportMarkdown,
	type FileRead,
	type SessionInput,
} from "../../src/analyze/analyzers/file-reads/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CFG = { ...DEFAULT_FILE_READS_CONFIG };
let seq = 0;

function row(role: string, fields: Partial<MessageRow>): MessageRow {
	return {
		id: `m-${seq++}`,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role,
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...fields,
	};
}

/** A tool call and its result of `chars` characters. */
function call(name: string, args: Record<string, unknown>, chars = 100): MessageRow[] {
	const id = `tc-${seq++}`;
	return [
		row("assistant", { tool_calls: JSON.stringify([{ id, name, arguments: args }]), stop_reason: "toolUse" }),
		row("toolResult", { tool_results: JSON.stringify([{ toolCallId: id, toolName: name, isError: false, textLength: chars }]) }),
	];
}

describe("normaliseReadPath", () => {
	it("makes a path inside the working directory relative", () => {
		assert.deepEqual(normaliseReadPath("/repo/src/a.ts", "/repo"), { path: "src/a.ts", inRepo: true });
		assert.deepEqual(normaliseReadPath("./src/../src/a.ts", "/repo"), { path: "src/a.ts", inRepo: true });
	});

	it("keeps a path outside the working directory as written, marked outside", () => {
		assert.deepEqual(normaliseReadPath("/home/x/.claude/CLAUDE.md", "/repo"), { path: "/home/x/.claude/CLAUDE.md", inRepo: false });
		assert.deepEqual(normaliseReadPath("../other/a.ts", "/repo"), { path: "../other/a.ts", inRepo: false });
		assert.deepEqual(normaliseReadPath("~/notes.md", "/repo"), { path: "~/notes.md", inRepo: false });
		assert.deepEqual(normaliseReadPath("/repo/a.ts", ""), { path: "/repo/a.ts", inRepo: false });
	});
});

describe("extractReads", () => {
	it("records reads in order with ranks, sizes and ranged reads, and edits apart", () => {
		const msgs = [
			...call("read", { path: "/repo/README.md" }, 400),
			...call("read", { file_path: "src/a.ts", offset: 10, limit: 20 }, 80),
			...call("edit", { path: "src/a.ts" }),
			...call("read", { path: "README.md" }, 400),
		];
		const { reads, edited } = extractReads(msgs, "/repo");
		assert.deepEqual(
			reads.map((r) => [r.path, r.rank, r.chars, r.ranged]),
			[["README.md", 1, 400, false], ["src/a.ts", 2, 80, true], ["README.md", 1, 400, false]],
		);
		assert.deepEqual(edited, ["src/a.ts"]);
	});

	it("counts a bash read only for file-printing commands and file-shaped tokens", () => {
		const msgs = [
			...call("bash", { command: "grep -rn foo src docs/guide.md" }),
			...call("bash", { command: "ls src/" }),
			...call("bash", { command: "sed -n 1,40p src/b.ts" }, 900),
			...call("bash", { command: "cat Makefile package.json" }, 500),
			...call("bash", { command: "cat src/c.ts | head -5" }, 50),
		];
		const { reads } = extractReads(msgs, "/repo");
		assert.deepEqual(
			reads.map((r) => [r.path, r.ranged, r.chars]),
			// `cat` printed two files into one result text, so the read it is credited
			// with gets no size, even though only one of the two is extracted.
			[["src/b.ts", true, 900], ["package.json", false, null], ["src/c.ts", false, null]],
		);
	});
});

function read(path: string, extra: Partial<FileRead> = {}): FileRead {
	return { path, in_repo: true, rank: 0, ordinal: 0, tool: "read", chars: 4000, ranged: false, message_id: "m", ...extra };
}

function session(id: string, paths: string[], edited: string[] = [], repo = "github.com/o/r"): SessionInput {
	return { sessionId: id, repo, reads: paths.map((p) => read(p)), edited };
}

describe("foldReadGraphs", () => {
	it("starts every session at the root and counts sessions per file and edge", () => {
		const [g] = foldReadGraphs(
			[session("s1", ["AGENTS.md", "src/a.ts", "src/a.ts", "src/b.ts"]), session("s2", ["AGENTS.md", "src/b.ts"], ["src/b.ts"])],
			CFG,
		);
		assert.equal(g!.sessions, 2);
		const agents = g!.files.find((f) => f.path === "AGENTS.md")!;
		assert.equal(agents.sessions, 2);
		assert.equal(agents.first_sessions, 2);
		assert.equal(g!.files.find((f) => f.path === "src/a.ts")!.reads, 2);
		assert.equal(g!.files.find((f) => f.path === "src/b.ts")!.edited_sessions, 1);
		const edge = (from: string, to: string) => g!.edges.find((e) => e.from === from && e.to === to);
		assert.deepEqual([edge(SESSION_ROOT, "AGENTS.md")?.sessions, edge("AGENTS.md", "src/a.ts")?.sessions, edge("src/a.ts", "src/b.ts")?.sessions], [2, 1, 1]);
		assert.equal(edge("src/a.ts", "src/a.ts"), undefined, "a re-read of the same file is not an edge");
	});

	it("keeps repositories apart and leaves outside reads out of the graph", () => {
		const outside = { ...session("s3", ["x.ts"], [], "dir:/other"), reads: [read("/home/u/.claude/CLAUDE.md", { in_repo: false }), read("x.ts")] };
		const graphs = foldReadGraphs([session("s1", ["a.ts"]), outside], CFG);
		assert.deepEqual(graphs.map((g) => g.repo).sort(), ["dir:/other", "github.com/o/r"]);
		const other = graphs.find((g) => g.repo === "dir:/other")!;
		assert.equal(other.outside_reads, 1);
		assert.deepEqual(other.files.map((f) => [f.path, f.first_sessions]), [["x.ts", 1]], "rank counts in-repo files only");
	});
});

describe("leadsFor", () => {
	const sessions = [1, 2, 3, 4].map((i) => session(`s${i}`, ["docs/arch.md", "src/big.ts", "src/c.ts"]));
	sessions.push(session("s5", ["src/c.ts"]));
	const [g] = foldReadGraphs(
		sessions.map((s) => ({ ...s, reads: s.reads.map((r) => (r.path === "src/big.ts" ? { ...r, chars: 60000 } : r)) })),
		CFG,
	);

	it("names the files sessions open on, the large files, and the repeated paths", () => {
		const leads = leadsFor(g!, CFG);
		// src/c.ts opens all five sessions, so it ranks first.
		assert.deepEqual(leads.orientation.map((f) => f.path), ["src/c.ts", "docs/arch.md", "src/big.ts"]);
		assert.deepEqual(leads.large.map((f) => f.path), ["src/big.ts"]);
		assert.deepEqual(leads.paths.map((e) => [e.from, e.to, e.sessions]), [["docs/arch.md", "src/big.ts", 4], ["src/big.ts", "src/c.ts", 4]]);
	});

	it("needs minSessions sessions behind a lead", () => {
		const leads = leadsFor(g!, { ...CFG, minSessions: 6 });
		assert.deepEqual([leads.orientation.length, leads.large.length, leads.paths.length], [0, 0, 0]);
	});

	it("calls a re-read of a loaded instruction file a double payment, not a summary candidate", () => {
		const [ig] = foldReadGraphs([1, 2, 3].map((i) => session(`i${i}`, ["AGENTS.md", "docs/x.md"])), CFG);
		const md = reportMarkdown([ig!], CFG);
		assert.match(md, /`AGENTS\.md`: .*loads it at session start, so a session that also reads it pays for it twice/);
		assert.match(md, /`docs\/x\.md`: .*a short summary or a map in the instruction file could replace the read/);
		assert.doesNotMatch(md, /`AGENTS\.md`: [^\n]*summary or a map/);
	});

	it("renders a Mermaid graph from the root and a report with upper-bound wording", () => {
		const mmd = mermaidGraph(g!, 2);
		assert.match(mmd, /^flowchart LR\n {2}root\(\("session start"\)\)/);
		assert.equal((mmd.match(/-->/g) ?? []).length, 2, "capped at maxEdges");
		const md = reportMarkdown([g!], CFG);
		assert.match(md, /upper bounds/);
		assert.match(md, /`src\/big\.ts`: read in 4 sessions, ~15,000 tokens per read, 100% of reads whole/);
	});
});
