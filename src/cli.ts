import { COMMANDS, type ProspectCommand } from "./commands/registry.js";
import { loadOnce } from "./lazy.js";
import { importPiPackage } from "./pi-host.js";
import type { ExtensionCommandContext, ModelRegistry, PiModel, ResolvedRequestAuth } from "./pi-stubs.js";

/**
 * The standalone `prospect` command: runs one slash command under plain Node,
 * without starting pi. `prospect analyze --limit 3` does what
 * `/prospect-analyze --limit 3` does inside pi.
 *
 * Commands print their own output, so the context's `notify` only records
 * whether one reported an error, which sets the exit code.
 */

const PREFIX = "prospect-";

/** Each command under its CLI name: the slash command without the `prospect-` prefix. */
const BY_NAME = new Map<string, ProspectCommand>(COMMANDS.map((command) => [command.name.slice(PREFIX.length), command]));

export interface CliOptions {
	/** The model registry LLM analyzers resolve models through. Defaults to pi's, loaded on first lookup. */
	modelRegistry?: ModelRegistry;
}

/** Run `prospect <command> [args]` and return the process exit code. */
export async function main(argv: string[], options: CliOptions = {}): Promise<number> {
	const [first, ...rest] = argv;
	if (first === undefined || first === "help" || first === "--help" || first === "-h") {
		if (first === "help" && rest[0] !== undefined) return printCommandHelp(rest[0]);
		console.log(usage());
		return 0;
	}
	const command = BY_NAME.get(first.toLowerCase());
	if (!command) {
		console.error(`Unknown command: ${first}\n\n${usage()}`);
		return 2;
	}
	if (rest.includes("--help") || rest.includes("-h")) return printCommandHelp(first);

	let failed = false;
	const ctx: ExtensionCommandContext = {
		modelRegistry: options.modelRegistry ?? piModelRegistry(),
		cwd: process.cwd(),
		hasUI: false,
		ui: {
			notify: (_message, level) => {
				if (level === "error") failed = true;
			},
		},
	};
	try {
		await command.run(rest.join(" "), ctx);
	} catch (err) {
		console.error(`prospect ${first}: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	return failed ? 1 : 0;
}

function printCommandHelp(name: string): number {
	const command = BY_NAME.get(name.toLowerCase());
	if (!command) {
		console.error(`Unknown command: ${name}\n\n${usage()}`);
		return 2;
	}
	console.log(`Usage: prospect ${name.toLowerCase()} [args]\n\n${command.description}`);
	return 0;
}

function usage(): string {
	const names = [...BY_NAME.keys()];
	const width = Math.max(...names.map((name) => name.length));
	const lines = [...BY_NAME].map(([name, command]) => `  ${name.padEnd(width)}  ${firstSentence(command.description)}`);
	return [
		"Usage: prospect <command> [args]",
		"",
		"Runs a pi-prospector command without starting pi. LLM analyzers use the models and credentials of the pi on PATH.",
		"",
		"Commands:",
		...lines,
		"",
		"Run `prospect help <command>` for a command's flags.",
	].join("\n");
}

function firstSentence(text: string): string {
	const end = text.search(/\.(\s|$)/);
	return end === -1 ? text : text.slice(0, end + 1);
}

/**
 * pi's model registry, from the pi on PATH. Importing pi takes about a second,
 * so it happens on the first lookup: commands that never call a model never
 * pay for it.
 */
function piModelRegistry(): ModelRegistry {
	interface PiCodingAgent {
		ModelRuntime: { create(options: { allowModelNetwork: boolean }): Promise<unknown> };
		ModelRegistry: new (runtime: unknown) => ModelRegistry & {
			find(provider: string, modelId: string): PiModel | undefined;
			getAll(): PiModel[];
			getAvailable(): PiModel[];
		};
	}
	const load = loadOnce(async () => {
		const pi = await importPiPackage<PiCodingAgent>("@earendil-works/pi-coding-agent");
		return new pi.ModelRegistry(await pi.ModelRuntime.create({ allowModelNetwork: false }));
	});
	return {
		find: async (provider, modelId) => (await load()).find(provider, modelId),
		getAll: async () => (await load()).getAll(),
		getAvailable: async () => (await load()).getAvailable(),
		getApiKeyAndHeaders: async (model): Promise<ResolvedRequestAuth> => (await load()).getApiKeyAndHeaders(model),
	};
}
