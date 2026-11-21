import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { insertSession } from "./helpers.js";
import { openAsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { prospectFingerprint } from "../../src/commands/fingerprint.js";
import { executeProspectTool } from "../../src/commands/tool.js";
import type { ExtensionCommandContext } from "../../src/pi-stubs.js";

/**
 * The fingerprint is a read of the index: it opens the database read-only,
 * never migrates it, and refuses an index whose schema is older than this
 * build instead of upgrading it.
 */

let tmpDir: string;

function digest(file: string): { sha: string; mtimeMs: number } {
	return { sha: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), mtimeMs: fs.statSync(file).mtimeMs };
}

/** Run the command with stdout captured, and return what it printed and what it notified. */
async function run(args: string): Promise<{ out: string; notes: Array<{ message: string; level: string | undefined }> }> {
	const notes: Array<{ message: string; level: string | undefined }> = [];
	const ctx = { cwd: tmpDir, hasUI: false, ui: { notify: (message: string, level?: string) => void notes.push({ message, level }) } } as unknown as ExtensionCommandContext;
	const out: string[] = [];
	const log = console.log;
	console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
	try {
		await prospectFingerprint(args, ctx);
	} finally {
		console.log = log;
	}
	return { out: out.join("\n"), notes };
}

async function currentIndex(file: string): Promise<void> {
	const db = openAsyncDatabase(file);
	await migrate(db);
	await insertSession(db, "s-1");
	await db.close();
}

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-fingerprint-readonly-"));
});

after(() => {
	delete process.env["PROSPECTOR_DB_PATH"];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("prospect fingerprint opens the index read-only", () => {
	it("leaves a current index unchanged, byte for byte and in its modification time", async () => {
		const file = path.join(tmpDir, "current.db");
		await currentIndex(file);
		process.env["PROSPECTOR_DB_PATH"] = file;
		const before = digest(file);
		const { out, notes } = await run("--as-of 2030-01-01");
		assert.deepEqual(notes.filter((n) => n.level === "error"), []);
		assert.equal(JSON.parse(out).sessions.count, 1);
		assert.deepEqual(digest(file), before);
	});

	it("refuses an index older than this build, names the command that upgrades it, and leaves it as it was", async () => {
		const file = path.join(tmpDir, "old.db");
		const old = openAsyncDatabase(file);
		await old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
		await old.close();
		process.env["PROSPECTOR_DB_PATH"] = file;
		const before = digest(file);
		const { out, notes } = await run("");
		assert.equal(out, "");
		const error = notes.find((n) => n.level === "error");
		assert.ok(error, "no error was reported");
		assert.match(error.message, /older than this version/);
		assert.match(error.message, /prospect sync/);
		assert.deepEqual(digest(file), before);
	});

	it("reports a missing index without creating one", async () => {
		const file = path.join(tmpDir, "missing.db");
		process.env["PROSPECTOR_DB_PATH"] = file;
		const { notes } = await run("");
		const error = notes.find((n) => n.level === "error");
		assert.ok(error, "no error was reported");
		assert.match(error.message, /no index at .*missing\.db.*prospect sync/);
		assert.equal(fs.existsSync(file), false);
	});

	it("leaves the index unchanged when the prospect tool asks for a fingerprint", async () => {
		const file = path.join(tmpDir, "tool.db");
		await currentIndex(file);
		process.env["PROSPECTOR_DB_PATH"] = file;
		const before = digest(file);
		const ctx = { cwd: tmpDir, hasUI: false, ui: { notify: () => undefined } } as unknown as ExtensionCommandContext;
		const result = await executeProspectTool("id", { action: "fingerprint", as_of: "2030-01-01" }, new AbortController().signal, undefined, ctx);
		assert.equal(JSON.parse(result.content[0]!.text).sessions.count, 1);
		assert.deepEqual(digest(file), before);
	});
});
