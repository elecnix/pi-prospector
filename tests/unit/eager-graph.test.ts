import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

/**
 * #292: pi loads every extension through jiti, which transpiles each file of the
 * graph at runtime. Before this guard, `src/index.ts` imported all 22 command
 * modules, so a bare `pi` start transpiled the whole extension — 177 files,
 * 90k `statx` calls — and paid ~5s before the prompt appeared.
 *
 * The rule this test enforces: what `src/index.ts` reaches through *static*
 * imports is the registration surface only. Everything else waits behind a
 * dynamic `import()` inside the handler that needs it.
 */

const SRC = path.resolve(import.meta.dirname, "..", "..", "src");
const ENTRY = path.join(SRC, "index.ts");

/**
 * The whole statically-imported graph at a bare `pi` start, relative to `src/`.
 * Adding a file here is a deliberate act: it is transpiled on every startup, so
 * it must earn its place. Command implementations belong in a `load` function in
 * `src/commands/registry.ts` instead.
 */
const STARTUP_SURFACE = [
	"index.ts",
	"lazy.ts",
	"commands/headless.ts",
	"commands/registry.ts",
	"commands/tool-schema.ts",
	// Registers the usage-report listener (#290); its work loads on session_start.
	"telemetry/register.ts",
];

/** Relative specifiers a file imports for its value (never `import type`). */
function valueImports(file: string): string[] {
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.ES2022, true);
	const specifiers: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
			specifiers.push(node.moduleSpecifier.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return specifiers;
}

/** Resolve a relative specifier to a file under `src/`, or undefined for a package. */
function resolve(from: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = path.resolve(path.dirname(from), specifier);
	// A relative import names either a module (`./x.js` resolves to `x.ts`) or a
	// directory, in which case it resolves to that directory's index.
	const candidates = [base.replace(/\.js$/, ".ts"), path.join(base, "index.ts")];
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	throw new Error(`${path.relative(SRC, from)} imports ${specifier}, which resolves to none of ${candidates.map((c) => path.relative(SRC, c)).join(", ")}`);
}

/** Every file reachable from `src/index.ts` through static value imports. */
function startupGraph(): Set<string> {
	const reached = new Set<string>();
	const queue = [ENTRY];
	while (queue.length > 0) {
		const file = queue.pop()!;
		const relative = path.relative(SRC, file);
		if (reached.has(relative)) continue;
		reached.add(relative);
		for (const specifier of valueImports(file)) {
			const next = resolve(file, specifier);
			if (next !== undefined) queue.push(next);
		}
	}
	return reached;
}

describe("startup graph (#292)", () => {
	it("reaches the entry point and the registration surface", () => {
		const graph = startupGraph();
		assert.ok(graph.has("index.ts"), "the walk must start at src/index.ts");
		assert.ok(
			graph.has("commands/registry.ts"),
			"the walk must reach the command table, or it is not testing anything",
		);
	});

	it("loads only the registration surface at startup", () => {
		const unexpected = [...startupGraph()].filter((file) => !STARTUP_SURFACE.includes(file)).sort();
		assert.deepEqual(
			unexpected,
			[],
			`these files would be transpiled on every startup: ${unexpected.join(", ")}`,
		);
	});

	it("keeps the analyzer, database, and sync subtrees out of startup", () => {
		const heavy = [...startupGraph()].filter((file) => /^(analyze|db|sync)\//.test(file)).sort();
		assert.deepEqual(
			heavy,
			[],
			`heavy modules must sit behind a dynamic import(): ${heavy.join(", ")}`,
		);
	});
});
