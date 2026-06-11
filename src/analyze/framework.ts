/**
 * AnalyzerFramework — registers analyzers and runs them incrementally over
 * session data, producing an append-only, versioned analysis graph.
 *
 * Incrementality model
 * ─────────────────────
 * Each analyzer's `plan()` enumerates the logical *units* of work for a session
 * (e.g. one unit per turn-pair, or one unit per session). Each unit carries a
 * `source_set_hash` identifying exactly which inputs it covers.
 *
 * `scan()` classifies every planned unit against the current graph state:
 *   - current  — a node already exists for this exact recipe (analyzer version +
 *                config fingerprint + source set). Nothing to do.
 *   - stale    — a node exists for this logical unit but under a different recipe.
 *                Staleness carries its *reasons*: `major`/`minor` (the analyzer
 *                version moved, graded by the author) and/or `config` (the user's
 *                setup changed, ungraded).
 *   - missing  — no node exists for this logical unit at all.
 *
 * Revise reasons (a run's reach)
 *   - no reasons (default): only `missing` units are analysed; existing nodes are
 *     left untouched.
 *   - any of `major`/`minor`/`config`: a stale unit is also analysed when one of
 *     its reasons was requested (`minor` implies `major`). A recomputed unit
 *     produces a new node linked to its predecessor by a `revises` edge, so both
 *     versions coexist "at the same level" and the lineage is navigable. The
 *     reasons only *select* units; a selected unit is always recomputed to the
 *     current recipe in full — latest version, config, and resolved model.
 *
 * There is no crash-recovery bookkeeping. Idempotency is structural: a finished
 * node is `current` (skipped on the next run); an unfinished unit is still
 * `missing`/`stale` and is simply picked up again. Re-running after any failure
 * converges with no special handling.
 */

import type Database from "better-sqlite3";
import type {
	Analyzer,
	AnalyzerConfig,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerRunResult,
	AnalysisNodeRow,
	AnalysisResult,
	AnalysisUnit,
	ClassifiedUnit,
	LLMCaller,
	MessageRow,
	ModelTierConfig,
	ReviseReason,
	RunSummary,
} from "./types.js";
import {
	computeConfigFingerprint,
	computeInputHash,
	computePromptBundleHash,
	shortHash,
	uuidv7,
} from "./input-hash.js";
import {
	expandReviseReasons,
	gradeVersionMove,
	parseVersionId,
	reachLabel,
	versionIdOf,
} from "./version.js";
import { EDGE_KINDS, REF_KINDS, validateEdge } from "./edge-kinds.js";
import {
	createRun,
	finishRun,
	findLatestNodeBySourceSet,
	findNodeByInputHash,
	getAnchoredMessageIds,
	getMessage,
	getNode,
	getNodesByAnalyzer,
	getSessionNodes,
	insertEdge,
	insertNode,
	registerPrompt,
	resolveConfig,
	upsertAnalyzerDef,
	upsertAnalyzerVersion,
} from "../db/analysis-queries.js";
import { materializeProposalsFromNode } from "./proposal-materializer.js";

export interface FrameworkDeps {
	db: Database.Database;
	llm: LLMCaller;
	modelTiers: ModelTierConfig;
}

interface ResolvedAnalyzer {
	analyzer: Analyzer;
	config: AnalyzerConfig;
	promptBundleHash: string;
	configFingerprint: string;
}

export class AnalyzerFramework {
	private readonly analyzers = new Map<string, Analyzer>();

	constructor(private readonly deps: FrameworkDeps) {}

	/** Register an analyzer and persist its def, version, prompts, and default config. */
	register(analyzer: Analyzer): void {
		upsertAnalyzerDef(this.deps.db, analyzer.def);
		upsertAnalyzerVersion(this.deps.db, analyzer.version);
		for (const prompt of Object.values(analyzer.prompts)) {
			registerPrompt(this.deps.db, prompt);
		}
		this.analyzers.set(analyzer.def.id, analyzer);
	}

	get(id: string): Analyzer | undefined {
		return this.analyzers.get(id);
	}

	list(): Analyzer[] {
		return [...this.analyzers.values()];
	}

	/**
	 * Classify the work for a session without performing any analysis. This is
	 * the efficient full-graph rescan: it runs each analyzer's `plan()` and
	 * compares every unit against existing nodes. Pure read; no side effects.
	 */
	async scan(sessionId: string, analyzerIds?: string[]): Promise<ClassifiedUnit[]> {
		const order = this.topologicalSort(analyzerIds);
		const out: ClassifiedUnit[] = [];
		for (const analyzerId of order) {
			const resolved = this.resolve(analyzerId);
			const planCtx = this.buildPlanContext(resolved.analyzer, resolved.config, sessionId);
			const units = await resolved.analyzer.plan(planCtx);
			for (const unit of units) {
				out.push(this.classify(resolved, unit));
			}
		}
		return out;
	}

