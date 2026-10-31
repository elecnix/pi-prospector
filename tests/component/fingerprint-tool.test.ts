import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Check } from "typebox/value";
import { executeProspectTool } from "../../src/commands/tool.js";
import { Fingerprint } from "../../src/fingerprint/schema.js";
import type { ExtensionCommandContext } from "../../src/pi-stubs.js";

/** The `fingerprint` action of the `prospect` tool: the same fingerprint the command prints. */

let tmpDir: string;
const ctx = { cwd: process.cwd(), hasUI: false, ui: { notify: () => undefined } } as unknown as ExtensionCommandContext;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-fingerprint-tool-"));
	process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "tool.db");
});

after(() => {
	delete process.env["PROSPECTOR_DB_PATH"];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = (params: Record<string, unknown>) => executeProspectTool("id", params, new AbortController().signal, undefined, ctx);

describe("prospect tool: fingerprint action", () => {
	it("returns a fingerprint that matches the schema, as text and as details", async () => {
		const result = await call({ action: "fingerprint", as_of: "2030-01-01" });
		assert.ok(Check(Fingerprint, result.details), "details do not match the schema");
		assert.deepEqual(JSON.parse(result.content[0]!.text), result.details);
		assert.equal((result.details as Fingerprint).asOf, "2030-01-01");
	});

	it("passes source, from and to into the filter", async () => {
		const result = await call({ action: "fingerprint", source: "pi,claude", from: "2026-01-01", to: "2026-02-01" });
		assert.deepEqual((result.details as Fingerprint).filter, { sources: ["pi", "claude"], from: "2026-01-01", to: "2026-02-01" });
	});

	it("reports a bad argument as text instead of throwing", async () => {
		const result = await call({ action: "fingerprint", source: "vim" });
		assert.match(result.content[0]!.text, /prospect fingerprint: unknown source/);
	});
});
