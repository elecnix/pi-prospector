/**
 * Discovery must be a pure function of the directories it is given.
 *
 * `discoverSessions` used to resolve the Claude directory from ambient config,
 * so a caller that passed an explicit fixture path still ingested the developer's
 * real session history. Two test suites had already noticed and were juggling
 * `PROSPECTOR_CLAUDE_SESSIONS_DIR` to defend themselves; two others had not, and
 * failed only on machines with real sessions — invisible in CI.
 *
 * These tests pin the property that removes the whole class of bug: nothing
 * outside the passed directories can ever be discovered.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { discoverSessions } from "../../src/sync/scanner.js";

/** A session root holding one project dir with one .jsonl session. */
function makeRoot(label: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `prospect-${label}-`));
	const projectDir = path.join(root, "--Users-test-project");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "2026-01-15T10-30-00_abc.jsonl"), '{"type":"session"}\n');
	return root;
}

describe("discoverSessions isolation", () => {
	it("reads only the directories it is given, whatever the environment says", async () => {
		const piRoot = makeRoot("pi");
		const claudeRoot = makeRoot("claude");
		const decoyRoot = makeRoot("decoy");
		const prev = process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"];
		try {
			// Point the ambient config at a directory that must never be consulted.
			process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = decoyRoot;

			const found = await discoverSessions(piRoot, claudeRoot);
			assert.equal(found.length, 2, "one Pi session and one Claude session");
			assert.deepEqual(found.map((s) => s.source).sort(), ["claude", "pi"]);
			assert.equal(
				found.some((s) => s.filePath.startsWith(decoyRoot)),
				false,
				"the ambient directory must not leak in",
			);
		} finally {
			if (prev === undefined) delete process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"];
			else process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = prev;
			for (const r of [piRoot, claudeRoot, decoyRoot]) fs.rmSync(r, { recursive: true, force: true });
		}
	});

	it("discovers nothing when both directories are absent", async () => {
		assert.deepEqual(await discoverSessions("/nonexistent-pi", "/nonexistent-claude"), []);
	});

	it("keeps the two sources independent", async () => {
		const piRoot = makeRoot("pi");
		try {
			assert.equal((await discoverSessions(piRoot, "/nonexistent-claude")).length, 1);
			assert.equal((await discoverSessions("/nonexistent-pi", piRoot)).length, 1);
			assert.equal((await discoverSessions("/nonexistent-pi", piRoot))[0]!.source, "claude");
		} finally {
			fs.rmSync(piRoot, { recursive: true, force: true });
		}
	});
});