	/**
	 * Run analysis for a session. With no revise reasons only missing units are
	 * produced; reasons (`major`/`minor`/`config`) additionally recompute matching
	 * stale units into new versions linked by `revises` edges.
	 */
	async run(
		sessionId: string,
		opts: { revise?: ReviseReason[]; analyzerIds?: string[]; modelSpec?: string } = {},
	): Promise<RunSummary> {
		const revise = opts.revise ?? [];
		const requested = expandReviseReasons(revise);
		const order = this.topologicalSort(opts.analyzerIds);

		const summary: RunSummary = {
			sessionId,
			revise,
			analyzerResults: [],
			nodesProduced: 0,
			nodesSkipped: 0,
			nodesRevised: 0,
			proposalsCreated: 0,
			costUsd: 0,
			tokensUsed: 0,
			errors: [],
		};

		for (const analyzerId of order) {
			const result = await this.runAnalyzer(analyzerId, sessionId, requested, opts.modelSpec, summary);
			summary.analyzerResults.push(result);
		}

		return summary;
	}

	private async runAnalyzer(
		analyzerId: string,
		sessionId: string,
		requested: ReadonlySet<ReviseReason>,
		modelSpec: string | undefined,
		summary: RunSummary,
	): Promise<AnalyzerRunResult> {
		const resolved = this.resolve(analyzerId);
		const { analyzer, config, promptBundleHash } = resolved;

		const planCtx = this.buildPlanContext(analyzer, config, sessionId);
		const units = await analyzer.plan(planCtx);

		const classified = units.map((unit) => this.classify(resolved, unit));
		const todo = classified.filter(
			(c) => c.status === "missing" || (c.status === "stale" && c.reasons.some((r) => requested.has(r))),
		);

		const runId = uuidv7();
		createRun(this.deps.db, {
			id: runId,
			analyzerId: analyzer.def.id,
			analyzerVersionId: versionIdOf(analyzer.version),
			configId: config.id,
			sessionId,
			mode: reachLabel(requested),
			promptBundleHash,
			modelSpec,
		});

		const result: AnalyzerRunResult = {
			analyzerId: analyzer.def.id,
			runId,
			nodesProduced: 0,
			nodesSkipped: classified.length - todo.length,
			nodesRevised: 0,
			costUsd: 0,
			tokensUsed: 0,
			status: "ok",
		};

		const runCtx = this.buildRunContext(analyzer, config, sessionId);

		for (const item of todo) {
			try {
				const analysis = await analyzer.analyze(item.unit, runCtx);
				const created = this.persistNode(resolved, runId, sessionId, item, analysis);
				result.nodesProduced++;
				if (item.status === "stale" && item.priorNodeId) result.nodesRevised++;
				result.costUsd += analysis.costUsd ?? 0;
				result.tokensUsed += analysis.tokensUsed ?? 0;
				summary.proposalsCreated += created.proposalsCreated;
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				result.status = "partial";
				summary.errors.push(`${analyzer.def.id}: ${message}`);
				this.persistErrorNode(resolved, runId, sessionId, item, message);
			}
		}

		finishRun(this.deps.db, runId, {
			status: result.status,
			nodesProduced: result.nodesProduced,
			nodesSkipped: result.nodesSkipped,
			costUsd: result.costUsd,
			tokensUsed: result.tokensUsed,
			errorMessage: result.status === "partial" ? "one or more units failed" : null,
		});

		summary.nodesProduced += result.nodesProduced;
		summary.nodesSkipped += result.nodesSkipped;
		summary.nodesRevised += result.nodesRevised;
		summary.costUsd += result.costUsd;
		summary.tokensUsed += result.tokensUsed;

		return result;
	}

	// ───────────────────────── classification ─────────────────────────

	private classify(resolved: ResolvedAnalyzer, unit: AnalysisUnit): ClassifiedUnit {
		const { analyzer, configFingerprint } = resolved;
		const inputHash = computeInputHash({
			analyzerId: analyzer.def.id,
			analyzerVersionId: versionIdOf(analyzer.version),
			configFingerprint,
			sourceSetHash: unit.sourceSetHash,
		});

		// Error nodes carry a decoupled identity, so `findNodeByInputHash` matches
		// only a successful result at this exact recipe, and `findLatestNodeBySourceSet`
		// skips errors. A unit whose only history is failures therefore classifies as
		// `missing` and is recomputed on the next scan that reaches it.
		if (findNodeByInputHash(this.deps.db, inputHash)) {
			return { analyzerId: analyzer.def.id, unit, status: "current", inputHash, reasons: [] };
		}

		const prior = findLatestNodeBySourceSet(this.deps.db, analyzer.def.id, unit.sourceSetHash);
		if (prior) {
			const reasons = this.gradeStale(resolved, prior);
			return { analyzerId: analyzer.def.id, unit, status: "stale", inputHash, priorNodeId: prior.id, reasons };
		}

		return { analyzerId: analyzer.def.id, unit, status: "missing", inputHash, reasons: [] };
	}

