import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverSessions, projectNameFromDir, MAX_DISCOVERY_DEPTH } from "../../src/sync/scanner.js";

describe("projectNameFromDir", () => {
	it("extracts project from macOS path", () => {
		const orig = process.env.USER;
		process.env.USER = "nicolas.marchildon";
		assert.equal(projectNameFromDir("--Users-nicolas.marchildon--Source--pi-prospector"), "Source/pi-prospector");
		process.env.USER = orig;
	});

	it("extracts project from Linux path", () => {
		const orig = process.env.USER;
		process.env.USER = "alice";
		assert.equal(projectNameFromDir("--home-alice--code--repo"), "code/repo");
		process.env.USER = orig;
	});

	it("returns workspace for bare directories", () => {
		assert.equal(projectNameFromDir("--"), "workspace");
	});
});

describe("discoverSessions", () => {
	// No environment guard needed: both roots are explicit parameters now, so the
	// real Claude sessions directory is simply unreachable from here.
	const NO_CLAUDE_DIR = "/nonexistent-claude";

	/** Build a Pi session dir tree with two distinct project directories. */
	function twoProjects(): {
		tmpDir: string;
		projectDir: string;
	} {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-scope-"));
		for (const proj of ["projA", "projB"]) {
			const d = path.join(tmpDir, `--Users-test--${proj}`);
			fs.mkdirSync(d, { recursive: true });
			fs.writeFileSync(path.join(d, `${proj}.jsonl`), '{"type":"session"}\n');
		}
		return { tmpDir, projectDir: tmpDir };
	}

	it("filters discovery to a single project", async () => {
		const { tmpDir } = twoProjects();
		const origUser = process.env.USER;
		process.env.USER = "test";
		try {
			const sessions = await discoverSessions(tmpDir, NO_CLAUDE_DIR, { project: "projA" });
			assert.equal(sessions.length, 1);
			assert.ok(sessions[0]!.filePath.includes("projA.jsonl"));
		} finally {
			process.env.USER = origUser;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns nothing when no session matches the project scope", async () => {
		const { tmpDir } = twoProjects();
		const origUser = process.env.USER;
		process.env.USER = "test";
		try {
			const sessions = await discoverSessions(tmpDir, NO_CLAUDE_DIR, { project: "does-not-exist" });
			assert.deepEqual(sessions, []);
		} finally {
			process.env.USER = origUser;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("filters discovery to one harness via source", async () => {
		const { tmpDir } = twoProjects();
		const origUser = process.env.USER;
		process.env.USER = "test";
		try {
			const onlyClaude = await discoverSessions(tmpDir, NO_CLAUDE_DIR, { source: "claude" });
			assert.deepEqual(onlyClaude, []);
			const onlyPi = await discoverSessions(tmpDir, NO_CLAUDE_DIR, { source: "pi" });
			assert.equal(onlyPi.length, 2);
		} finally {
			process.env.USER = origUser;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("discovers .jsonl files in session dirs", async () => {
				const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-test-"));
		try {
			const projectDir = path.join(tmpDir, "--Users-test--myproject");
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(path.join(projectDir, "2026-01-15T10-30-00_abc123.jsonl"), '{"type":"session"}\n');
			fs.writeFileSync(path.join(projectDir, "not-a-session.txt"), "nope");

			const sessions = await discoverSessions(tmpDir, NO_CLAUDE_DIR);
			assert.equal(sessions.length, 1);
			assert.ok(sessions[0]!.filePath.endsWith(".jsonl"));
			assert.ok(sessions[0]!.mtime > 0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true });
		}
	
	});

	it("returns empty for nonexistent dir", async () => {
				assert.deepEqual(await discoverSessions("/nonexistent", NO_CLAUDE_DIR), []);
	
	});

	it("skips var-folders directories", async () => {
				const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-test-"));
		try {
			const varDir = path.join(tmpDir, "--var-folders-xx");
			fs.mkdirSync(varDir);
			fs.writeFileSync(path.join(varDir, "session.jsonl"), '{"type":"session"}');

			const sessions = await discoverSessions(tmpDir, NO_CLAUDE_DIR);
			assert.equal(sessions.length, 0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true });
		}
	
	});

	// #157 — nested async-subagent run trees must be discovered alongside the
	// top-level session files.
	describe("nested subagent sessions", () => {
		/** The layout pi-subagents writes under a project dir. */
		function nestedRunTree(): string {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-nested-"));
			const projectDir = path.join(tmpDir, "--Users-test--myproject");
			// Top-level session file (the only thing flat discovery ever saw)
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(path.join(projectDir, "2026-08-19T01-00-00_parent.jsonl"), '{"type":"session","id":"parent-1"}\n');
			// Nested child runs: <ts>_<uuid>/<runhash>/run-N/session.jsonl
			for (const [runHash, runDir] of [["2b83bd26", "run-0"], ["4b5387b8", "run-1"]] as const) {
				const d = path.join(projectDir, "2026-08-19T01-02-17_uuid", runHash, runDir);
				fs.mkdirSync(d, { recursive: true });
				fs.writeFileSync(path.join(d, "session.jsonl"), '{"type":"session","id":"child-x"}\n');
			}
			return tmpDir;
		}

		it("discovers nested run session.jsonl files alongside a top-level one", async () => {
			const origUser = process.env.USER;
			process.env.USER = "test";
			const tmpDir = nestedRunTree();
			try {
				const sessions = await discoverSessions(tmpDir, NO_CLAUDE_DIR);
				assert.equal(sessions.length, 3); // parent + two children
				assert.ok(sessions.every((s) => s.project === "myproject"));
				assert.equal(sessions.filter((s) => s.filePath.endsWith("session.jsonl")).length, 2);
				assert.ok(sessions.some((s) => s.filePath.endsWith("2026-08-19T01-00-00_parent.jsonl")));
			} finally {
				process.env.USER = origUser;
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("stops descending beyond MAX_DISCOVERY_DEPTH instead of recursing unbounded", async () => {
			const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-deep-"));
			const projectDir = path.join(tmpDir, "--Users-test--deep");
			// A directory chain deeper than the bound, with a session at its bottom.
			let deep = projectDir;
			for (let i = 0; i <= MAX_DISCOVERY_DEPTH + 3; i++) {
				deep = path.join(deep, `level-${i}`);
			}
			fs.mkdirSync(deep, { recursive: true });
			fs.writeFileSync(path.join(deep, "session.jsonl"), '{"type":"session","id":"too-deep"}\n');
			// One within-bound sibling for contrast.
			fs.writeFileSync(path.join(projectDir, "shallow.jsonl"), '{"type":"session","id":"shallow"}\n');
			try {
				const sessions = await discoverSessions(tmpDir, NO_CLAUDE_DIR);
				assert.equal(sessions.length, 1);
				assert.ok(sessions[0]!.filePath.endsWith("shallow.jsonl"));
			} finally {
				fs.rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});
});