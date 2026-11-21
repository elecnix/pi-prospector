import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prospectFingerprint } from "../../src/commands/fingerprint.js";
import type { ExtensionCommandContext } from "../../src/pi-stubs.js";

/** `prospect fingerprint compare`: two fingerprint files in, a table out, and no database opened. */

let tmpDir: string;
const notes: Array<[string, string]> = [];
const ctx = () => ({ cwd: tmpDir, hasUI: false, ui: { notify: (m: string, l: string) => notes.push([m, l]) } }) as unknown as ExtensionCommandContext;

function fingerprint(count: number, toolFailures: number) {
	return {
		schemaVersion: 2,
		kind: "corpus-fingerprint",
		asOf: "2026-06-30",
		filter: { sources: null, from: null, to: null },
		minGroupSize: 5,
		sessions: { count },
		objective: { failures: { status: "ok", sessionsMeasured: count, turnFailures: 0, toolFailures, byClass: [] } },
		inferred: {},
	};
}

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-fingerprint-compare-"));
	process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "never-opened.db");
	fs.writeFileSync(path.join(tmpDir, "one.json"), JSON.stringify(fingerprint(10, 5)));
	fs.writeFileSync(path.join(tmpDir, "two.json"), JSON.stringify(fingerprint(40, 80)));
});

after(() => {
	delete process.env["PROSPECTOR_DB_PATH"];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("prospect fingerprint compare", () => {
	it("writes the comparison of two files relative to the cwd, without opening the database", async () => {
		await prospectFingerprint("compare one.json two.json --format markdown --out cmp.md", ctx());
		const md = fs.readFileSync(path.join(tmpDir, "cmp.md"), "utf8");
		assert.match(md, /^# Corpus fingerprint comparison/);
		assert.match(md, /\| tool failures per session \| 0\.50 \| 2\.00 \| ×4\.0 \|/);
		assert.equal(fs.existsSync(path.join(tmpDir, "never-opened.db")), false);
	});

	it("reports a file that is not a fingerprint", async () => {
		fs.writeFileSync(path.join(tmpDir, "bad.json"), "{}");
		await prospectFingerprint("compare one.json bad.json", ctx());
		assert.match(notes.at(-1)![0], /prospect fingerprint: bad\.json is not a corpus fingerprint/);
	});
});
