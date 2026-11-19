import type { ExtensionCommandContext } from "../pi-stubs.js";
import { getRoots } from "../config.js";
import { openAsyncDatabase } from "../db/async-db.js";
import type { AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { runSync, type FileEvent } from "../sync/index.js";
import type { SyncResult } from "../types.js";
import { sortSourceAdapters } from "../sync/adapter.js";
import type { SessionSourceAdapter } from "../sync/adapter.js";
import { parseHarnessSource } from "../harness.js";
import { discoverSourceNames, loadCustomSources, resolveSourcePaths } from "../sync/source-loader.js";
import { loadConfig, getDbPath } from "../config.js";
import type { HarnessSource } from "../harness.js";
import type { ProspectorConfig, RootConfig } from "../types.js";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

/** Where the Pi coding agent hosts locally-authored custom sources. */
const PI_AGENT_SOURCES_DIR = path.join(os.homedir(), ".pi", "agent", "prospector", "sources");
/** Project-local convention dir, resolved against the current working directory. */
const PROJECT_SOURCES_DIR = path.join(".prospector", "sources");

/**
 * The package's own built-in sources: one directory per source under
 * `src/sync/sources`, the same directory shape the custom-source loader
 * resolves, but read directly — a discovery path where precedence does not
 * apply — so a working tree cannot displace a built-in.
 */
const BUILTIN_SOURCES_DIR = fileURLToPath(new URL("../sync/sources/", import.meta.url));

/**
 * Where config, project, and user custom sources are discovered, highest
 * precedence first. The built-ins are not part of this list: they load from
 * the package's own sources directory in `buildSourceAdapters`, so a working
 * tree cannot displace one by dropping a same-named directory into a
 * project-local dir.
 */
export function sourceDiscoveryPaths(config: ProspectorConfig = loadConfig()): string[] {
	return resolveSourcePaths({
		config,
		projectDir: path.resolve(process.cwd(), PROJECT_SOURCES_DIR),
		userDir: PI_AGENT_SOURCES_DIR,
	});
}

/**
 * The adapters one sync runs: the built-in sources plus every custom source
 * config `sources` names, ordered by each adapter's declared priority.
 *
 * Built-ins and customs load through the same loader. The built-ins load from
 * the package's own sources directory only, so a working tree cannot displace
 * one by dropping a same-named directory into a project-local dir; their tags
 * are then collected into the reserved set a custom source must not claim
 * (including one that fails to load, which still reserves its name). The
 * names themselves are discovered from `src/sync/sources`, never a hand-kept
 * list. A built-in runs unless it declares `enabledByDefault: false` and
 * config does not name it (pi-subagent). A name that matches no directory, a
 * module that fails to import, and a tag collision are returned as errors —
 * the caller decides whether they are fatal (the sync command surfaces them
 * in its output).
 */
export async function buildSourceAdapters(config: ProspectorConfig = loadConfig()): Promise<{ adapters: SessionSourceAdapter[]; errors: string[] }> {
	const { names: selected, error } = sourceNames(config);
	const paths = sourceDiscoveryPaths(config);
	const builtinNames = discoverSourceNames(BUILTIN_SOURCES_DIR);
	const builtins = await loadCustomSources({ names: builtinNames, paths: [BUILTIN_SOURCES_DIR] });
	const errors: string[] = [];
	if (error) errors.push(error);
	for (const e of builtins.errors) errors.push(e.file ? `${e.name} (${e.file}): ${e.message}` : e.message);

	const enabledBuiltins = builtins.loaded.filter((a) => a.enabledByDefault !== false || selected.includes(a.source));
	const reservedTags = [...new Set([...builtinNames, ...builtins.loaded.map((a) => a.source)])];
	const customNames = selected.filter((s) => !builtinNames.includes(s));
	const customs = await loadCustomSources({ names: customNames, paths, builtinIds: reservedTags });
	for (const e of customs.errors) errors.push(e.file ? `${e.name} (${e.file}): ${e.message}` : e.message);

	// A configured root list turns one built-in adapter into one instance per root, each
	// carrying the machine it reads. Adapters that take no root in their constructor keep a
	// single instance: expanding one would read the same tree twice under two names.
	return { adapters: sortSourceAdapters([...expandRoots(enabledBuiltins, config), ...customs.loaded]), errors };
}

/**
 * The source names `config.sources` selects, or the reason it names none.
 *
 * `loadConfig` casts parsed JSON without checking it, so a hand edit can leave
 * `sources` as a string. Calling `.filter` on that value threw a TypeError out
 * of the sync command, so the field is checked here, once, and the caller
 * reports the message like any other load failure.
 */
function sourceNames(config: ProspectorConfig): { names: string[]; error?: string } {
	const raw: unknown = config.sources;
	if (raw === undefined) return { names: [] };
	if (!Array.isArray(raw) || raw.some((s) => typeof s !== "string")) {
		return { names: [], error: "config 'sources' must be an array of source names" };
	}
	return { names: raw as string[] };
}

/** Sync the built-in adapters plus any custom sources config `sources` names, surfacing load errors in the result. */
export async function runProspectSync(db: AsyncDatabase, opts?: { project?: string; source?: HarnessSource; reread?: boolean; onFile?: (event: FileEvent) => void }): Promise<SyncResult> {
	const config = loadConfig();
	// A machine whose sessions arrive by git runs its refresh here, so a sync started from
	// the UI sees what the other computer pushed without anyone remembering the script.
	const hook = await runSyncHook(config);
	const { adapters, errors } = await buildSourceAdapters(config);
	// A source that reads local evidence (dedup against this very index)
	// declares a writable `db` field and gets the sync's own handle. The field
	// is optional: sources without it never see the database.
	for (const a of adapters) {
		if ("db" in a) (a as { db: unknown }).db = db;
	}
	const result = await runSync(db, adapters, opts);
	// A source that failed to load is a sync error like any other, but it
	// produces no session rows, so surface it even when every adapter ran.
	result.errors.push(...errors);
	if (hook) {
		result.hook = hook;
		// The sync still reads what is on disk: a hook that failed leaves the archive as it
		// was, and indexing yesterday's sessions beats indexing nothing.
		if (!hook.ok && hook.error) result.errors.push(`sync hook failed: ${hook.error}`);
	}
	return result;
}

/** Files at least this large are logged as they start and finish, so a long or failing run names its file. */
const LOG_FILE_BYTES = 64 * 1024 * 1024;

function fileLogger(verbose: boolean | undefined): (event: FileEvent) => void {
	return (e) => {
		if (!verbose && e.size < LOG_FILE_BYTES) return;
		// The last three path segments name the file without printing the whole local path.
		const name = e.file.split(path.sep).slice(-3).join("/");
		console.error(`  ${e.phase === "start" ? "reading" : "finished"} ${e.source} ${name} (${Math.round(e.size / 1e6)} MB)`);
	};
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
			reread: args.reread,
			onFile: fileLogger(args.verbose),
		});
		const lines = [
			"⛏️ Prospect sync complete",
			`  Sessions processed: ${result.sessionsProcessed}`,
			`  Sessions skipped:   ${result.sessionsSkipped}`,
			`  Messages inserted:  ${result.messagesInserted}`,
			`  Forks resolved:     ${result.forksResolved}`,
			`  Subagent runs:      ${result.subagentRunsProcessed} ingested, ${result.subagentRunsSkipped} unchanged`,
		];
		for (const [source, sum] of Object.entries(result.bySource).sort(([a], [b]) => a.localeCompare(b))) {
			const errors = Object.entries(sum.errors).map(([cls, n]) => `${cls} ${n}`).join(", ");
			lines.push(
				`  ${source}: ${sum.visited} files visited, ${sum.sessionsAdded} sessions added, ${sum.messagesAdded} messages added, ${sum.sessionFieldsChanged} session rows changed, ${sum.extrasAdded} extras and ${sum.eventsAdded} events added, ${sum.rebuiltSkipped} rebuilt files skipped${errors ? `, errors: ${errors}` : ""}`,
			);
		}
		if (result.hook) {
			lines.push(`  Hook: ${result.hook.ok ? "ok" : "failed"} (${result.hook.command})`);
		}
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
	reread?: boolean;
	verbose?: boolean;
}

