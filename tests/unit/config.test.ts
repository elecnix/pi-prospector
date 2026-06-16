import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getDbPath, getModelTiers, getSessionsDir, loadConfig } from "../../src/config.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

const ENV_KEYS = ["PROSPECTOR_CONFIG", "PROSPECTOR_DB_PATH", "PROSPECTOR_SESSIONS_DIR"];

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
});
