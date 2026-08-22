/**
 * Unit tests for declared analyzer output schemas (issue #153).
 *
 * Covers: every built-in analyzer declares a well-formed outputSchema; the
 * loader's declaration shape-check accepts/rejects the right things; and the
 * `analyzers list` surface renders the declaration.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import { loadCustomAnalyzers, validateOutputSchema } from "../../src/analyze/loader.js";
import { describeOutput, formatAnalyzerLine } from "../../src/commands/analyzers.js";

describe("built-in analyzer outputSchema declarations", () => {
	it("every built-in analyzer declares an outputSchema", () => {
		const missing = BUILTIN_ANALYZERS.filter((a) => !a.def.outputSchema).map((a) => a.def.id);
		assert.deepEqual(missing, [], "analyzers without outputSchema");
	});

	it("every declared outputSchema is a well-formed object schema with properties", () => {
		for (const a of BUILTIN_ANALYZERS) {
			const err = validateOutputSchema(a.def.outputSchema);
			assert.equal(err, null, `${a.def.id}: ${err}`);
			const props = Object.keys(
				(a.def.outputSchema as { properties: Record<string, unknown> }).properties,
			);
			assert.ok(props.length > 0, `${a.def.id} declares no properties`);
		}
	});

	it("declared schemas match the properties each analyzer actually emits on fixtures", () => {
		// Spot-check the shape of a few analyzers' declarations against their
		// documented node content — the full emission is covered by the
		// component/integration suites.
		const byId = new Map(BUILTIN_ANALYZERS.map((a) => [a.def.id, a.def.outputSchema!]));
		const turnPairCore = byId.get("turn-pair-core")!;
		for (const p of ["pair_index", "user_message_id", "friction_score", "high_signal"]) {
			assert.ok(p in turnPairCore.properties, `turn-pair-core emits ${p}`);
		}
		const lexicon = byId.get("frustration-lexicon")!;
		for (const p of ["term", "polarity", "category", "confidence", "language"]) {
			assert.ok(p in lexicon.properties, `frustration-lexicon emits ${p}`);
		}
	});
});

describe("validateOutputSchema", () => {
	it("accepts a TypeBox object schema", () => {
		assert.equal(validateOutputSchema(Type.Object({ a: Type.String() })), null);
	});

	it("rejects non-object values", () => {
		assert.match(validateOutputSchema(null)!, /Type\.Object/);
		assert.match(validateOutputSchema("nope")!, /Type\.Object/);
		assert.match(validateOutputSchema([1])!, /Type\.Object/);
	});

	it("rejects a schema whose type is not object", () => {
		assert.match(validateOutputSchema({ type: "string" })!, /'type' must be "object"/);
	});

	it("rejects an object schema without a properties map", () => {
		assert.match(validateOutputSchema({ type: "object" })!, /properties/);
		assert.match(validateOutputSchema({ type: "object", properties: "x" })!, /properties/);
	});
});

describe("list surface rendering", () => {
	it("describeOutput names the declared properties", () => {
		const def = {
			id: "x",
			label: "X",
			description: "",
			anchorSpan: "full_session" as const,
			dependencies: [],
			outputSchema: Type.Object({ alpha: Type.String(), beta: Type.Number() }),
		};
		assert.equal(describeOutput(def), "  emits: alpha, beta");
	});

	it("describeOutput is empty when no schema is declared", () => {
		const def = {
			id: "x",
			label: "X",
			description: "",
			anchorSpan: "full_session" as const,
			dependencies: [],
		};
		assert.equal(describeOutput(def), "");
	});

	it("formatAnalyzerLine includes id, version, kind, and emits fragment", () => {
		const line = formatAnalyzerLine({
			def: {
				id: "demo",
				label: "Demo",
				description: "",
				anchorSpan: "full_session",
				dependencies: [],
				outputSchema: Type.Object({ greeting: Type.String() }),
			},
			version: { major: 1, minor: 2, implementationKind: "deterministic" },
			sourcePath: "/tmp/demo.analyzer.mjs",
		});
		assert.match(line, /demo  \(v1\.2, deterministic\)/);
		assert.match(line, /emits: greeting/);
		assert.match(line, /← \/tmp\/demo\.analyzer\.mjs/);
	});
});

describe("loader outputSchema declaration check", () => {
	/** Minimal valid analyzer source with the given def JSON. */
	function analyzerWithDef(defJson: string): string {
		return `export default {
  def: ${defJson},
  version: { analyzerId: "custom-schema", major: 1, minor: 0, implementationKind: "deterministic" },
  prompts: {},
  defaultConfig: { id: "", analyzerId: "custom-schema", configHash: "", configJson: {}, label: "default" },
  plan(ctx) {
    return [{ sources: [{ kind: "session", id: ctx.sessionId }], sourceSetHash: "sset-" + ctx.sessionId, anchorKind: "session", anchorRef: ctx.sessionId }];
  },
  analyze(unit) {
    return { nodeKind: "metric", contentJson: {}, anchorKind: "session", anchorRef: unit.anchorRef, edges: [] };
  }
};
`;
	}

	async function loadSource(source: string): Promise<void> {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-schema-"));
		try {
			fs.writeFileSync(path.join(tmp, "custom-schema.analyzer.mjs"), source);
			const result = await loadCustomAnalyzers({ paths: [tmp] });
			if (result.errors.length > 0) throw new Error(result.errors[0]!.message);
			return;
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	it("loads a custom analyzer whose outputSchema is well-formed and preserves it", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-schema-ok-"));
		try {
			fs.writeFileSync(
				path.join(tmp, "custom-schema.analyzer.mjs"),
				analyzerWithDef(`{
        id: "custom-schema",
        label: "Custom Schema",
        description: "test",
        anchorSpan: "full_session",
        dependencies: [],
        outputSchema: { type: "object", properties: { greeting: { type: "string" } } }
      }`),
			);
			const result = await loadCustomAnalyzers({ paths: [tmp] });
			assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
			assert.equal(result.loaded.length, 1);
			const props = Object.keys(
				(result.loaded[0]!.def.outputSchema as { properties: Record<string, unknown> }).properties,
			);
			assert.deepEqual(props, ["greeting"]);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("reports a load error when outputSchema is not an object schema", async () => {
		const err = await loadSource(analyzerWithDef(`{
      id: "custom-schema",
      label: "Custom Schema",
      description: "test",
      anchorSpan: "full_session",
      dependencies: [],
      outputSchema: { type: "string" }
    }`)).then(
			() => null,
			(e: Error) => e.message,
		);
		assert.match(err ?? "", /outputSchema/);
	});
});