	/**
	 * Why is an existing node out of date? At most one version reason
	 * (`major`/`minor`, graded by the author from the version move) plus `config`
	 * when the user's config fingerprint differs. A pure version downgrade yields
	 * no reason, so the newer node is left in place.
	 */
	private gradeStale(resolved: ResolvedAnalyzer, prior: AnalysisNodeRow): ReviseReason[] {
		const reasons: ReviseReason[] = [];
		const versionReason = gradeVersionMove(parseVersionId(prior.analyzer_version_id), {
			major: resolved.analyzer.version.major,
			minor: resolved.analyzer.version.minor,
		});
		if (versionReason) reasons.push(versionReason);
		if (prior.config_fingerprint !== resolved.configFingerprint) reasons.push("config");
		return reasons;
	}

	// ───────────────────────── persistence ─────────────────────────

	private persistNode(
		resolved: ResolvedAnalyzer,
		runId: string,
		sessionId: string,
		item: ClassifiedUnit,
		analysis: AnalysisResult,
	): { nodeId: string; proposalsCreated: number } {
		const { analyzer, config } = resolved;
		const nodeId = uuidv7();
		const now = new Date().toISOString();

		insertNode(this.deps.db, {
			id: nodeId,
			sessionId,
			analyzerId: analyzer.def.id,
			analyzerVersionId: versionIdOf(analyzer.version),
			configId: config.id,
			runId,
			nodeKind: analysis.nodeKind,
			contentJson: JSON.stringify(analysis.contentJson),
			sourceSetHash: item.unit.sourceSetHash,
			inputHash: item.inputHash,
			configFingerprint: resolved.configFingerprint,
			modelUsed: analysis.modelUsed ?? null,
			costUsd: analysis.costUsd ?? null,
			tokensUsed: analysis.tokensUsed ?? null,
			durationMs: analysis.durationMs ?? null,
			createdAt: now,
		});

		this.persistEdges(nodeId, config, analysis);

		// Version lineage: a re-analysed stale unit revises its predecessor.
		if (item.status === "stale" && item.priorNodeId) {
			insertEdge(this.deps.db, {
				fromNodeId: nodeId,
				toRefKind: REF_KINDS.ANALYSIS_NODE,
				toRefId: item.priorNodeId,
				edgeKind: EDGE_KINDS.REVISES,
				ordinal: 0,
			});
		}

		let proposalsCreated = 0;
		if (analysis.nodeKind === "summary" || analysis.nodeKind === "proposal") {
			proposalsCreated = materializeProposalsFromNode(this.deps.db, {
				sessionId,
				analyzerId: analyzer.def.id,
				sourceNodeId: nodeId,
				contentJson: analysis.contentJson,
				now,
			});
		}

		return { nodeId, proposalsCreated };
	}

	private persistEdges(nodeId: string, config: AnalyzerConfig, analysis: AnalysisResult): void {
		let ordinal = 0;
		for (const edge of analysis.edges) {
			validateEdge(edge.edgeKind, edge.toRefKind);
			insertEdge(this.deps.db, {
				fromNodeId: nodeId,
				toRefKind: edge.toRefKind,
				toRefId: edge.toRefId,
				edgeKind: edge.edgeKind,
				ordinal: edge.ordinal ?? ordinal,
			});
			ordinal++;
		}

		// Always record the config provenance edge.
		insertEdge(this.deps.db, {
			fromNodeId: nodeId,
			toRefKind: REF_KINDS.CONFIG_VERSION,
			toRefId: config.id,
			edgeKind: EDGE_KINDS.USES_CONFIG,
			ordinal: ordinal++,
		});
	}

	private persistErrorNode(
		resolved: ResolvedAnalyzer,
		runId: string,
		sessionId: string,
		item: ClassifiedUnit,
		message: string,
	): void {
		const { analyzer, config } = resolved;
		const nodeId = uuidv7();
		const now = new Date().toISOString();
		// An error node's identity is the recipe plus the failure's message and
		// timestamp (with the node id as a uniqueness nonce), so it never occupies
		// the recipe identity reserved for a successful result. The unit therefore
		// stays `missing` and is recomputed on the next scan that reaches it — error
		// nodes are an append-only record of failures, not a completion marker.
		const errorInputHash = shortHash(`error(${item.inputHash}|${message}|${now}|${nodeId})`);
		try {
			insertNode(this.deps.db, {
				id: nodeId,
				sessionId,
				analyzerId: analyzer.def.id,
				analyzerVersionId: versionIdOf(analyzer.version),
				configId: config.id,
				runId,
				nodeKind: "error",
				contentJson: JSON.stringify({ error: message, anchor: item.unit.anchorRef, timestamp: now }),
				sourceSetHash: item.unit.sourceSetHash,
				inputHash: errorInputHash,
				configFingerprint: resolved.configFingerprint,
				createdAt: now,
			});
		} catch {
			// Defensive: never let error-node persistence abort the run.
		}
	}

