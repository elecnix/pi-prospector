import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isChildRunSessionPath, parentSessionFromRunPath } from "../../src/sync/pi-naming.js";

const PARENT_ID = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const STEM = `/s/--proj/2026-08-19T01-00-00Z_${PARENT_ID}`;

describe("pi child-run layout", () => {
	it("recognises a run's session file only directly inside run-N", () => {
		assert.equal(isChildRunSessionPath(`${STEM}/2b83bd26/run-0/session.jsonl`), true);
		assert.equal(isChildRunSessionPath(`${STEM}/2b83bd26/run-12/session.jsonl`), true);
		assert.equal(isChildRunSessionPath(`${STEM}/2b83bd26/run-0/other.jsonl`), false);
		assert.equal(isChildRunSessionPath(`${STEM}/2b83bd26/runs/session.jsonl`), false);
		assert.equal(isChildRunSessionPath(`${STEM}.jsonl`), false);
	});

	it("reads the parent from the nearest session directory, for flat and nested runs", () => {
		assert.equal(parentSessionFromRunPath(`${STEM}/2b83bd26/run-0/session.jsonl`), PARENT_ID);
		assert.equal(parentSessionFromRunPath(`${STEM}/fffdcabd-711c-4e5e-ba5f-d9d77cb4afb7/run-0/session.jsonl`), PARENT_ID);
		assert.equal(parentSessionFromRunPath(`${STEM}/2b83bd26/run-0/session/4b5387b8/run-1/session.jsonl`), PARENT_ID);
		assert.equal(parentSessionFromRunPath("/s/--proj/loose/run-0/session.jsonl"), null);
	});
});
