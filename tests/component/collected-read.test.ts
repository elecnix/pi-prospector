/**
 * The collected read puts the batches of one file together. Today only a source without
 * `readBatches` is read through `read()` by the sync loop (Codex, Cline, OpenCode and
 * custom sources); the three batched sources keep a `read()` for callers that want the
 * whole file. It must equal the batched result.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { collectBatches, type ParsedSession } from "../../src/sync/adapter.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude/index.js";
import { setBatchLimitsForTests } from "../../src/sync/line-batches.js";
import { claudeSessionFileName, makeTempRoot } from "./helpers.js";

const rec = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: "user", uuid: id, parentUuid: null, timestamp: "2026-02-01T09:00:00.000Z", cwd: "/tmp/p", message: { role: "user", content: id }, ...extra });

describe("a collected read equals the batched one", () => {
	it("keeps rebuilt and takes lastBatch, rows and cursor from a three-batch rebuilt file", async () => {
		const { root, cleanup } = makeTempRoot("prospect-collect-");
		try {
			const projects = path.join(root, "projects");
			const file = path.join(projects, "-tmp-p", claudeSessionFileName("collect"));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const lines = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => rec(`r${n}`, { restoredFrom: "pi-prospector" }));
			fs.writeFileSync(file, lines.join("\n") + "\n");
			const source = new ClaudeFileSource(projects);
			const [disc] = await source.discover();
			setBatchLimitsForTests({ maxLines: 4, maxBytes: 1e9, chunkBytes: 64 });
			const batches: ParsedSession[] = [];
			for await (const b of source.readBatches(disc!, 0)) batches.push(b);
			assert.equal(batches.length, 3);
			const collected = await source.read(disc!, 0);
			assert.equal(collected.rebuilt, true);
			assert.equal(collected.lastBatch, true);
			assert.equal(collected.messages.length, batches.reduce((n, b) => n + b.messages.length, 0));
			assert.equal(collected.processedCount, batches[2]!.processedCount);
			assert.deepEqual(collected.session, batches[2]!.session);
		} finally {
			setBatchLimitsForTests(null);
			cleanup();
		}
	});

	it("is rebuilt when any batch says so, and last when the final batch says so", async () => {
		const batch = (rebuilt: boolean, last: boolean): ParsedSession => ({
			session: { id: "s", file_path: "/x", project: "p", source: "claude", cwd: "", parent_session: null, started_at: "", last_line: 0, last_modified: 0, analyzed_at: null, message_count: 0, branch_count: 0, name: null, tool_inventory: null },
			messages: [], rebuilt, lastBatch: last, processedCount: 0, processedTimestamp: 0, forksResolved: 0,
		});
		async function* gen(): AsyncGenerator<ParsedSession> {
			yield batch(true, false);
			yield batch(false, false);
			yield batch(false, true);
		}
		const out = await collectBatches(gen());
		assert.equal(out.rebuilt, true);
		assert.equal(out.lastBatch, true);
	});
});
