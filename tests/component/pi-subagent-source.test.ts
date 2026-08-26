/**
 * PiSubagentSource — nested run-* directories' session.jsonl discovery and ingest (#140).
 *
 * Exercises the adapter through the real sync loop: discovery under nested
 * project/parent/run directories, parent-session extraction from the enclosing
 * UUID directory, cursor-based incremental skip, and harness scoping
 * (--source pi must not drop... but --source claude must select nothing).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { PiSubagentSource } from "../../src/sync/sources/pi-subagent.js";
import { tempDb } from "./helpers.js";

function makeRoot(): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-pi-subagent-"));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** <root>/--Users-test--proj/<parent-uuid>/<run-N>/session.jsonl */
function writeSubagentSession(
	root: string,
	parentUuid: string,
	runDir: string,
	sessionId: string,
): string {
	const dir = path.join(root, "--Users-test--proj", parentUuid, runDir);
	fs.mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-03-01T10:00:00Z", cwd: "/home/user/proj" }),
		JSON.stringify({ type: "message", id: `${sessionId}-m1`, timestamp: "2026-03-01T10:00:05Z", message: { role: "user", content: "child turn" } }),
	];
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

const PARENT = "aaaa0001-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("PiSubagentSource", () => {
	it("discovers nested run sessions and records the enclosing session as parent", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		try {
			writeSubagentSession(fx.root, PARENT, "run-0", "sub-0001");
			writeSubagentSession(fx.root, PARENT, "run-1", "sub-0002");

			const result = await runSync(db, [new PiSubagentSource(fx.root)]);
			assert.equal(result.sessionsProcessed, 2);
			assert.equal(result.errors.length, 0);

			const rows = (await db
				.prepare("SELECT id, parent_session, source FROM sessions ORDER BY id")
				.all()) as Array<{ id: string; parent_session: string | null; source: string }>;
			assert.deepEqual(rows, [
				{ id: "sub-0001", parent_session: PARENT, source: "pi-subagent" },
				{ id: "sub-0002", parent_session: PARENT, source: "pi-subagent" },
			]);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("re-sync skips unchanged subagent files (cursor contract holds for adapters)", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		try {
			writeSubagentSession(fx.root, PARENT, "run-0", "sub-0001");
			await runSync(db, [new PiSubagentSource(fx.root)]);

			const result2 = await runSync(db, [new PiSubagentSource(fx.root)]);
			assert.equal(result2.sessionsProcessed, 0);
			assert.equal(result2.sessionsSkipped, 1);
		} finally {
			fx.cleanup();
			await close();
		}
	});

	it("a --source claude scope selects no subagent sessions; mixed adapters stay segmented", async () => {
		const { db, close } = await tempDb();
		const fx = makeRoot();
		// The Claude root is deliberately empty and separate: since #157 discovery
		// recurses into nested run trees whatever root it walks, so a claude root
		// sharing this fixture would legitimately claim the nested session.jsonl.
		const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-empty-claude-"));
		try {
			writeSubagentSession(fx.root, PARENT, "run-0", "sub-0001");

			const scoped = await runSync(
				db,
				[new PiFileSource(fx.root), new ClaudeFileSource(claudeRoot), new PiSubagentSource(fx.root)],
				{ source: "claude" },
			);
			assert.equal(scoped.sessionsProcessed, 0);

			const unscoped = await runSync(db, [
				new PiSubagentSource(fx.root),
			]);
			assert.equal(unscoped.sessionsProcessed, 1);
		} finally {
			fs.rmSync(claudeRoot, { recursive: true, force: true });
			fx.cleanup();
			await close();
		}
	});
});
