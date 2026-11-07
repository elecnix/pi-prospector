import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ProspectorConfig } from "./types.js";
import { DEFAULT_MODEL_TIERS } from "./analyze/model-tiers.js";
import type { ModelTierConfig } from "./analyze/types.js";
import { Check } from "typebox/value";
import { LexiconMode, normalizeDictionary } from "./analyze/analyzers/turn-frustration/dictionary.js";

/** The analyzers `lexicon` configures, by id. */
const TURN_FRUSTRATION_ID = "turn-frustration";
const FRUSTRATION_LEXICON_ID = "frustration-lexicon";

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.json");
const DEFAULT_DB_PATH = path.join(os.homedir(), ".pi", "agent", "prospector.db");
const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "projects");
/** Where the Pi coding agent drops locally-authored custom analyzers. */
const PI_AGENT_ANALYZERS_DIR = path.join(os.homedir(), ".pi", "agent", "prospector", "analyzers");
/** Project-local convention dir, resolved against the current working directory. */
const PROJECT_ANALYZERS_DIR = path.join(".prospector", "analyzers");

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

export function getClaudeSessionsDir(): string {
	return process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] ?? CLAUDE_SESSIONS_DIR;
}

/** Where Codex writes its session rollouts. */
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");

/**
 * The Codex sessions root. Codex organises its rollouts by date
 * (`YYYY/MM/DD/rollout-*.jsonl`), not by project, so the tree holds no
 * project directories — each session records the directory it ran in.
 */
export function getCodexSessionsDir(): string {
	return process.env["PROSPECTOR_CODEX_SESSIONS_DIR"] ?? CODEX_SESSIONS_DIR;
}

/**
 * OpenCode's data directory, which holds its `opencode.db`. OpenCode resolves
 * it as `$XDG_DATA_HOME/opencode`, `~/.local/share/opencode` when that is unset,
 * on every platform.
 */
export function getOpenCodeDataDir(): string {
	const override = process.env["PROSPECTOR_OPENCODE_DATA_DIR"];
	if (override !== undefined) return override;
	const xdgData = process.env["XDG_DATA_HOME"] || path.join(os.homedir(), ".local", "share");
	return path.join(xdgData, "opencode");
}

/**
 * Cline's sessions root, which holds one directory per session. Cline resolves
 * it from `CLINE_SESSION_DATA_DIR`, then `CLINE_DATA_DIR/sessions`, then
 * `CLINE_DIR/data/sessions`, then `~/.cline/data/sessions`.
 */
export function getClineSessionsDir(): string {
	const override = process.env["PROSPECTOR_CLINE_SESSIONS_DIR"];
	if (override !== undefined) return override;
	const sessionDir = process.env["CLINE_SESSION_DATA_DIR"]?.trim();
	if (sessionDir) return sessionDir;
	const dataDir = process.env["CLINE_DATA_DIR"]?.trim();
	if (dataDir) return path.join(dataDir, "sessions");
	const clineDir = process.env["CLINE_DIR"]?.trim() || path.join(os.homedir(), ".cline");
	return path.join(clineDir, "data", "sessions");
}

/**
 * Per-analyzer config overrides from `~/.pi/agent/prospector.json`, keyed by
 * analyzer id. Merged over each analyzer's shipped defaults by the framework.
 */
export function getAnalyzerConfigOverrides(config?: ProspectorConfig): Record<string, Record<string, unknown>> {
	const c = config ?? loadConfig();
	const overrides: Record<string, Record<string, unknown>> = { ...(c.analyzers ?? {}) };
	for (const [id, fields] of Object.entries(lexiconOverrides(c))) {
		overrides[id] = { ...overrides[id], ...fields };
	}
	return overrides;
}

/**
 * The analyzer config fields that `lexicon` in prospector.json sets.
 *
 * Nothing at all in `model` mode, so the default leaves every config
 * fingerprint, and therefore every node, exactly as it was. In `dictionary` and
 * `both` mode, turn-frustration gets the mode and the normalised dictionary, so
 * editing an entry marks its hits stale for `config`. frustration-lexicon gets
 * `adjudicate: false` in `dictionary` mode only: `both` keeps its fingerprint,
 * so every verdict the corpus already paid for stays current.
 */
function lexiconOverrides(c: ProspectorConfig): Record<string, Record<string, unknown>> {
	const mode: unknown = c.lexicon?.mode ?? "model";
	if (!Check(LexiconMode, mode)) {
		throw new Error(`lexicon.mode must be "model", "dictionary", or "both", not ${JSON.stringify(mode)}.`);
	}
	if (mode === "model") return {};
	const dictionary = normalizeDictionary(readDictionary(c.lexicon?.dictionary));
	if (dictionary.length === 0) {
		throw new Error(`lexicon.mode is "${mode}", but lexicon.dictionary has no entries.`);
	}
	const out: Record<string, Record<string, unknown>> = {
		[TURN_FRUSTRATION_ID]: { lexiconMode: mode, dictionary },
	};
	if (mode === "dictionary") out[FRUSTRATION_LEXICON_ID] = { adjudicate: false };
	return out;
}