function parseSyncArgs(raw: string): SyncArgs {
	const result: SyncArgs = {};
	const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--project" && parts[i + 1]) result.project = parts[++i]!;
		else if (p === "--reread") result.reread = true;
		else if (p === "--verbose") result.verbose = true;
		else if (p === "--source" && parts[i + 1]) {
			// Unknown values throw (parseHarnessSource), so a typo fails loudly.
			result.source = parseHarnessSource(parts[++i]!);
		}
	}
	return result;
}

/** The source tags whose adapter constructor takes the directory it reads as its first argument. */
const ROOT_TAKING_SOURCES = new Set(["pi", "claude", "codex"]);

/**
 * One adapter instance per configured root, or the adapters unchanged when the config
 * names no roots. An adapter is rebuilt through its own constructor, so a built-in that
 * resolves its directory lazily keeps doing so; the host is attached to the instance,
 * which is what the sync loop copies onto every session it inserts.
 */
function expandRoots(
	adapters: SessionSourceAdapter[],
	config: ProspectorConfig,
): SessionSourceAdapter[] {
	const roots = config.roots;
	if (!Array.isArray(roots) || roots.length === 0) return adapters;
	let configured: RootConfig[];
	try {
		configured = getRoots(config);
	} catch {
		// A malformed entry is reported by the caller's config checks; reading the defaults
		// here would silently index this machine's sessions under a remote host name.
		return adapters;
	}
	return adapters.flatMap((adapter) => {
		if (!ROOT_TAKING_SOURCES.has(adapter.source)) return [adapter];
		// The configured list replaces the defaults entirely: an adapter it does not name must not
		// read its own default tree, because those sessions would land with no host at all.
		const mine = configured.filter((r) => r.source === adapter.source);
		if (mine.length === 0) return [];
		const Ctor = adapter.constructor as new (dir?: string) => SessionSourceAdapter;
		return mine.map((r) => Object.assign(new Ctor(r.root), { host: r.host }));
	});
}

/**
 * Run the configured pre-sync command, if there is one.
 *
 * The command goes through the shell, so a path with arguments works without quoting rules
 * of its own. A leading `~` is expanded. The timeout keeps a hung git fetch from making the
 * sync look frozen; nothing else here can stop it once it starts.
 */
export async function runSyncHook(
	config: ProspectorConfig,
): Promise<{ command: string; ok: boolean; error?: string } | undefined> {
	const hook = config.syncHook;
	if (!hook || typeof hook.command !== "string" || !hook.command.trim()) return undefined;
	const command = hook.command.replace(/^~/, os.homedir());
	const timeoutMs = typeof hook.timeoutMs === "number" && hook.timeoutMs > 0 ? hook.timeoutMs : 120_000;
	const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
		execFile("/bin/sh", ["-c", command], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, _stdout, stderr) => {
			if (!err) return resolve({ ok: true });
			const detail = (stderr || err.message).trim().split("\n").slice(-3).join(" | ");
			resolve({ ok: false, error: detail.slice(0, 400) });
		});
	});
	return { command, ...result };
}