	// ───────────────────────── contexts ─────────────────────────

	private buildPlanContext(analyzer: Analyzer, config: AnalyzerConfig, sessionId: string): AnalyzerPlanContext {
		const messages = this.loadMessages(sessionId);
		const allNodes = getSessionNodes(this.deps.db, sessionId);
		const ownNodes = allNodes.filter((n) => n.analyzer_id === analyzer.def.id);
		const dependencyNodes: Record<string, AnalysisNodeRow[]> = {};
		for (const depId of analyzer.def.dependencies) {
			dependencyNodes[depId] = allNodes.filter((n) => n.analyzer_id === depId);
		}
		return { sessionId, messages, allNodes, ownNodes, dependencyNodes, config: config.configJson, db: this.deps.db };
	}

	private buildRunContext(analyzer: Analyzer, config: AnalyzerConfig, sessionId: string): AnalyzerRunContext {
		const db = this.deps.db;
		const prompts: Record<string, string> = {};
		for (const [name, p] of Object.entries(analyzer.prompts)) prompts[name] = p.content;

		return {
			sessionId,
			getMessage: (id) => getMessage(db, id),
			getNode: (id) => getNode(db, id),
			getDependencyNodes: (depId) => {
				if (!analyzer.def.dependencies.includes(depId)) {
					throw new Error(
						`Analyzer '${analyzer.def.id}' read dependency '${depId}' without declaring it. ` +
						`Add '${depId}' to def.dependencies.`,
					);
				}
				return getNodesByAnalyzer(db, depId, sessionId);
			},
			getSessionMessages: (sid) => this.loadMessages(sid),
			llm: this.deps.llm,
			config,
			prompts,
			modelTiers: this.deps.modelTiers,
		};
	}

	private loadMessages(sessionId: string): MessageRow[] {
		return db_loadMessages(this.deps.db, sessionId);
	}

	// ───────────────────────── helpers ─────────────────────────

	private resolve(analyzerId: string): ResolvedAnalyzer {
		const analyzer = this.analyzers.get(analyzerId);
		if (!analyzer) throw new Error(`Analyzer not registered: ${analyzerId}`);
		const config = resolveConfig(this.deps.db, {
			analyzerId: analyzer.def.id,
			configJson: analyzer.defaultConfig.configJson,
			label: analyzer.defaultConfig.label,
		});
		const promptBundleHash = computePromptBundleHash(Object.values(analyzer.prompts).map((p) => p.hash));
		// Resolve tier shorthands to concrete models; the resolved model is part of
		// the user's `config` identity (a model swap is an ungraded config change).
		const models = analyzer.modelsForIdentity?.(config.configJson, this.deps.modelTiers) ?? [];
		const configFingerprint = computeConfigFingerprint(config.id, models);
		return { analyzer, config, promptBundleHash, configFingerprint };
	}

	/** Dependency-respecting order of registered analyzers (Kahn-style DFS). */
	topologicalSort(analyzerIds?: string[]): string[] {
		const targets = analyzerIds ?? [...this.analyzers.keys()];
		const visited = new Set<string>();
		const visiting = new Set<string>();
		const order: string[] = [];

		const visit = (id: string): void => {
			if (visited.has(id)) return;
			if (visiting.has(id)) throw new Error(`Dependency cycle detected at analyzer '${id}'`);
			const analyzer = this.analyzers.get(id);
			if (!analyzer) return;
			visiting.add(id);
			for (const dep of analyzer.def.dependencies) visit(dep);
			visiting.delete(id);
			visited.add(id);
			order.push(id);
		};

		for (const id of targets) visit(id);
		return order;
	}

	/** Expose anchored-message lookup for analyzers that need raw turn content. */
	getAnchoredMessages(nodeId: string): MessageRow[] {
		const ids = getAnchoredMessageIds(this.deps.db, nodeId);
		const out: MessageRow[] = [];
		for (const id of ids) {
			const m = getMessage(this.deps.db, id);
			if (m) out.push(m);
		}
		return out;
	}
}

function db_loadMessages(db: Database.Database, sessionId: string): MessageRow[] {
	return db
		.prepare(
			"SELECT id, session_id, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results " +
			"FROM messages WHERE session_id = ? ORDER BY rowid ASC",
		)
		.all(sessionId) as MessageRow[];
}
