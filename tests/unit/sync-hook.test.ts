import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSyncHook } from "../../src/commands/sync.js";

describe("runSyncHook", () => {
	it("does nothing when no hook is configured", async () => {
		assert.equal(await runSyncHook({}), undefined);
		assert.equal(await runSyncHook({ syncHook: { command: "  " } }), undefined);
	});

	it("runs the command through the shell, and reports it", async () => {
		const marker = path.join(os.tmpdir(), `hook-${Date.now()}.txt`);
		const result = await runSyncHook({ syncHook: { command: `printf 'ran' > ${marker}` } });
		assert.equal(result?.ok, true);
		assert.equal(fs.readFileSync(marker, "utf8"), "ran");
		fs.unlinkSync(marker);
	});

	it("reports a failure instead of throwing, so a stale archive still indexes", async () => {
		const result = await runSyncHook({ syncHook: { command: "sh -c 'echo archive unreachable >&2; exit 1'" } });
		assert.equal(result?.ok, false);
		assert.match(result?.error ?? "", /archive unreachable/);
	});
});
