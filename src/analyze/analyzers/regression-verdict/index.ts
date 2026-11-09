// regression-verdict: what an LLM can see that the transcript never states.
//
// The deterministic analyzers read what a session says. This one reads what it
// shows. An agent routinely repairs a defect without ever learning which earlier
// change caused it: the failing command names the broken behaviour, the commit
// shows the repair, and the reasoning names the mechanism — but no pull request is
// ever blamed. For a retrospective, that is the majority of the signal, and only a
// model can classify it.
//
// The unit is one session, gated first by a deterministic packet builder so the
// model is never paid to read an additive session. The packet is the entire state,
// so the same session always asks the same question and a better prompt re-judges
// the same evidence.
//
// The verdict classifies the KIND of mistake, never a person. `cause_class` and
// `prevention_class` are closed sets, because the retrospective needs counts and a
// free-text cause cannot be counted.
//
// Cost control: the gate is free, and the run only pays for sessions it admits. See
// `gated` in the node so an audit can see the actual sampled fraction.

import { DEFAULT_GATE_CONFIG, gateSession, type GateConfig, type EvidencePacket } from "./gate.js";
import { VERDICT_SYSTEM, VERDICT_TOOL, buildVerdictPrompt, parseVerdict, type Verdict } from "./questions.js";
import type { MessageRow } from "../regression-signal/detect.js";
import { shortHash } from "../../input-hash.js";
import type { Analyzer, AnalysisUnit, AnalyzerPlanContext, AnalyzerRunContext } from "../../types.js";
import { DEFAULT_REGRESSION_VERDICT_CONFIG, type RegressionVerdictConfig } from "./config.js";

export const ANALYZER_ID = "regression-verdict";

export * from "./config.js";
export * from "./gate.js";
export * from "./questions.js";

/**
 * The flat config the framework stores, folded into the packet limits the gate reads.
 * The gate's caps live beside the gate, so a config change is one edit in one place.
 */
const DEFAULT_REGRESSION_VERDICT_CONFIG_FLAT = DEFAULT_REGRESSION_VERDICT_CONFIG as unknown as Record<string, unknown>;

function resolveConfig(raw: unknown): RegressionVerdictConfig & { gate: GateConfig } {
	const r = (raw as Partial<RegressionVerdictConfig> | null | undefined) ?? {};
	return {
		...DEFAULT_REGRESSION_VERDICT_CONFIG,
		...r,
		gate: {
			maxFailures: r.maxFailures ?? DEFAULT_GATE_CONFIG.maxFailures,
			maxCommits: r.maxCommits ?? DEFAULT_GATE_CONFIG.maxCommits,
			maxStatements: r.maxStatements ?? DEFAULT_GATE_CONFIG.maxStatements,
			maxFiles: r.maxFiles ?? DEFAULT_GATE_CONFIG.maxFiles,
			statementChars: DEFAULT_GATE_CONFIG.statementChars,
		},
	};
}

/** A stable fingerprint of the packet, so a re-sync that changes evidence recomputes. */
function packetHash(packet: EvidencePacket): string {
	let h = 2166136261;
	const push = (s: string) => {
		for (let i = 0; i < s.length; i++) {
			h ^= s.charCodeAt(i);
			h = Math.imul(h, 16777619);
		}
	};
	push(packet.session_id);
	// Length-prefixed and separated, so a boundary cannot shift between two items and
	// two different packets cannot produce one hash.
	for (const group of [packet.failures, packet.commits, packet.defect_statements, packet.files_touched]) {
		push(`#${group.length}`);
		for (const item of group) push(`${item.length}:${item}`);
	}
	push(String(packet.reverts));
	push(String(packet.ran_checks));
	return (h >>> 0).toString(16).padStart(8, "0");
}