/** The dictionary entries, read from a JSON file when `lexicon.dictionary` is a path. */
function readDictionary(value: unknown): unknown[] {
	if (value === undefined) return [];
	if (Array.isArray(value)) return value;
	if (typeof value !== "string") {
		throw new Error("lexicon.dictionary must be an array of entries or the path to a JSON file holding one.");
	}
	const file = path.resolve(path.dirname(configPath()), value.replace(/^~/, os.homedir()));
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch (err) {
		throw new Error(`Cannot read lexicon.dictionary file ${file}: ${(err as Error).message}`);
	}
	if (!Array.isArray(parsed)) {
		throw new Error(`lexicon.dictionary file ${file} must hold a JSON array of entries.`);
	}
	return parsed;
}

/**
 * The default analyzer set (#291): `defaultAnalyzers` (every registered analyzer
 * when absent, nothing when `[]`) minus `disabledAnalyzers`, in registration
 * order. `unknown` lists each configured id that matches no registered analyzer,
 * with the field it came from, so the caller can say which field has the typo or
 * the custom analyzer that failed to load.
 */
export function resolveDefaultAnalyzers(
	registeredIds: readonly string[],
	config?: ProspectorConfig,
): { ids: string[]; unknown: Array<{ field: "defaultAnalyzers" | "disabledAnalyzers"; id: string }> } {
	const c = config ?? loadConfig();
	const allow = c.defaultAnalyzers ? new Set(c.defaultAnalyzers) : undefined;
	const deny = new Set(c.disabledAnalyzers ?? []);
	const registered = new Set(registeredIds);
	const ids = registeredIds.filter((id) => (allow ? allow.has(id) : true) && !deny.has(id));
	const unknownIn = (field: "defaultAnalyzers" | "disabledAnalyzers", list: Iterable<string>) =>
		[...new Set(list)].filter((id) => !registered.has(id)).map((id) => ({ field, id }));
	const unknown = [...unknownIn("defaultAnalyzers", allow ?? []), ...unknownIn("disabledAnalyzers", deny)];
	return { ids, unknown };
}

/** Resolve the model-tier mapping, falling back to defaults. */
export function getModelTiers(config?: ProspectorConfig): ModelTierConfig {
	const c = config ?? loadConfig();
	if (c.modelTiers) return c.modelTiers;
	return DEFAULT_MODEL_TIERS;
}

/**
 * The Pi agent analyzers directory (~/.pi/agent/prospector/analyzers),
 * overridable via PROSPECTOR_ANALYZERS_DIR for tests.
 */
export function getPiAgentAnalyzersDir(): string {
	return process.env["PROSPECTOR_ANALYZERS_DIR"] ?? PI_AGENT_ANALYZERS_DIR;
}

/**
 * Default maximum wall-clock for a single LLM call in an analyze run. A call that
 * exceeds this is treated as stalled and fails the unit rather than holding a
 * concurrency slot forever and stalling the whole overlay. 120s is generous enough
 * for deliberate reasoning-model calls while still converting a hung provider into
 * a real, terminal per-session failure. Overridable via `PROSPECTOR_LLM_TIMEOUT_MS`
 * or the `llmTimeoutMs` config field.
 */
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/**
 * Resolve the per-LLM-call timeout in milliseconds. Precedence: the
 * `PROSPECTOR_LLM_TIMEOUT_MS` env var, then the `llmTimeoutMs` config field, then
 * the default. Non-positive or non-numeric values fall back to the default.
 */
export function getLlmTimeoutMs(config?: ProspectorConfig): number {
	const c = config ?? loadConfig();
	const fromEnv = parseMs(process.env["PROSPECTOR_LLM_TIMEOUT_MS"]);
	if (fromEnv !== undefined) return fromEnv;
	if (typeof c.llmTimeoutMs === "number" && Number.isFinite(c.llmTimeoutMs) && c.llmTimeoutMs > 0) {
		return c.llmTimeoutMs;
	}
	return DEFAULT_LLM_TIMEOUT_MS;
}

/** Parse a positive millisecond count, or undefined for anything unusable. */
function parseMs(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve every path custom analyzers are loaded from, in precedence order:
 * explicit (CLI) → config `analyzerPaths` → project ./.prospector/analyzers →
 * Pi agent dir. A leading ~ in config paths is expanded.
 */
export function getAnalyzerPaths(explicit: string[] = [], config?: ProspectorConfig): string[] {
	const c = config ?? loadConfig();
	const expanded = (c.analyzerPaths ?? []).map((p) => p.replace(/^~/, os.homedir()));
	const ordered = [
		...explicit,
		...expanded,
		path.resolve(process.cwd(), PROJECT_ANALYZERS_DIR),
		getPiAgentAnalyzersDir(),
	];
	const seen = new Set<string>();
	return ordered.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}