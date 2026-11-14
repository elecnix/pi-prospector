import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAnalyzerPaths, getDbPath, getLlmTimeoutMs, getModelTiers, getPiAgentAnalyzersDir, getRoots, getSessionsDir, loadConfig } from "../../src/config.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

const ENV_KEYS = ["PROSPECTOR_CONFIG", "PROSPECTOR_DB_PATH", "PROSPECTOR_SESSIONS_DIR", "PROSPECTOR_ANALYZERS_DIR", "PROSPECTOR_LLM_TIMEOUT_MS"];

afterEach(() => {
	for (const k of ENV_KEYS) delete process.env[k];
});

describe("config", () => {
	it("returns {} when no config file is present", () => {
		process.env["PROSPECTOR_CONFIG"] = path.join(os.tmpdir(), `nope-${Date.now()}.json`);
		assert.deepEqual(loadConfig(), {});
	});

	it("loads a config file via PROSPECTOR_CONFIG", () => {
		const file = path.join(os.tmpdir(), `cfg-${Date.now()}.json`);
		fs.writeFileSync(file, JSON.stringify({ model: "anthropic/x", dbPath: "/tmp/x.db" }));
		process.env["PROSPECTOR_CONFIG"] = file;
		try {
			const c = loadConfig();
			assert.equal(c.model, "anthropic/x");
			assert.equal(getDbPath(c), "/tmp/x.db");
		} finally {
			fs.unlinkSync(file);
		}
	});

	it("expands a leading ~ in dbPath", () => {
		assert.equal(getDbPath({ dbPath: "~/foo.db" }), path.join(os.homedir(), "/foo.db"));
	});

	it("honours PROSPECTOR_DB_PATH when config has none", () => {
		process.env["PROSPECTOR_DB_PATH"] = "/tmp/env.db";
		assert.equal(getDbPath({}), "/tmp/env.db");
	});

	it("honours PROSPECTOR_SESSIONS_DIR", () => {
		process.env["PROSPECTOR_SESSIONS_DIR"] = "/tmp/sessions";
		assert.equal(getSessionsDir(), "/tmp/sessions");
	});

	it("getModelTiers falls back to defaults and respects config", () => {
		assert.deepEqual(getModelTiers({}), DEFAULT_MODEL_TIERS);
		const custom = { cheap: "a/b", mid: "c/d", expensive: "e/f" };
		assert.deepEqual(getModelTiers({ modelTiers: custom }), custom);
	});

	it("getPiAgentAnalyzersDir defaults under ~/.pi/agent and honours the env override", () => {
		assert.equal(getPiAgentAnalyzersDir(), path.join(os.homedir(), ".pi", "agent", "prospector", "analyzers"));
		process.env["PROSPECTOR_ANALYZERS_DIR"] = "/tmp/custom-analyzers";
		assert.equal(getPiAgentAnalyzersDir(), "/tmp/custom-analyzers");
	});

	it("getAnalyzerPaths orders explicit → config → project → Pi agent dir and expands ~", () => {
		process.env["PROSPECTOR_ANALYZERS_DIR"] = "/agent/dir";
		const paths = getAnalyzerPaths(["/explicit/one.analyzer.ts"], { analyzerPaths: ["~/cfg"] });
		assert.equal(paths[0], "/explicit/one.analyzer.ts");
		assert.equal(paths[1], path.join(os.homedir(), "/cfg"));
		assert.equal(paths[2], path.resolve(process.cwd(), ".prospector", "analyzers"));
		assert.equal(paths[3], "/agent/dir");
	});

	it("getLlmTimeoutMs defaults when unset", () => {
		delete process.env["PROSPECTOR_LLM_TIMEOUT_MS"];
		assert.equal(getLlmTimeoutMs({}), 120_000);
	});

	it("getLlmTimeoutMs honours the config field", () => {
		delete process.env["PROSPECTOR_LLM_TIMEOUT_MS"];
		assert.equal(getLlmTimeoutMs({ llmTimeoutMs: 5000 }), 5000);
	});

	it("getLlmTimeoutMs env wins over config and falls back for invalid values", () => {
		process.env["PROSPECTOR_LLM_TIMEOUT_MS"] = "9000";
		assert.equal(getLlmTimeoutMs({ llmTimeoutMs: 5000 }), 9000);
		process.env["PROSPECTOR_LLM_TIMEOUT_MS"] = "not-a-number";
		assert.equal(getLlmTimeoutMs({ llmTimeoutMs: 5000 }), 5000);
		process.env["PROSPECTOR_LLM_TIMEOUT_MS"] = "0";
		assert.equal(getLlmTimeoutMs({}), 120_000);
	});
});

describe("getRoots", () => {
	it("gives each local adapter its default directory, on this machine", () => {
		const roots = getRoots({});
		assert.deepEqual(roots.map((r) => r.source), ["pi", "claude", "codex"]);
		for (const r of roots) assert.equal(r.host, os.hostname());
		assert.equal(roots[0]?.root, getSessionsDir());
	});

	it("reads the configured roots instead, with their own host names", () => {
		const roots = getRoots({
			roots: [
				{ source: "pi", host: "vandenberg", root: "~/.pi/agent/sessions" },
				{ source: "pi", host: "hawthorne", root: "~/mirror/hosts/hawthorne/pi/sessions" },
			],
		});
		assert.equal(roots.length, 2);
		assert.equal(roots[0]?.root, path.join(os.homedir(), ".pi/agent/sessions"));
		assert.equal(roots[1]?.host, "hawthorne");
	});

	it("keeps the local host name for an entry that names none", () => {
		const roots = getRoots({ roots: [{ source: "claude", root: "/tmp/claude-projects" } as never] });
		assert.equal(roots[0]?.host, os.hostname());
	});

	it("refuses an entry with no root, rather than indexing the default tree under a wrong host", () => {
		assert.throws(() => getRoots({ roots: [{ source: "pi", host: "hawthorne" } as never] }), /roots\[0\]/);
	});
});
