/**
 * The walker's contract: it returns the files a source names, and only those.
 *
 * Which names mean "session" is not the walker's business — each source declares
 * its own shapes (see the source-shapes component suite), and `matchFile` is
 * required so no adapter can claim a tree by extension. These tests pin the
 * traversal itself: project naming, the depth bound, the leaf-directory rule, and
 * the fact that a file the source does not name is never returned.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { projectNameFromDir, walkSessionDir, MAX_DISCOVERY_DEPTH } from "../../src/sync/scanner.js";

/** A stand-in for a source's shapes: fixture files are named `session-*.jsonl`. */
const CLAIMS_SESSION_PREFIX = (fileName: string): boolean => fileName.startsWith("session-") && fileName.endsWith(".jsonl");
const CLAIMS_EVERYTHING = (): boolean => true;

function tempRoot(label: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `prospect-${label}-`));
}

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

describe("walkSessionDir", () => {
	it("returns only the files the source names", async () => {
		const tmpDir = tempRoot("named");
		const projectDir = path.join(tmpDir, "--Users-test--myproject");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "session-one.jsonl"), '{"type":"session"}\n');
		// Carries a session header, and is still not claimed: the walk never reads
		// a file to decide whether it is a session.
		fs.writeFileSync(path.join(projectDir, "something-else.jsonl"), '{"type":"session"}\n');
		fs.writeFileSync(path.join(projectDir, "session-two.txt"), "not a session file");
		try {
			const sessions = await walkSessionDir(tmpDir, "pi", { matchFile: CLAIMS_SESSION_PREFIX });
			assert.deepEqual(
				sessions.map((s) => path.basename(s.filePath)),
				["session-one.jsonl"],
			);
			assert.ok(sessions[0]!.mtime > 0);
			assert.ok(sessions[0]!.size > 0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("tags every file with the source it was walked for and its project", async () => {
		const tmpDir = tempRoot("tags");
		const origUser = process.env.USER;
		process.env.USER = "test";
		try {
			const projectDir = path.join(tmpDir, "--Users-test--myproject");
			fs.mkdirSync(projectDir, { recursive: true });
			fs.writeFileSync(path.join(projectDir, "session-one.jsonl"), '{"type":"session"}\n');

			const sessions = await walkSessionDir(tmpDir, "claude", { matchFile: CLAIMS_SESSION_PREFIX });
			assert.equal(sessions.length, 1);
			assert.equal(sessions[0]!.source, "claude");
			assert.equal(sessions[0]!.project, "myproject");
		} finally {
			process.env.USER = origUser;
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns empty for a nonexistent root", async () => {
		assert.deepEqual(await walkSessionDir("/nonexistent-root", "pi", { matchFile: CLAIMS_SESSION_PREFIX }), []);
	});

	it("skips var-folders directories", async () => {
		const tmpDir = tempRoot("varfolders");
		try {
			const varDir = path.join(tmpDir, "--var-folders-xx");
			fs.mkdirSync(varDir);
			fs.writeFileSync(path.join(varDir, "session-one.jsonl"), '{"type":"session"}');

			assert.deepEqual(await walkSessionDir(tmpDir, "pi", { matchFile: CLAIMS_SESSION_PREFIX }), []);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("descends to files that sit below a project directory", async () => {
		const tmpDir = tempRoot("nested");
		try {
			const projectDir = path.join(tmpDir, "--Users-test--myproject");
			fs.mkdirSync(path.join(projectDir, "2026-08-19T01-02-17_uuid", "2b83bd26", "run-0"), { recursive: true });
			fs.writeFileSync(
				path.join(projectDir, "2026-08-19T01-02-17_uuid", "2b83bd26", "run-0", "session-one.jsonl"),
				'{"type":"session"}\n',
			);

			const sessions = await walkSessionDir(tmpDir, "pi", { matchFile: CLAIMS_SESSION_PREFIX });
			assert.equal(sessions.length, 1);
			assert.ok(sessions[0]!.filePath.endsWith(path.join("run-0", "session-one.jsonl")));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("stops descending beyond MAX_DISCOVERY_DEPTH instead of recursing unbounded", async () => {
		const tmpDir = tempRoot("deep");
		try {
			const projectDir = path.join(tmpDir, "--Users-test--deep");
			let deep = projectDir;
			for (let i = 0; i <= MAX_DISCOVERY_DEPTH + 3; i++) deep = path.join(deep, `level-${i}`);
			fs.mkdirSync(deep, { recursive: true });
			fs.writeFileSync(path.join(deep, "session-too-deep.jsonl"), '{"type":"session"}\n');
			// One within-bound sibling for contrast.
			fs.writeFileSync(path.join(projectDir, "session-shallow.jsonl"), '{"type":"session"}\n');

			const sessions = await walkSessionDir(tmpDir, "pi", { matchFile: CLAIMS_SESSION_PREFIX });
			assert.equal(sessions.length, 1);
			assert.ok(sessions[0]!.filePath.endsWith("session-shallow.jsonl"));
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("stops at a leaf directory, keeping the files inside it", async () => {
		const tmpDir = tempRoot("leaf");
		try {
			const leaf = path.join(tmpDir, "--Users-test--proj", "run-0");
			const below = path.join(leaf, "deeper", "session-below.jsonl");
			fs.mkdirSync(path.join(leaf, "deeper"), { recursive: true });
			fs.writeFileSync(path.join(leaf, "session-inside.jsonl"), '{"type":"session"}\n');
			fs.writeFileSync(below, '{"type":"session"}\n');

			// The matcher claims every name, so the file below the leaf is excluded by
			// the leaf rule and nothing else. The assertion on its existence is what
			// keeps that reason explicit: drop `leafDirPattern` and this test fails
			// with two results instead of one.
			assert.ok(fs.existsSync(below), "the deeper file exists and would otherwise be claimed");
			const sessions = await walkSessionDir(tmpDir, "pi", {
				matchFile: CLAIMS_EVERYTHING,
				leafDirPattern: /^run-\d+$/,
			});
			assert.deepEqual(
				sessions.map((s) => path.basename(s.filePath)),
				["session-inside.jsonl"],
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
