/**
 * Unit tests for the custom-analyzer loader.
 *
 * Fixtures are written to a temp dir at runtime as `.mjs` (plain JS, so the
 * dynamic import is deterministic without relying on a TS loader hook). The
 * loader's directory scan additionally matches `.ts`/`.js`; the end-to-end
 * `.ts`-under-pi path is exercised by the tmux integration check.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomAnalyzers, resolveAnalyzerPaths } from "../../src/analyze/loader.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-analyzers-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** A minimal, valid deterministic analyzer as plain-JS source. */
function validAnalyzerSource(id: string, greeting = "hi"): string {
	return `export default {
  def: { id: ${JSON.stringify(id)}, label: "Echo", description: "test", anchorSpan: "full_session", dependencies: [] },
  version: { analyzerId: ${JSON.stringify(id)}, major: 1, minor: 0, implementationKind: "deterministic" },
  prompts: {},
  defaultConfig: { id: "", analyzerId: ${JSON.stringify(id)}, configHash: "", configJson: { greeting: ${JSON.stringify(greeting)} }, label: "default" },
  plan(ctx) {
    return [{ sources: [{ kind: "session", id: ctx.sessionId }], sourceSetHash: "sset-" + ctx.sessionId, anchorKind: "session", anchorRef: ctx.sessionId }];
  },
  analyze(unit, ctx) {
    return { nodeKind: "metric", contentJson: { greeting: ${JSON.stringify(greeting)}, messageCount: ctx.getSessionMessages(ctx.sessionId).length }, anchorKind: "session", anchorRef: ctx.sessionId, edges: [] };
  }
};
`;
}

function write(dir: string, name: string, source: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, source);
	return file;
}

describe("loadCustomAnalyzers", () => {
	it("loads a valid analyzer from a directory and normalises its config hash", async () => {
		write(tmp, "echo.analyzer.mjs", validAnalyzerSource("custom-echo"));
		const result = await loadCustomAnalyzers({ paths: [tmp] });

		assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
		assert.equal(result.loaded.length, 1);
		const a = result.loaded[0]!;
		assert.equal(a.def.id, "custom-echo");
		// configHash left empty in source → loader fills it from configJson.
		assert.ok(a.defaultConfig.configHash.length > 0, "configHash should be filled");
		// Disk-loaded analyzers carry a content hash for identity-on-edit.
		assert.ok(a.contentHash && a.contentHash.length > 0, "contentHash should be set");
	});

	it("only picks up *.analyzer.{ts,js,mjs}, ignoring helper files", async () => {
		write(tmp, "echo.analyzer.mjs", validAnalyzerSource("custom-echo"));
		write(tmp, "helpers.mjs", "export const x = 1;");
		write(tmp, "README.md", "# not an analyzer");
		const result = await loadCustomAnalyzers({ paths: [tmp] });
		assert.equal(result.loaded.length, 1);
		assert.equal(result.loaded[0]!.def.id, "custom-echo");
	});

	it("skips a malformed analyzer with an error but still loads valid ones", async () => {
		write(tmp, "good.analyzer.mjs", validAnalyzerSource("good-one"));
		// Missing `analyze` function → invalid.
		write(
			tmp,
			"bad.analyzer.mjs",
			`export default { def: { id: "bad", label: "b", description: "d", anchorSpan: "full_session", dependencies: [] }, version: { analyzerId: "bad", major: 1, minor: 0, implementationKind: "deterministic" }, prompts: {}, defaultConfig: { id: "", analyzerId: "bad", configHash: "", configJson: {}, label: "default" }, plan() { return []; } };`,
		);
		const result = await loadCustomAnalyzers({ paths: [tmp] });
		assert.equal(result.loaded.length, 1);
		assert.equal(result.loaded[0]!.def.id, "good-one");
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0]!.message, /analyze/i);
		assert.ok(result.errors[0]!.path.endsWith("bad.analyzer.mjs"));
	});

	it("reports a collision with a built-in analyzer id", async () => {
		write(tmp, "dup.analyzer.mjs", validAnalyzerSource("tool-trajectory"));
		const result = await loadCustomAnalyzers({ paths: [tmp], builtinIds: ["tool-trajectory"] });
		assert.equal(result.loaded.length, 0);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0]!.message, /collid|conflict|already/i);
	});

	it("reports a collision between two custom analyzers sharing an id", async () => {
		write(tmp, "a.analyzer.mjs", validAnalyzerSource("twin"));
		write(tmp, "b.analyzer.mjs", validAnalyzerSource("twin"));
		const result = await loadCustomAnalyzers({ paths: [tmp] });
		assert.equal(result.loaded.length, 1);
		assert.equal(result.errors.length, 1);
	});

	it("re-imports edited files (cache-bust) so contentHash reflects the edit", async () => {
		const file = write(tmp, "echo.analyzer.mjs", validAnalyzerSource("custom-echo", "hi"));
		const first = await loadCustomAnalyzers({ paths: [tmp] });
		const hash1 = first.loaded[0]!.contentHash;

		// Rewrite with different behaviour; bump mtime so the cache-bust key changes.
		fs.writeFileSync(file, validAnalyzerSource("custom-echo", "hello"));
		const future = new Date(Date.now() + 2000);
		fs.utimesSync(file, future, future);

		const second = await loadCustomAnalyzers({ paths: [tmp] });
		const hash2 = second.loaded[0]!.contentHash;
		assert.notEqual(hash1, hash2, "edited file should yield a new content hash");
		assert.equal(second.loaded[0]!.defaultConfig.configJson["greeting"], "hello");
	});

	it("ignores paths that do not exist", async () => {
		const result = await loadCustomAnalyzers({ paths: [path.join(tmp, "nope")] });
		assert.equal(result.loaded.length, 0);
		assert.equal(result.errors.length, 0);
	});

	it("accepts an explicit file path, not just directories", async () => {
		const file = write(tmp, "single.analyzer.mjs", validAnalyzerSource("single"));
		const result = await loadCustomAnalyzers({ paths: [file] });
		assert.equal(result.loaded.length, 1);
		assert.equal(result.loaded[0]!.def.id, "single");
	});
});

describe("resolveAnalyzerPaths", () => {
	it("orders explicit paths before project and user dirs", () => {
		const paths = resolveAnalyzerPaths({
			explicit: ["/x/one.analyzer.ts"],
			config: { analyzerPaths: ["/cfg/dir"] },
			projectDir: "/proj/.prospector/analyzers",
			userDir: "/home/.pi/agent/prospector/analyzers",
		});
		assert.deepEqual(paths, [
			"/x/one.analyzer.ts",
			"/cfg/dir",
			"/proj/.prospector/analyzers",
			"/home/.pi/agent/prospector/analyzers",
		]);
	});

	it("dedups repeated paths preserving first occurrence", () => {
		const paths = resolveAnalyzerPaths({
			explicit: ["/dup"],
			config: { analyzerPaths: ["/dup"] },
			projectDir: "/proj",
			userDir: "/user",
		});
		assert.deepEqual(paths, ["/dup", "/proj", "/user"]);
	});
});
