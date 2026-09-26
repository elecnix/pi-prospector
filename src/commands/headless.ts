import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { COMMANDS, type ProspectHandler } from "./registry.js";

/** A command runnable both as a slash command and via the `--prospect` flag. */
export type ProspectAction = ProspectHandler;

/**
 * Maps a `--prospect` sub-command name to its handler.
 *
 * Derived from the command table (#292) so the flag cannot drift from the slash
 * commands it names — and so a `--prospect` run loads the one module it needs
 * instead of the whole extension.
 */
const flagged = COMMANDS.flatMap((command) => (command.flag === undefined ? [] : [[command.flag, command.run] as const]));
export const PROSPECT_ACTIONS: Record<string, ProspectAction> = Object.fromEntries(flagged);

const USAGE =
	'Usage: pi -e <prospector>/src/index.ts --prospect "<command> [args]"\n' +
	"  commands: sync | analyze [flags] | analyzers [list|list --schema <id>|validate <path>] | output [list|<analyzer>:<output> [--out DIR] [--key value]] | stats [--as-of <ts>] | proposals [status] [--full] [--as-of <ts>] | show <id> | node <output-key> | nodes (--analyzer <id> | --all) [--node-kind <kind>] [--filter k=v]... [--counts <prop>] [--latest-per-key <prop>] [--limit n] [--offset n] | verify | validate [flags] | runs | diff --unit <a> <sset> | diff --runs <A> <B> | diff --as-of <T1> <T2> | gc --run <id> | gc --analyzer <id> | gc --since <ts> [--apply] | retract --list | retract --undo <id> | retract --purge --retracted-before <ts> | accept <id> [--planned|--done|--done-differently] [rationale] | reject <id> [rationale] | remediate <id> <id>... [--planned|--done|--done-differently] <description> | mute <term> [--reason \"why\"] | unmute <term> | mutes";

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
			'Run a prospector command non-interactively and exit, e.g. --prospect "analyze --limit 3" or --prospect "proposals --full". Commands: sync | analyze | stats | proposals | show <id> | node <output-key> | nodes --analyzer <id> | verify | validate | runs | diff | gc | retract | accept <id> [rationale] | reject <id> [rationale] | remediate <id> <id>... <description> | mute <term> [--reason "why"] | unmute <term> | mutes',
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
