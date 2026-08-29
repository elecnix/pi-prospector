import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { runSync } from "../sync/index.js";
import type { SessionSourceAdapter } from "../sync/adapter.js";
import { PiFileSource } from "../sync/sources/pi-file.js";
import { ClaudeFileSource } from "../sync/sources/claude-file.js";
import { PiSubagentSource } from "../sync/sources/pi-subagent.js";
import { PiRpcSource } from "../sync/sources/pi-rpc.js";
import { parseHarnessSource } from "../harness.js";
import { loadConfig, getDbPath, getSessionsDir, getClaudeSessionsDir } from "../config.js";

/**
 * Composition root for session sources: the two built-in file sources, plus
 * any extra source named in config `sources` (e.g. "pi-subagent", "pi-rpc").
 */
export function buildAdapters(): SessionSourceAdapter[] {
	const adapters: SessionSourceAdapter[] = [
		new PiFileSource(getSessionsDir()),
		new ClaudeFileSource(getClaudeSessionsDir()),
	];

	const sources = loadConfig().sources ?? [];

	if (sources.includes("pi-subagent")) {
		adapters.push(new PiSubagentSource(getSessionsDir()));
	}

	if (sources.includes("pi-rpc")) {
		adapters.push(new PiRpcSource(getSessionsDir()));
	}

	return adapters;
}

export async function prospectSync(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const dbPath = getDbPath();
	const db = openAsyncDatabase(dbPath);
	await migrate(db);

	const args = parseSyncArgs(rawArgs ?? "");

	try {
		const result = await runSync(db, buildAdapters(), {
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
	source?: "pi" | "claude" | "pi-rpc";
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

export function registerSyncCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-sync", {
		description:
			"Index session files into the prospector database (no LLM). Flags: --project NAME (scope to one project, skipping every other project on disk — the fresh-install escape hatch), --source pi|claude|pi-rpc (restrict to one coding harness)",
		handler: prospectSync,
	});
}
