import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ProspectorConfig } from "./types.js";
import { DEFAULT_MODEL_TIERS } from "./analyze/model-tiers.js";
import type { ModelTierConfig } from "./analyze/types.js";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.json");
const DEFAULT_DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

/** Path to the JSON config, overridable via PROSPECTOR_CONFIG (used by tests). */
function configPath(): string {
	return process.env["PROSPECTOR_CONFIG"] ?? DEFAULT_CONFIG_PATH;
}

export function loadConfig(): ProspectorConfig {
	try {
		const raw = fs.readFileSync(configPath(), "utf-8");
		return JSON.parse(raw) as ProspectorConfig;
	} catch {
		return {};
	}
}

export function getDbPath(config?: ProspectorConfig): string {
	const c = config ?? loadConfig();
	if (c.dbPath) return c.dbPath.replace(/^~/, os.homedir());
	if (process.env["PROSPECTOR_DB_PATH"]) return process.env["PROSPECTOR_DB_PATH"]!;
	return DEFAULT_DB_PATH;
}

export function getSessionsDir(): string {
	return process.env["PROSPECTOR_SESSIONS_DIR"] ?? DEFAULT_SESSIONS_DIR;
}

/** Resolve the model-tier mapping, falling back to defaults. */
export function getModelTiers(config?: ProspectorConfig): ModelTierConfig {
	const c = config ?? loadConfig();
	if (c.modelTiers) return c.modelTiers;
	return DEFAULT_MODEL_TIERS;
}