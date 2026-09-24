/**
 * task-tool-mismatch — deterministic, session-level analyzer for the
 * task-instruction-vs-tool-selection mismatch (#158): the agent avoided a tool
 * it was explicitly told to use.
 *
 * All four conditions must hold:
 *
 *   1. the session's first user/task message instructs use of a specific tool
 *      or command ("run `git diff`", "run `make test`", "use `rg`") — extracted
 *      deterministically from imperative sentences only (see `detect.ts`);
 *   2. that instruction resolves to a tool in the session's recorded **tool
 *      inventory** — directly (`use \`rg\`` → rg) or via the session's shell
 *      tool for a command word (`run \`git diff\`` → bash). An inventory that
 *      was never captured is UNKNOWN and skipped honestly, never read as empty;
 *   3. the agent made 0 calls of that tool;
 *   4. the agent made many calls of substitute tools to reconstruct the result
 *      by hand (`minSubstituteCalls`, summed over `substituteTools`).
 *
 * The emitted proposal points at the **mismatch** — the instructed-but-avoided
 * tool — with the recommendation "run the command you were told to run". It
 * deliberately does NOT point at the substitute symptoms: redundant reads and
 * greps are the shadow of the avoidance (context-economy already prices those),
 * and treating them as the disease produced exactly the wrong advice on #1407.
 *
 * One node per session (metric when nothing fires, proposal when a mismatch
 * fires), anchored to the session with an extra anchors edge onto the
 * instructing user message, so the finding walks back to the exact words.
 * Nested subagent sessions need no special handling: sync discovers them and
 * their task prompt simply is the first user message. No LLM.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";
import {
	DEFAULT_TASK_TOOL_MISMATCH_CONFIG,
	TaskToolMismatchConfig,
	type TaskToolMismatchConfig as ResolvedConfig,
} from "./config.js";
import { buildToolStream } from "../../tool-stream.js";
import { detectTaskToolMismatch, MentionVerdictSchema, type DetectionResult } from "./detect.js";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const TaskToolMismatchRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type TaskToolMismatchRawProposal = Static<typeof TaskToolMismatchRawProposal>;

/** The properties a task-tool-mismatch node carries in its `contentJson`. */
export const TASK_TOOL_MISMATCH_PROPERTIES = Type.Object({
	session_id: Type.String(),
	instruction_message_id: Type.Union([Type.String(), Type.Null()]),
	verdicts: Type.Array(MentionVerdictSchema),
	substitute_calls: Type.Number(),
	substitute_tool_names: Type.Array(Type.String()),
	available_tools: Type.Number(),
	mismatch_found: Type.Boolean(),
	improvement_proposals: Type.Array(TaskToolMismatchRawProposal),
});
export type TaskToolMismatchProperties = Static<typeof TASK_TOOL_MISMATCH_PROPERTIES>;

export const TASK_TOOL_MISMATCH_DEF: AnalyzerDef = {
	id: "task-tool-mismatch",
	label: "Task-Tool Mismatch (deterministic)",
	description:
		"Detects when a session's first user/task message instructs use of a specific tool or command, that tool was in the session's recorded inventory, the agent made zero calls of it, and instead reconstructed the result by hand with many substitute-tool calls (#158). The finding targets the instructed-but-avoided tool — run the command you were told to run — never the substitute symptom. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: TASK_TOOL_MISMATCH_PROPERTIES,
};

export const TASK_TOOL_MISMATCH_VERSION: AnalyzerVersion = {
	analyzerId: TASK_TOOL_MISMATCH_DEF.id,
	// 1.0 (issue #158): imperative instruction extraction from the first user
	// message, inventory resolution, zero-call test, substitute-volume gate.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/task-tool-mismatch/index.ts",
};

function resolveConfig(raw: unknown): ResolvedConfig {
	return (raw as ResolvedConfig) ?? DEFAULT_TASK_TOOL_MISMATCH_CONFIG;
}

/** Fingerprint of everything the detection reads: instruction text, inventory names, and every call name + command argument. */
function detectionFingerprint(
	firstUserText: string,
	availableToolNames: ReadonlySet<string>,
	invocations: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
): string {
	const lines = [
		shortHash(firstUserText),
		`tools:${[...availableToolNames].sort().join("|")}`,
		...invocations.map((i) => `${i.name}:${shortHash(JSON.stringify(i.args))}`),
	];
	return shortHash(lines.join("\n"));
}

// ── proposal ──

