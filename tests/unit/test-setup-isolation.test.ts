/**
 * The test runner never reads the developer's real session history.
 *
 * `tests/setup.ts` is loaded before every test file. A test that sets only one
 * of the two session directories would otherwise discover the other from its
 * default under the home directory, and ingest real transcripts into its temp
 * database: slow, and a breach of the no-real-session-data rule. CI has no
 * session history, so only a developer machine shows the failure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { getClaudeSessionsDir, getSessionsDir } from "../../src/config.js";

describe("test setup isolation", () => {
	it("points both session directories away from the home directory by default", () => {
		for (const dir of [getSessionsDir(), getClaudeSessionsDir()]) {
			assert.ok(!dir.startsWith(os.homedir()), `${dir} must not be under the home directory during tests`);
		}
	});
});
