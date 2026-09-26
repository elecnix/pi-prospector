import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { loadOnce } from "../lazy.js";
import { PROSPECT_TOOL } from "./tool-schema.js";

/**
 * The slash-command table (#292).
 *
 * pi loads every extension through jiti, which resolves and transpiles each file
 * at runtime, so whatever `src/index.ts` imports statically is paid on *every*
 * startup. This module is therefore the whole of that surface: it holds only the
 * metadata pi needs while loading — name, description, and the `--prospect`
 * alias — and defers each command's implementation to a dynamic import in
 * `load`, which runs when the command is first invoked.
 *
 * A file that has to be added here is a file that will be transpiled on every
 * start; prefer adding a `load` instead. `tests/unit/eager-graph.test.ts` holds
 * the line.
 */

/** A slash-command handler, and the `--prospect` action of the command it belongs to. */
export type ProspectHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;

/** One slash command: the metadata pi registers, plus how to load its implementation. */
export interface ProspectCommand {
	name: string;
	description: string;
	/** The `--prospect <flag>` alias, for the commands reachable from the CLI flag. */
	flag?: string;
	/** Run the command, loading its module on first use. */
	run: ProspectHandler;
}

/**
 * Build a row: metadata plus a lazily-imported implementation. The handler is
 * typed against the module it loads, so renaming an export cannot leave a
 * command silently pointing at nothing.
 */
function spec<M>(definition: {
	name: string;
	description: string;
	flag?: string;
	load: () => Promise<M>;
	handler: (module: M) => ProspectHandler;
}): ProspectCommand {
	const load = loadOnce(definition.load);
	return {
		name: definition.name,
		description: definition.description,
		flag: definition.flag,
		run: async (args, ctx) => {
			const handler = definition.handler(await load());
			await handler(args, ctx);
		},
	};
}

