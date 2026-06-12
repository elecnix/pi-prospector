import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { prospectSync } from "./sync.js";
import { prospectStats } from "./stats.js";
import { prospectProposals, prospectAccept, prospectReject } from "./proposals.js";
import { prospectAnalyze } from "./analyze.js";
import { prospectVerify } from "./verify.js";
import { prospectValidate } from "./validate.js";
import { prospectShow } from "./show.js";

/** A command runnable both as a slash command and via the `--prospect` flag. */
export type ProspectAction = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

/** Maps a `--prospect` sub-command name to its handler. */
export const PROSPECT_ACTIONS: Record<string, ProspectAction> = {
	sync: prospectSync,
	analyze: prospectAnalyze,
	stats: prospectStats,
	proposals: prospectProposals,
	show: prospectShow,
	verify: prospectVerify,
	validate: prospectValidate,
	accept: prospectAccept,
	reject: prospectReject,
};

const USAGE =
	'Usage: pi -e <prospector>/src/index.ts --prospect "<command> [args]"\n' +
	"  commands: sync | analyze [flags] | stats | proposals [status] [--full] | show <id> | verify | validate [flags] | accept <id> | reject <id>";

/** Split a `--prospect` flag value into a command name and the remaining args. */
export function splitProspectSpec(spec: string): { command: string; args: string } {
	const trimmed = spec.trim();
	const ws = trimmed.search(/\s/);
	if (ws === -1) return { command: trimmed.toLowerCase(), args: "" };
	return { command: trimmed.slice(0, ws).toLowerCase(), args: trimmed.slice(ws + 1).trim() };
}

/**
 * Run the action named by a `--prospect` flag value. Returns true if an action
 * ran (or threw), false for an empty/unknown command (usage printed to stderr).
 */
export async function runProspectSpec(
	spec: string,
	ctx: ExtensionCommandContext,
	actions: Record<string, ProspectAction> = PROSPECT_ACTIONS,
): Promise<boolean> {
	if (!spec || spec.trim() === "") {
		console.error(USAGE);
		return false;
	}
	const { command, args } = splitProspectSpec(spec);
	const action = actions[command];
	if (!action) {
		console.error(`Unknown --prospect command: "${command}".\n${USAGE}`);
		return false;
	}
	await action(args, ctx);
	return true;
}

/**
 * Register the `--prospect` CLI flag. When present, the named command runs once
 * at session start and pi shuts down — so a bare
 * `pi -e .../src/index.ts --prospect stats` is non-interactive by default, with
 * no need for `-p`. When the flag is absent, the extension stays interactive.
 */
export function registerHeadlessFlag(pi: ExtensionAPI): void {
	pi.registerFlag("prospect", {
		description:
			'Run a prospector command non-interactively and exit, e.g. --prospect "analyze --limit 3" or --prospect "proposals --full". Commands: sync | analyze | stats | proposals | show <id> | verify | validate | accept <id> | reject <id>',
		type: "string",
	});

	let dispatched = false;
	pi.on("session_start", async (_event, ctx) => {
		const spec = pi.getFlag("prospect");
		if (typeof spec !== "string" || spec.trim() === "") return;
		// session_start can fire again (reload/resume); only run the one-shot once.
		if (dispatched) return;
		dispatched = true;
		try {
			await runProspectSpec(spec, ctx);
		} catch (err) {
			console.error(`prospect: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			await ctx.shutdown?.();
		}
	});
}
