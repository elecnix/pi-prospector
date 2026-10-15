/**
 * Discovery must be a pure function of the directories it is given.
 *
 * The Claude directory used to be resolved from ambient config, so a caller that
 * passed an explicit fixture path still ingested the developer's real session
 * history: invisible in CI (no `~/.claude/projects` there) and failing locally for
 * reasons unrelated to the change under test.
 *
 * These tests pin that property, and the one that goes with it now that each
 * source names its own shapes: a source reads nothing outside the directory it was
 * handed, and nothing inside it that it did not claim.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";

const PI_SESSION = "aaaa0001-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLAUDE_SESSION = "cccc0001-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/** A Pi root holding one project dir with one Pi-named session file. */
function makePiRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `prospect-${label}-`));
	const projectDir = path.join(root, "--Users-test-project");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, `2026-01-15T10-30-00-000Z_${PI_SESSION}.jsonl`), '{"type":"session"}\n');
	return root;
}

/** A Claude root holding one project dir with one Claude-named session file. */
function makeClaudeRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `prospect-${label}-`));
	const projectDir = path.join(root, "-Users-test-project");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, `${CLAUDE_SESSION}.jsonl`), '{"type":"user","uuid":"u1"}\n');
	return root;
}

describe("discovery isolation", () => {
	it("reads only the directory it is given, whatever the environment says", async () => {
		const piRoot = makePiRoot("pi");
		const decoyRoot = makePiRoot("decoy");
		const prev = process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"];
		try {
			// Point the ambient config at a directory that must never be consulted.
			process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = decoyRoot;

			const found = await new PiFileSource(piRoot).discover();
			assert.equal(found.length, 1, "one Pi session");
			assert.equal(
				found.some((s) => s.filePath.startsWith(decoyRoot)),
				false,
				"the ambient directory must not leak in",
			);
		} finally {
			if (prev === undefined) delete process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"];
			else process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = prev;
			for (const r of [piRoot, decoyRoot]) fs.rmSync(r, { recursive: true, force: true });
		}
	});

	it("discovers nothing when the directory is absent", async () => {
		assert.deepEqual(await new PiFileSource("/nonexistent-pi").discover(), []);
		assert.deepEqual(await new ClaudeFileSource("/nonexistent-claude").discover(), []);
	});

	it("keeps the two harnesses' trees independent", async () => {
		const piRoot = makePiRoot("pi");
		const claudeRoot = makeClaudeRoot("claude");
		try {
			assert.deepEqual((await new PiFileSource(piRoot).discover()).map((s) => s.source), ["pi"]);
			assert.deepEqual((await new ClaudeFileSource(claudeRoot).discover()).map((s) => s.source), ["claude"]);

			// Each root yields nothing when walked for the other harness: neither
			// harness's file names match the other's shapes.
			assert.deepEqual(await new ClaudeFileSource(piRoot).discover(), []);
			assert.deepEqual(await new PiFileSource(claudeRoot).discover(), []);
		} finally {
			fs.rmSync(piRoot, { recursive: true, force: true });
			fs.rmSync(claudeRoot, { recursive: true, force: true });
		}
	});
});