/** Every slash command, in the order pi lists them. */
export const COMMANDS: ProspectCommand[] = [
	spec({
		name: "prospect-sync",
		flag: "sync",
		description:
			"Index session files into the prospector database (no LLM). Flags: --project NAME (scope to one project, skipping every other project on disk — the fresh-install escape hatch), --source pi|claude (restrict to one coding harness)",
		load: () => import("./sync.js"),
		handler: (module) => module.prospectSync,
	}),
	spec({
		name: "prospect-stats",
		flag: "stats",
		description: "Show prospector database statistics with token and tool-call breakdowns, plus the analyzer-coverage summary (which registered analyzers have run against which sessions — #195). Flags: --as-of <ts|7d|24h> / --as-of-run <id> to view stats as of a past point (labelled as a view, not current state).",
		load: () => import("./stats.js"),
		handler: (module) => module.prospectStats,
	}),
	spec({
		name: "prospect-proposals",
		flag: "proposals",
		description:
			"List proposals, ranked by trust tier (replay-validated) then billed cost, then confidence. Optional status filter (open|applied|rejected|duplicate), --severity <friction|correction|waste|suggestion|reinforcement>, --source <pi|claude>, --session <id> (only that session's proposals), and --full for evidence/source.",
		load: () => import("./proposals.js"),
		handler: (module) => module.prospectProposals,
	}),
	spec({
		name: "prospect-accept",
		flag: "accept",
		description: "Accept (apply) a proposal by ID",
		load: () => import("./proposals.js"),
		handler: (module) => module.prospectAccept,
	}),
	spec({
		name: "prospect-reject",
		flag: "reject",
		description: "Reject a proposal by ID",
		load: () => import("./proposals.js"),
		handler: (module) => module.prospectReject,
	}),
	spec({
		name: "prospect-remediate",
		flag: "remediate",
		description: "Accept many proposals at once under ONE shared remediation action: <id> <id>... [--planned|--done|--done-differently] <description>",
		load: () => import("./proposals.js"),
		handler: (module) => module.prospectRemediate,
	}),
	spec({
		name: "prospect-analyze",
		flag: "analyze",
		description:
			"Run analyzer framework over sessions (incremental). Flags: --revise major|minor|config|all (recompute stale nodes: major/minor analyzer bumps, config = your setup changed; default fills only missing work), --all (plain-fill every session, not just unanalysed ones — use after the frustration lexicon learns new words), --backfill-missing (run only the analyzers each analysed session is missing — closes coverage gaps after a new or previously-unselected analyzer ships, without re-running everything), --limit N, --recent N (most-recent N sessions, for pilots), --session ID, --source pi|claude (restrict to sessions from one coding harness), --analyzer ID, --model provider/model (pin every tier to one model for this run; the model is part of node identity), --analyzer-path FILE|DIR (load a locally-authored custom analyzer; repeatable — the Pi agent dir ~/.pi/agent/prospector/analyzers and ./.prospector/analyzers are always scanned), --llm-concurrency N (max concurrent LLM calls, and the per-analyzer unit fan-out; default 10), --analyzer-concurrency N (session fan-out for deterministic-only runs, default 20)",
		load: () => import("./analyze.js"),
		handler: (module) => module.prospectAnalyze,
	}),
	spec({
		name: "prospect-analyzers",
		flag: "analyzers",
		description:
			"Inspect locally-authored custom analyzers. Subcommands: list (built-ins + discovered custom analyzers, each with its declared output properties, and any load errors), list --schema <analyzer-id> (print that analyzer's declared node-content schema as JSON), validate <file|dir> (check one analyzer file/dir, including its outputSchema declaration). Custom analyzers are loaded from ~/.pi/agent/prospector/analyzers, ./.prospector/analyzers, and config analyzerPaths.",
		load: () => import("./analyzers.js"),
		handler: (module) => module.prospectAnalyzers,
	}),
	spec({
		name: "prospect-output",
		flag: "output",
		description:
			"Render an analyzer's outputs to files. `output list` shows what is available; `output <analyzer>:<output> [--out DIR] [--as-of TS] [--key value]` renders it. Unknown --key value pairs are passed to the output (e.g. --day 2026-08-14, --previews false). Reads the graph only — it never writes nodes and never runs analysis.",
		load: () => import("./output.js"),
		handler: (module) => module.prospectOutput,
	}),
	spec({
		name: "prospect-verify",
		flag: "verify",
		description:
			"Verify analysis-graph integrity: recompute each node's output_key AND validate every edge's referential integrity (evidence trails resolve to real targets).",
		load: () => import("./verify.js"),
		handler: (module) => module.prospectVerify,
	}),
	spec({
		name: "prospect-validate",
		flag: "validate",
		description:
			"Replay-validate open proposals: re-classify each proposal's originating turns with and without the candidate rule (distinct model) and write a grounded validated_score. Flags: --revise major|minor|config|all, --limit N, --session ID, --model provider/model.",
		load: () => import("./validate.js"),
		handler: (module) => module.prospectValidate,
	}),
	spec({
		name: "prospect-show",
		flag: "show",
		description:
			"Show a proposal with the verbatim anchored turns (user/assistant text + tool calls) it was synthesised from, " +
			"or --session <id> for the session-level summary with its evidence (consumed turns, produced proposals, contrast siblings).",
		load: () => import("./show.js"),
		handler: (module) => module.prospectShow,
	}),
	spec({
		name: "prospect-nodes",
		flag: "nodes",
		description:
			"Read analyzer output nodes from the surface. Flags: --analyzer <id> (or --all), --node-kind <metric|classification|summary|validation|error>, --filter key=value (repeatable, typed against the analyzer's declared outputSchema), --counts <property>, --latest-per-key <property> (e.g. newest verdict per term), --limit/--offset, --session <id>, --as-of <ts|7d>, --as-of-run <id>.",
		load: () => import("./nodes.js"),
		handler: (module) => module.prospectNodes,
	}),
	spec({
		name: "prospect-node",
		flag: "node",
		description:
			"Show one analysis node by output-key (prefix ok) with its content and resolved outgoing edges — what it consumed, what messages anchor it, what it produced.",
		load: () => import("./nodes.js"),
		handler: (module) => module.prospectNode,
	}),
	spec({
		name: "prospect-leaks",
		description:
			"Report which sessions contain detected secrets: every finding from the credential-detector analyzers " +
			"(secret-leak, gitleaks, nosey-parker, detect-secrets, trufflehog, secret-scanner) with its severity, rule, " +
			"redacted preview, fingerprint, and the message it appeared in. Flags: --severity <critical|high|medium> (floor), --limit <n>, --source <pi|claude>.",
		load: () => import("./leaks.js"),
		handler: (module) => module.prospectLeaks,
	}),
	spec({
		name: "prospect-search",
		description:
			"Content and pattern search over proposals and the session corpus (SQLite FTS5). " +
			"Every hit names its record kind, id, session, and a highlighted snippet, ranked by bm25, " +
			"with links into prospect show / prospect node. " +
			"Syntax: plain terms (implicit AND), \"quoted phrases\", prefix terms (lexicon*), OR / NOT / AND, " +
			"NEAR(a b, n), column:term (messages: content_text, content_thinking; proposals: title, summary, detail, evidence). " +
			"Flags: --kind <all|messages|proposals>, --limit <n>, --source <pi|claude>.",
		load: () => import("./search.js"),
		handler: (module) => module.prospectSearch,
	}),
	spec({
		name: "prospect-diff",
		flag: "diff",
		description:
			"Compare analysis nodes across versions, runs, and points in time. Modes: --unit <analyzer> <source_set_hash> (the revises chain), --runs <A> <B> (two runs' node sets), --as-of <T1> <T2> (graph at two times). Default shows per-analyzer added/removed/changed counts; add --full for structural per-node detail.",
		load: () => import("./diff.js"),
		handler: (module) => module.prospectDiff,
	}),
	spec({
		name: "prospect-runs",
		flag: "runs",
		description: "List recent analysis runs (ids, mode, status, node counts, timestamps) so their ids are discoverable for diff --runs and --as-of-run.",
		load: () => import("./runs.js"),
		handler: (module) => module.prospectRuns,
	}),
	spec({
		name: "prospect-gc",
		flag: "gc",
		description:
			"Remove one run's or one analyzer's output (or everything after a timestamp), in one transaction: the nodes, the edges from them, the edges pointing at them, and the proposals materialised from them — never human decisions/remediations. Dry run by default; pass --apply to perform.",
		load: () => import("./gc.js"),
		handler: (module) => module.prospectGc,
	}),
	spec({
		name: "prospect-retract",
		flag: "retract",
		description:
			"Make retraction (from /prospect-gc) legible and reversible, and provide the space escape hatch. --list shows retracted nodes + provenance; --undo <gcRunId> reverses a retraction; --purge --retracted-before <ts> physically deletes retracted nodes from before ts. Never touches decisions/remediations.",
		load: () => import("./retract.js"),
		handler: (module) => module.prospectRetract,
	}),
	spec({
		name: "prospect-viz",
		description:
			"Render one session as a self-contained interactive HTML page: transcript rail, analysis graph with typed edges, proposal click-through to anchored messages, remediations, revises lineage, filters and depth-collapse. `viz` lists sessions; `viz <session-id> [--out DIR]` renders. Reads only — never writes to the graph.",
		load: () => import("./viz.js"),
		handler: (module) => module.prospectViz,
	}),
	spec({
		name: "prospect-mute",
		flag: "mute",
		description: "Mute a lexicon term: it stops matching new turns (its prior hit nodes stay as stale/config lineage). Usage: /prospect-mute <term> [--reason \"why\"] [--by operator|agent]",
		load: () => import("./mutes.js"),
		handler: (module) => module.prospectMute,
	}),
	spec({
		name: "prospect-unmute",
		flag: "unmute",
		description: "Unmute a lexicon term (append-only via superseded_at). Usage: /prospect-unmute <term>",
		load: () => import("./mutes.js"),
		handler: (module) => module.prospectUnmute,
	}),
	spec({
		name: "prospect-mutes",
		flag: "mutes",
		description: "List term assertions — what is muted, by whom, when, and why. The mute corpus is the training input for improving the classifier prompt.",
		load: () => import("./mutes.js"),
		handler: (module) => module.prospectMutes,
	}),
	spec({
		name: "prospect-models",
		description: "Show the per-model quality/cost efficiency frontier over the analyzed routing corpus",
		load: () => import("./models.js"),
		handler: (module) => module.prospectModels,
	}),
];

/**
 * Register the slash commands and the `prospect` tool.
 *
 * Registration itself is eager — pi needs the command names and descriptions for
 * its command list, and the tool's parameter schema before a model can call it —
 * but no implementation module is imported here.
 */
export function registerProspector(pi: ExtensionAPI): void {
	for (const command of COMMANDS) {
		pi.registerCommand(command.name, { description: command.description, handler: command.run });
	}

	const loadTool = loadOnce(() => import("./tool.js"));
	pi.registerTool({
		...PROSPECT_TOOL,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const implementation = await loadTool();
			return implementation.executeProspectTool(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}
