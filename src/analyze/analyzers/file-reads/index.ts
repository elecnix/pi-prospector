/**
 * file-reads — the files a session read, in the order it read them.
 *
 * One session-anchored metric node per session: every read with its path
 * (relative to the working directory), its rank among the session's distinct
 * files, the tool, the size of the result and whether it was ranged; plus the
 * files the session edited. Deterministic, no LLM, and it proposes nothing.
 *
 * Which files a repository's sessions keep opening on is a corpus question, so it
 * is in no node: the `graph` output folds every session at read time into one
 * graph per repository (a virtual session root, then an edge to each next file),
 * and lists the files and paths whose reads a documentation or refactoring change
 * could save. Repositories are keyed by `repo-identity` where it found a key, so
 * worktrees of one repository fold together, and by working directory otherwise.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerOutput,
	AnalyzerOutputContext,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	OutputArtifact,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { latestBySession } from "../../outputs.js";
import { Type, type Static } from "typebox";
import { getSessionCwd } from "../session-overview/cross-session.js";
import { DEFAULT_FILE_READS_CONFIG, type FileReadsConfig } from "./config.js";
import { FileRead, edgesCsv, extractReads, filesCsv, foldReadGraphs, reportMarkdown, type SessionInput } from "./detect.js";

/** The properties a file-reads node carries in its `contentJson`. */
export const FILE_READS_PROPERTIES = Type.Object({
	session_id: Type.String(),
	/** The working directory paths were made relative to; "" when the session recorded none. */
	cwd: Type.String(),
	reads: Type.Array(FileRead),
	edited: Type.Array(Type.String()),
});
export type FileReadsProperties = Static<typeof FILE_READS_PROPERTIES>;

export const FILE_READS_DEF: AnalyzerDef = {
	id: "file-reads",
	label: "File Reads (deterministic)",
	description:
		"Records the files a session read, in order: each read's path relative to the working directory, its rank among the session's distinct files, the tool, the size of the result, and whether it asked for part of the file; plus the files the session edited. One session-anchored metric node per session. The `graph` output folds every session into one read graph per repository, from a virtual session root, and lists the files sessions open on, the large files they keep reading, and the files read one after the other. Deterministic, no LLM; it proposes nothing.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: FILE_READS_PROPERTIES,
};

export const FILE_READS_VERSION: AnalyzerVersion = {
	analyzerId: FILE_READS_DEF.id,
	// 1.0: ordered reads per session, and the per-repository read graph output.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/file-reads/index.ts",
};

function resolveConfig(raw: unknown): FileReadsConfig {
	return { ...DEFAULT_FILE_READS_CONFIG, ...((raw as Partial<FileReadsConfig> | null | undefined) ?? {}) };
}

/** Fingerprint of what extraction reads: ids, roles, and the calls and results. */
function readsFingerprint(messages: readonly MessageRow[], cwd: string): string {
	return shortHash(
		[cwd, ...messages.map((m) => [m.id, m.role, m.tool_calls ? shortHash(m.tool_calls) : "", m.tool_results ? shortHash(m.tool_results) : ""].join(":"))].join("\n"),
	);
}

const graphOutput: AnalyzerOutput = {
	def: {
		id: "graph",
		label: "File read graph by repository (CSV + Markdown)",
		description:
			"Folds every session's reads into one graph per repository: a virtual session root, an edge to each next distinct file, labelled by the sessions that took it. Writes `file-reads-files.csv` (per file: sessions, reads, opening and first reads, median rank and size, whole-read share, sessions that edited it), `file-reads-edges.csv`, and `file-reads-report.md` (a Mermaid graph per repository and the leads for documentation and refactoring). Option: `repo` keeps only repositories whose key contains it.",
	},
	render: async (ctx: AnalyzerOutputContext): Promise<OutputArtifact[]> => {
		const config = resolveConfig(ctx.config);
		const filter = (ctx.options.repo ?? "").trim();

		// Repository keys come from repo-identity when it found one. An output may read
		// any analyzer's nodes without a dependency: it writes nothing (see types.ts).
		const repoKey = new Map<string, string>();
		for (const node of latestBySession(await ctx.getNodes("repo-identity"))) {
			const key = (JSON.parse(node.content_json) as { repo_key: string | null }).repo_key;
			if (key) repoKey.set(node.session_id, key);
		}
		const sessions: SessionInput[] = latestBySession(await ctx.ownNodes).map((node) => {
			const content = JSON.parse(node.content_json) as FileReadsProperties;
			const repo = repoKey.get(node.session_id) ?? (content.cwd ? `dir:${content.cwd}` : "(no working directory)");
			return { sessionId: node.session_id, repo, reads: content.reads, edited: content.edited };
		});
		const graphs = foldReadGraphs(sessions, config).filter((g) => filter === "" || g.repo.includes(filter));
		if (filter !== "" && graphs.length === 0) throw new Error(`No repository key contains '${filter}'.`);

		const fileCount = graphs.reduce((n, g) => n + g.files.length, 0);
		return [
			{ filename: "file-reads-files.csv", mediaType: "text/csv", content: filesCsv(graphs), summary: `${fileCount} file(s) across ${graphs.length} repositor(ies)` },
			{ filename: "file-reads-edges.csv", mediaType: "text/csv", content: edgesCsv(graphs), summary: `${graphs.reduce((n, g) => n + g.edges.length, 0)} edge(s), session root included` },
			{ filename: "file-reads-report.md", mediaType: "text/markdown", content: reportMarkdown(graphs, config), summary: "Read graph and documentation and refactoring leads per repository" },
		];
	},
};

export const fileReadsAnalyzer: Analyzer = {
	def: FILE_READS_DEF,
	version: FILE_READS_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: FILE_READS_DEF.id,
		configHash: computeConfigHash(DEFAULT_FILE_READS_CONFIG),
		configJson: DEFAULT_FILE_READS_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},
	outputs: [graphOutput],

	async plan(ctx: AnalyzerPlanContext): Promise<AnalysisUnit[]> {
		if (ctx.messages.length === 0) return [];
		const cwd = await getSessionCwd(ctx.db, ctx.sessionId);
		const sources: SourceRef[] = [{ kind: "session", id: ctx.sessionId }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`file-reads(${ctx.sessionId}|${readsFingerprint(ctx.messages, cwd)})`),
				anchorKind: "session" as const,
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const cwd = await getSessionCwd(ctx.db, ctx.sessionId);
		const extracted = extractReads(await ctx.getSessionMessages(ctx.sessionId), cwd);
		const properties: FileReadsProperties = { session_id: ctx.sessionId, cwd, ...extracted };
		return {
			nodeKind: "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges: [{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 }],
		};
	},
};
