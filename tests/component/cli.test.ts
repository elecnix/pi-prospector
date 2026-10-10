import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { FIXTURES } from "./helpers.js";
import { main } from "../../src/cli.js";
import type { ModelRegistry } from "../../src/pi-stubs.js";

/**
 * The standalone `prospect` command: the slash commands, run under plain Node
 * with no pi session. The model registry here fails every lookup, so a command
 * that reached for a model would fail the test.
 */

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "prospect.js");
const ENV = ["PROSPECTOR_CONFIG", "PROSPECTOR_DB_PATH", "PROSPECTOR_SESSIONS_DIR", "PROSPECTOR_CLAUDE_SESSIONS_DIR", "PROSPECTOR_ANALYZERS_DIR"];
let tmpDir: string;

const noModels: ModelRegistry = {
	find: () => {
		throw new Error("no model lookups in this test");
	},
	getAll: () => [],
	getAvailable: () => [],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no creds in test" }),
};

async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...parts: unknown[]) => void out.push(parts.join(" "));
	console.error = (...parts: unknown[]) => void err.push(parts.join(" "));
	try {
		const code = await main(argv, { modelRegistry: noModels });
		return { code, out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-cli-"));
	const configFile = path.join(tmpDir, "prospector.json");
	fs.writeFileSync(configFile, JSON.stringify({ defaultAnalyzers: ["turn-pair-core", "files-in-play"] }));
	process.env["PROSPECTOR_CONFIG"] = configFile;
	process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cli.db");
	process.env["PROSPECTOR_SESSIONS_DIR"] = FIXTURES;
	process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] = path.join(tmpDir, "no-claude-sessions");
	process.env["PROSPECTOR_ANALYZERS_DIR"] = path.join(tmpDir, "no-custom-analyzers");
});

after(() => {
	for (const k of ENV) delete process.env[k];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("prospect CLI", () => {
	it("lists every command when run with no arguments", async () => {
		const { code, out } = await capture([]);
		assert.equal(code, 0);
		assert.match(out, /Usage: prospect <command> \[args\]/);
		for (const name of ["sync", "analyze", "stats", "leaks", "search", "viz"]) {
			assert.match(out, new RegExp(`^  ${name} `, "m"), `usage lists ${name}`);
		}
	});

	it("prints a command's full description for help <command> and <command> --help", async () => {
		const viaHelp = await capture(["help", "analyze"]);
		const viaFlag = await capture(["analyze", "--help"]);
		assert.equal(viaHelp.code, 0);
		assert.match(viaHelp.out, /--backfill-missing/);
		assert.equal(viaFlag.out, viaHelp.out);
	});

	it("rejects an unknown command with exit code 2", async () => {
		const { code, err } = await capture(["nope"]);
		assert.equal(code, 2);
		assert.match(err, /Unknown command: nope/);
	});

	it("runs sync, analyze, and stats without a pi session", async () => {
		assert.equal((await capture(["sync"])).code, 0);
		const analyze = await capture(["analyze"]);
		assert.equal(analyze.code, 0);
		assert.match(analyze.out, /0 failed/);
		const stats = await capture(["stats"]);
		assert.equal(stats.code, 0);
		assert.match(stats.out, /Sessions/i);
	});

	it("passes the remaining arguments to the command", async () => {
		const { code, out } = await capture(["analyzers", "list"]);
		assert.equal(code, 0);
		assert.match(out, /session-ending .*off by default/);
	});

	it("asks the usage-report question before a command and sends the report after it (#290)", async () => {
		const calls: string[] = [];
		const log = console.log;
		console.log = () => undefined;
		try {
			await main(["stats"], {
				modelRegistry: noModels,
				askConsent: async () => void calls.push("ask"),
				sendReport: async () => void calls.push("send"),
			});
			await main(["telemetry", "status"], {
				modelRegistry: noModels,
				askConsent: async () => void calls.push("ask telemetry"),
				sendReport: async () => void calls.push("send telemetry"),
			});
		} finally {
			console.log = log;
		}
		assert.deepEqual(calls, ["ask", "send"]);
	});

	it("runs as an executable and exits when the command finishes", async () => {
		const { stdout } = await promisify(execFile)(process.execPath, [BIN, "stats"], { env: process.env, timeout: 60_000 });
		assert.match(stdout, /Sessions/i);
	});
});
