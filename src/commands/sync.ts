import type { ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase } from "../db/async-db.js";
import type { AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import type { SyncResult } from "../types.js";
import type { SessionSourceAdapter } from "../sync/adapter.js";
import { PiFileSource } from "../sync/sources/pi-file.js";
import { ClaudeFileSource } from "../sync/sources/claude-file.js";
import { CodexFileSource } from "../sync/sources/codex-file.js";
import { OpenCodeDbSource } from "../sync/sources/opencode-db.js";
import { ClineFileSource } from "../sync/sources/cline-file.js";
import { PiSubagentSource } from "../sync/sources/pi-subagent.js";
import { parseHarnessSource } from "../harness.js";
import { loadCustomSources, resolveSourcePaths } from "../sync/source-loader.js";
import {
	loadConfig,
	getDbPath,
	getSessionsDir,
	getClaudeSessionsDir,
	getCodexSessionsDir,
	getOpenCodeDataDir,
	getClineSessionsDir,
} from "../config.js";
import type { HarnessSource } from "../harness.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/** Where the Pi coding agent hosts locally-authored custom sources. */
const PI_AGENT_SOURCES_DIR = path.join(os.homedir(), ".pi", "agent", "prospector", "sources");
/** Project-local convention dir, resolved against the current working directory. */
const PROJECT_SOURCES_DIR = path.join(".prospector", "sources");

/**
 * Composition root for session sources: the built-in harness sources, plus
 * any extra source named in config `sources` (e.g. "pi-subagent").
 *
 * The pi-subagent adapter is deliberately registered *before* PiFileSource:
 * since #157 the shared walker recurses into nested run directories, so both
 * adapters discover <project>/<ts>_<uuid>/<runhash>/run-N/session.jsonl files.
 * runSync claims each file once, first adapter wins — and the subagent adapter
 * parses strictly more than the plain one (it additionally recovers the parent
 * session id from the enclosing UUID directory), so it must claim them first.
 */
export function sourceDiscoveryPaths(): string[] {
	return resolveSourcePaths({ userDir: PI_AGENT_SOURCES_DIR, projectDir: path.resolve(process.cwd(), PROJECT_SOURCES_DIR) });
}

/**
 * Discover and load the custom sources config `sources` names beyond the
 * built-in tags. A name that matches no directory, a module that fails to
 * import, and a tag collision are all returned as errors — the caller decides
 * whether they are fatal (the sync command surfaces them in its output).
 */
export async function buildCustomAdapters(config = loadConfig()): Promise<{ adapters: SessionSourceAdapter[]; errors: string[] }> {
	const names = (config.sources ?? []).filter((s) => !isBuiltinSourceName(s));
	const { loaded, errors } = await loadCustomSources({ names, paths: sourceDiscoveryPaths(), builtinIds: BUILTIN_SOURCE_TAGS });
	return { adapters: loaded, errors: errors.map((e) => (e.file ? `${e.name} (${e.file}): ${e.message}` : e.message)) };
}

/** Tags the built-in adapters claim, which a custom source must not take. */
const BUILTIN_SOURCE_TAGS = ["pi", "claude", "codex", "opencode", "cline", "pi-subagent"];

/** True when a config `sources` entry names a built-in source. */
function isBuiltinSourceName(name: string): boolean {
	return name === "pi-subagent" || BUILTIN_SOURCE_TAGS.includes(name);
}

export function buildAdapters(): SessionSourceAdapter[] {
	const adapters: SessionSourceAdapter[] = [
		new ClaudeFileSource(getClaudeSessionsDir()),
		new CodexFileSource(getCodexSessionsDir()),
		new OpenCodeDbSource(getOpenCodeDataDir()),
		new ClineFileSource(getClineSessionsDir()),
	];

	const sources = loadConfig().sources ?? [];

	if (sources.includes("pi-subagent")) {
		adapters.push(new PiSubagentSource(getSessionsDir()));
	}
	adapters.push(new PiFileSource(getSessionsDir()));

	return adapters;
}

/** Sync the built-in adapters plus any custom sources config `sources` names, surfacing load errors in the result. */
export async function runProspectSync(db: AsyncDatabase, opts?: { project?: string; source?: HarnessSource }): Promise<SyncResult> {
	const { adapters, errors } = await buildCustomAdapters();
	// A source that reads local evidence (dedup against this very index)
	// declares a writable `db` field and gets the sync's own handle. The field
	// is optional: sources without it never see the database.
	for (const a of adapters) {
		if ("db" in a) (a as { db: unknown }).db = db;
	}
	const result = await runSync(db, [...adapters, ...buildAdapters()], opts);
	// A custom source that failed to load is a sync error like any other, but
	// it produces no session rows, so surface it even when every adapter ran.
	result.errors.push(...errors);
	return result;
}

export async function prospectSync(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const dbPath = getDbPath();
	const db = openAsyncDatabase(dbPath);
	await migrate(db);

	const args = parseSyncArgs(rawArgs ?? "");

	try {
		const result = await runProspectSync(db, {
			project: args.project,
			source: args.source,
		});
		const lines = [
			"⛏️ Prospect sync complete",
			`  Sessions processed: ${result.sessionsProcessed}`,
			`  Sessions skipped:   ${result.sessionsSkipped}`,
			`  Messages inserted:  ${result.messagesInserted}`,
			`  Forks resolved:     ${result.forksResolved}`,
			`  Subagent runs:      ${result.subagentRunsProcessed} ingested, ${result.subagentRunsSkipped} unchanged`,
		];
		if (args.project || args.source) {
			lines.push(`  Scope: ${[args.project && `project ${args.project}`, args.source && `source ${args.source}`].filter(Boolean).join(" + ")}`);
		}
		if (result.errors.length > 0) {
			lines.push(`  Errors: ${result.errors.length}`);
			for (const e of result.errors.slice(0, 5)) lines.push(`    ${e}`);
		}
		const text = lines.join("\n");
		console.log(text);
		ctx.ui.notify(text, "info");
	} finally {
		await db.close();
	}
}

interface SyncArgs {
	project?: string;
	source?: HarnessSource;
}

function parseSyncArgs(raw: string): SyncArgs {
	const result: SyncArgs = {};
	const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--project" && parts[i + 1]) result.project = parts[++i]!;
		else if (p === "--source" && parts[i + 1]) {
			// Unknown values throw (parseHarnessSource), so a typo fails loudly.
			result.source = parseHarnessSource(parts[++i]!);
		}
	}
	return result;
}
