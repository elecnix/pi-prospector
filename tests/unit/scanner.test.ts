import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverSessions, projectNameFromDir } from "../../src/sync/scanner.js";

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
	it("discovers .jsonl files in session dirs", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-test-"));
		const projectDir = path.join(tmpDir, "--Users-test-myproject");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "2026-01-15T10-30-00_abc123.jsonl"), '{"type":"session"}\n');
		fs.writeFileSync(path.join(projectDir, "not-a-session.txt"), "nope");

		const sessions = discoverSessions(tmpDir);
		assert.equal(sessions.length, 1);
		assert.ok(sessions[0]!.filePath.endsWith(".jsonl"));
		assert.ok(sessions[0]!.mtime > 0);

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("returns empty for nonexistent dir", () => {
		assert.deepEqual(discoverSessions("/nonexistent"), []);
	});

	it("skips var-folders directories", () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-test-"));
		const varDir = path.join(tmpDir, "--var-folders-xx");
		fs.mkdirSync(varDir);
		fs.writeFileSync(path.join(varDir, "session.jsonl"), '{"type":"session"}');

		const sessions = discoverSessions(tmpDir);
		assert.equal(sessions.length, 0);

		fs.rmSync(tmpDir, { recursive: true });
	});
});