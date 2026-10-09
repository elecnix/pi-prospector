import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { workerExecArgv } from "../../src/db/async-db.js";

describe("sqlite worker exec arguments", () => {
	it("starts a .ts worker with no loader flags when Node strips types itself", () => {
		// The worker imports only better-sqlite3 and node builtins, so Node's own
		// type stripping can run it. Inheriting `--import tsx` costs each worker a
		// loader thread and about 1.4 s of wall time on a busy machine.
		assert.deepEqual(workerExecArgv(".ts", "strip"), []);
		assert.deepEqual(workerExecArgv(".ts", "transform"), []);
	});

	it("inherits the parent's flags when Node cannot run a .ts file on its own", () => {
		assert.equal(workerExecArgv(".ts", false), undefined);
	});

	it("inherits the parent's flags for the compiled .js worker", () => {
		assert.equal(workerExecArgv(".js", "strip"), undefined);
	});
});