function buildProposals(props: Omit<TaskToolMismatchProperties, "improvement_proposals">): TaskToolMismatchRawProposal[] {
	return props.verdicts
		.filter((v) => v.mismatched)
		.map((v) => {
			const command = v.resolution === "shell-command" ? `\`${v.mention}\` via ${v.target_tool}` : `${v.target_tool}`;
			return {
				target_type: "agents_md",
				title: `Agent avoided the instructed tool (${v.mention}) — ${props.substitute_calls} substitute call${props.substitute_calls === 1 ? "" : "s"} reconstructed the result by hand`,
				summary:
					`The task's first message said to use ${command}, it was in the agent's available tools, yet the agent made 0 calls of it and instead rebuilt the result by hand with ${props.substitute_calls} substitute calls (${props.substitute_tool_names.join(", ")}). Run the command you were told to run.`,
				detail:
					"When a task explicitly instructs a specific command, running it once is cheaper and more faithful than re-deriving its output through many reads and greps. A standing instruction to honour named commands — and to treat 'do not use shell commands' style rules narrowly — prevents this avoidance pattern.",
				evidence: `instructed: ${v.mention} (${v.source}, resolved ${v.resolution}${v.target_tool ? ` → ${v.target_tool}` : ""}); target calls: 0; substitutes: ${props.substitute_calls} (${props.substitute_tool_names.join(", ")})`,
				confidence: 0.85,
				severity: "waste",
			};
		});
}

// ── analyzer ──

export const taskToolMismatchAnalyzer: Analyzer = {
	def: TASK_TOOL_MISMATCH_DEF,
	version: TASK_TOOL_MISMATCH_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: TASK_TOOL_MISMATCH_DEF.id,
		configHash: computeConfigHash(DEFAULT_TASK_TOOL_MISMATCH_CONFIG),
		configJson: DEFAULT_TASK_TOOL_MISMATCH_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];

		// UNKNOWN inventory (NULL) → skip honestly; condition 2 can only be
		// verified against what the host actually recorded. It must never be read
		// as "no tools available" (DESIGN.md, Tool Inventory).
		const sessRow = (await ctx.db.prepare("SELECT tool_inventory FROM sessions WHERE id = ?").get(ctx.sessionId)) as
			| { tool_inventory: string | null }
			| undefined;
		if (!sessRow || sessRow.tool_inventory === null) return [];
		let inventoryNames: string[];
		try {
			const parsed = JSON.parse(sessRow.tool_inventory) as { tools?: Array<{ name?: unknown }> };
			inventoryNames = (parsed.tools ?? [])
				.filter((t): t is { name: string } => typeof t["name"] === "string")
				.map((t) => t.name);
		} catch (e) {
			throw new Error(`task-tool-mismatch: malformed tool_inventory for session ${ctx.sessionId}`, { cause: e });
		}
		if (inventoryNames.length === 0) return [];

		const cfg = resolveConfig(ctx.config);
		const stream = buildToolStream(ctx.messages);

		const firstUser = ctx.messages.find((m) => m.role === "user");
		const result = detectTaskToolMismatch({
			firstUserMessageId: firstUser?.id ?? null,
			firstUserText: firstUser?.content_text ?? "",
			availableToolNames: new Set(inventoryNames),
			invocations: stream.invocations,
			cfg,
		});

		const fingerprint = detectionFingerprint(firstUser?.content_text ?? "", new Set(inventoryNames), stream.invocations);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#ttm=${fingerprint}` }];

		return [
			{
				sources,
				sourceSetHash: shortHash(`task-tool-mismatch(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { result },
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		// Detection ran in plan(); the node records its result. Thresholds were
		// applied there under this run's resolved config, which is part of the
		// recipe — a config change re-plans and recomputes via the stale/config path.
		const result = (_unit.meta?.["result"] ?? {}) as DetectionResult;
		const proposals = buildProposals({ ...result, session_id: ctx.sessionId });

		const contentJson: TaskToolMismatchProperties = { ...result, session_id: ctx.sessionId, improvement_proposals: proposals };

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		if (contentJson.instruction_message_id) {
			edges.push({
				toRefKind: REF_KINDS.MESSAGE,
				toRefId: contentJson.instruction_message_id,
				edgeKind: EDGE_KINDS.ANCHORS,
				ordinal: 1,
			});
		}

		return {
			nodeKind: proposals.length > 0 ? "proposal" : "metric",
			contentJson: contentJson as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