export const regressionVerdictAnalyzer: Analyzer = {
	def: {
		id: ANALYZER_ID,
		label: "Regression Verdict (LLM)",
		description:
			"Judges whether a coding session repaired a regression, what kind of mistake let it in, and what would " +
			"have prevented it — including when the session never identified the cause. A deterministic gate first " +
			"builds a bounded evidence packet and skips additive sessions, so the model is never paid to read a " +
			"feature. The verdict classifies the KIND of mistake in closed sets, never a person, and reports " +
			"`unstated` rather than inventing a cause. Proposes nothing.",
		anchorSpan: "full_session" as const,
		dependencies: [] as string[],
		outputSchema: {
			type: "object",
			properties: {
				session_id: { type: "string" },
				fixes_defect: { type: "boolean" },
				is_regression: { type: "boolean" },
				cause_class: { type: "string" },
				prevention_class: { type: "string" },
			},
		},
	},
	version: {
		analyzerId: ANALYZER_ID,
		major: 1,
		// 1.1: the cause taxonomy splits `assumption_about_input` into incomplete_match,
		// wrong_operator and scope_too_wide. The first full-corpus run put 267 of 839
		// regressions in that one bucket, and sampling showed three unrelated mechanisms
		// in it, so a class that cannot argue for one change was three classes wearing
		// one name.
		minor: 1,
		implementationKind: "in_process_llm" as const,
		codeRef: "src/analyze/analyzers/regression-verdict/index.ts",
	},
	prompts: {
		// The hash covers the whole question — system, user template and tool schema — so
		// editing either half re-identifies the node and the corpus re-judges the evidence.
		verdict: {
			content: VERDICT_SYSTEM,
			hash: shortHash(`prompt(verdict:${VERDICT_SYSTEM}${JSON.stringify(VERDICT_TOOL)})`),
		},
	},
	defaultConfig: {
		id: "",
		analyzerId: ANALYZER_ID,
		configHash: "",
		configJson: DEFAULT_REGRESSION_VERDICT_CONFIG_FLAT,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		if (ctx.messages.length === 0) return [];
		const config = resolveConfig(ctx.config);
		if (config.maxMessages > 0 && ctx.messages.length > config.maxMessages) return [];

		const gate = gateSession(ctx.messages, config.gate);
		if (!gate.admit) return [];

		const hash = packetHash(gate.packet);
		return [
			{
				sources: [{ kind: "session", id: `${ctx.sessionId}#regression-verdict=${hash}` }],
				sourceSetHash: `regression-verdict(${ctx.sessionId}|${hash})`,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: { packet: gate.packet, hash, reason: gate.reason },
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext) {
		const config = resolveConfig(ctx.config.configJson);
		const packet = (unit.meta?.["packet"] as EvidencePacket | undefined) ?? gateSession(await ctx.getSessionMessages(ctx.sessionId), config.gate).packet;
		const reason = String(unit.meta?.["reason"] ?? "");

		const model = config.model?.trim() || ctx.modelTiers[config.tier] || config.tier;
		const res = await ctx.llm({
			model,
			system: VERDICT_SYSTEM,
			user: buildVerdictPrompt(packet),
			temperature: config.temperature,
			maxTokens: config.maxTokens,
			reasoning: "off",
			tool: VERDICT_TOOL,
		});

		const verdict: Verdict = parseVerdict(res.structured);

		const properties = {
			session_id: ctx.sessionId,
			...verdict,
			gate_reason: reason,
			gated: true,
			packet_hash: packetHash(packet),
			packet_sizes: {
				failures: packet.failures.length,
				commits: packet.commits.length,
				statements: packet.defect_statements.length,
				files: packet.files_touched.length,
			},
		};

		const edges: Array<{ toRefKind: string; toRefId: string; edgeKind: string; ordinal: number }> = [
			{ toRefKind: "session", toRefId: ctx.sessionId, edgeKind: "anchors", ordinal: 0 },
		];

		return {
			nodeKind: "classification" as const,
			contentJson: properties,
			anchorKind: "session" as const,
			anchorRef: ctx.sessionId,
			modelUsed: res.model,
			costUsd: res.costUsd,
			tokensUsed: res.tokensUsed,
			inputTokens: res.inputTokens ?? 0,
			cachedInputTokens: res.cachedInputTokens ?? 0,
			outputTokens: res.outputTokens ?? 0,
			durationMs: res.durationMs,
			edges,
		};
	},
};

export default regressionVerdictAnalyzer;
