/**
 * Unit tests for the analyzer `outputs` capability: address resolution, the
 * per-session node fold, shape validation, and the render loop's node caching.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	latestBySession,
	listOutputs,
	renderOutputs,
	resolveOutputs,
	validateOutputs,
} from "../../src/analyze/outputs.js";
import type { Analyzer, AnalysisNodeRow, AnalyzerOutput } from "../../src/analyze/types.js";

function output(id: string, filename = `${id}.txt`): AnalyzerOutput {
	return {
		def: { id, label: `Label ${id}`, description: `Description ${id}` },
		render: () => [{ filename, mediaType: "text/plain", content: id }],
	};
}

function analyzer(id: string, outputs?: AnalyzerOutput[]): Analyzer {
	return {
		def: { id, label: id, description: id, anchorSpan: "full_session", dependencies: [] },
		version: { analyzerId: id, major: 1, minor: 0, implementationKind: "deterministic" },
		prompts: {},
		defaultConfig: { id: "", analyzerId: id, configHash: "h", configJson: { k: id }, label: "default" },
		plan: () => [],
		analyze: () => {
			throw new Error("not used");
		},
		...(outputs ? { outputs } : {}),
	};
}

function node(sessionId: string, createdAt: string, id: string, json = "{}"): AnalysisNodeRow {
	return {
		id,
		session_id: sessionId,
		analyzer_id: "a",
		analyzer_version_id: "v",
		config_id: "c",
		run_id: null,
		node_kind: "metric",
		content_json: json,
		source_set_hash: `${sessionId}:${createdAt}`,
		input_key: id,
		output_key: id,
		config_fingerprint: "f",
		model_used: null,
		cost_usd: null,
		tokens_used: null,
		duration_ms: null,
		created_at: createdAt,
	};
}

describe("listOutputs", () => {
	it("addresses each output as analyzer:output and skips analyzers with none", () => {
		const all = listOutputs([analyzer("alpha", [output("report"), output("csv")]), analyzer("beta")]);
		assert.deepEqual(all.map((o) => o.address), ["alpha:report", "alpha:csv"]);
	});
});

describe("resolveOutputs", () => {
	const analyzers = [analyzer("alpha", [output("report"), output("csv")]), analyzer("beta", [output("report")])];

	it("resolves a fully qualified address", () => {
		assert.deepEqual(resolveOutputs(analyzers, "alpha:csv").map((o) => o.address), ["alpha:csv"]);
	});

	it("resolves an analyzer id to every output it declares", () => {
		assert.deepEqual(resolveOutputs(analyzers, "alpha").map((o) => o.address), ["alpha:report", "alpha:csv"]);
	});

	it("resolves a bare output id when only one analyzer declares it", () => {
		assert.deepEqual(resolveOutputs(analyzers, "csv").map((o) => o.address), ["alpha:csv"]);
	});

	it("refuses an ambiguous bare output id rather than picking one", () => {
		assert.throws(() => resolveOutputs(analyzers, "report"), /more than one analyzer.*alpha:report.*beta:report/s);
	});

	it("lists what is available when the spec is unknown", () => {
		assert.throws(() => resolveOutputs(analyzers, "nope"), /Unknown output 'nope'.*alpha:report/s);
	});

	it("rejects an empty spec", () => {
		assert.throws(() => resolveOutputs(analyzers, "   "), /No output requested/);
	});
});

describe("latestBySession", () => {
	it("keeps only the newest node for a session analysed twice", () => {
		const kept = latestBySession([
			node("s1", "2026-08-14T10:00:00Z", "old"),
			node("s1", "2026-08-14T12:00:00Z", "new"),
			node("s2", "2026-08-14T11:00:00Z", "other"),
		]);
		assert.deepEqual(kept.map((n) => n.id).sort(), ["new", "other"]);
	});

	it("breaks a created_at tie deterministically, not by input order", () => {
		const ts = "2026-08-14T10:00:00Z";
		const forward = latestBySession([node("s1", ts, "aaa"), node("s1", ts, "bbb")]);
		const reversed = latestBySession([node("s1", ts, "bbb"), node("s1", ts, "aaa")]);
		assert.equal(forward[0]!.id, "bbb");
		assert.equal(reversed[0]!.id, "bbb");
	});

	it("passes through one node per session unchanged", () => {
		const rows = [node("s1", "2026-08-14T10:00:00Z", "a"), node("s2", "2026-08-14T10:00:00Z", "b")];
		assert.equal(latestBySession(rows).length, 2);
	});
});

describe("validateOutputs", () => {
	it("accepts an analyzer with no outputs", () => {
		assert.equal(validateOutputs(analyzer("a")), null);
	});

	it("accepts a well-formed output", () => {
		assert.equal(validateOutputs(analyzer("a", [output("report")])), null);
	});

	it("rejects a duplicate output id", () => {
		assert.match(String(validateOutputs(analyzer("a", [output("report"), output("report")]))), /duplicate output id/);
	});

	it("rejects a colon in an output id, which would break addressing", () => {
		assert.match(String(validateOutputs(analyzer("a", [output("a:b")]))), /must not contain ':'/);
	});

	it("rejects a missing render function", () => {
		const broken = analyzer("a", [output("report")]);
		(broken.outputs as AnalyzerOutput[])[0]!.render = undefined as never;
		assert.match(String(validateOutputs(broken)), /render must be a function/);
	});

	it("rejects an empty id", () => {
		assert.match(String(validateOutputs(analyzer("a", [output("")]))), /non-empty string/);
	});
});

describe("renderOutputs", () => {
	/** A stand-in for better-sqlite3; renderOutputs only passes it through. */
	const fakeDb = {} as never;

	it("hands the output its own analyzer's config and the caller's options", async () => {
		let seen: { config: unknown; options: unknown } | null = null;
		const a = analyzer("alpha", [
			{
				def: { id: "probe", label: "Probe", description: "d" },
				render: (ctx) => {
					seen = { config: ctx.config, options: ctx.options };
					return [];
				},
			},
		]);
		await renderOutputs(resolveOutputs([a], "alpha:probe"), { db: fakeDb, options: { day: "2026-08-14" } });
		assert.deepEqual(seen, { config: { k: "alpha" }, options: { day: "2026-08-14" } });
	});

	it("returns each output's artifacts under its address", async () => {
		const a = analyzer("alpha", [output("report", "r.html"), output("csv", "c.csv")]);
		const results = await renderOutputs(resolveOutputs([a], "alpha"), { db: fakeDb });
		assert.deepEqual(
			results.map((r) => [r.address, r.artifacts[0]!.filename]),
			[["alpha:report", "r.html"], ["alpha:csv", "c.csv"]],
		);
	});

	it("awaits an async render", async () => {
		const a = analyzer("alpha", [
			{
				def: { id: "slow", label: "Slow", description: "d" },
				render: async () => [{ filename: "s.txt", mediaType: "text/plain", content: "done" }],
			},
		]);
		const results = await renderOutputs(resolveOutputs([a], "alpha:slow"), { db: fakeDb });
		assert.equal(results[0]!.artifacts[0]!.content, "done");
	});
});
