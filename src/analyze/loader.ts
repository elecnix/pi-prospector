/**
 * Custom-analyzer loader — discovery + dynamic import + validation.
 *
 * A custom analyzer is a standalone module that default-exports (or named-exports
 * `analyzer`) an object satisfying the `Analyzer` contract. Because the extension
 * runs under `tsx`, a custom analyzer can be plain `.ts`; `.js`/`.mjs` work too.
 *
 * Discovery resolves a precedence-ordered list of paths (files or directories),
 * scans directories for `*.analyzer.{ts,js,mjs}` (the naming convention keeps
 * helper files from being imported as analyzers), dynamically imports each with
 * an mtime cache-busting query string (so an edited file re-imports on reload
 * instead of returning the cached module), validates the shape, and collects
 * failures rather than aborting — an iterating author gets the valid analyzers
 * plus a precise error for each bad one.
 *
 * Identity-on-edit: node identity (`computeInputKey`) folds in the graded version
 * and config fingerprint but not source text, so without help an edit to a custom
 * analyzer would not invalidate its prior nodes. The loader therefore stamps each
 * disk-loaded analyzer with a `contentHash` over its module text + prompt
 * contents; `AnalyzerFramework.resolve()` folds that into the config fingerprint.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { Check } from "typebox/value";
import type { Analyzer } from "./types.js";
import { AnalyzerDef, AnalyzerVersion } from "./types.js";
import { computeConfigHash, shortHash } from "./input-hash.js";

/** A validation/import failure tied to the file that produced it. */
export interface LoadError {
	path: string;
	message: string;
}

export interface LoadResult {
	loaded: Analyzer[];
	errors: LoadError[];
}

export interface LoadOptions {
	/** Files or directories to load from, in precedence order. */
	paths?: string[];
	/** Built-in analyzer ids a custom analyzer must not collide with. */
	builtinIds?: string[];
}

const ANALYZER_FILE_RE = /\.analyzer\.(ts|js|mjs)$/;

/** Inputs to {@link resolveAnalyzerPaths}; kept explicit so it is pure/testable. */
export interface ResolvePathsInput {
	explicit?: string[];
	config?: { analyzerPaths?: string[] };
	projectDir?: string;
	userDir?: string;
}

/**
 * Assemble the precedence-ordered path list: explicit flags → config
 * `analyzerPaths` → project dir → user (Pi agent) dir. Duplicates are dropped,
 * keeping the first (highest-precedence) occurrence.
 */
export function resolveAnalyzerPaths(input: ResolvePathsInput): string[] {
	const ordered = [
		...(input.explicit ?? []),
		...(input.config?.analyzerPaths ?? []),
		...(input.projectDir ? [input.projectDir] : []),
		...(input.userDir ? [input.userDir] : []),
	];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of ordered) {
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

/** Expand a path into the concrete analyzer files it contributes. */
function analyzerFilesFor(p: string): string[] {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(p);
	} catch {
		return []; // non-existent paths are ignored, not errors
	}
	if (stat.isFile()) return ANALYZER_FILE_RE.test(p) || /\.(ts|js|mjs)$/.test(p) ? [p] : [];
	if (!stat.isDirectory()) return [];
	return fs
		.readdirSync(p)
		.filter((name) => ANALYZER_FILE_RE.test(name))
		.map((name) => path.join(p, name))
		.sort();
}

/**
 * Load custom analyzers from the given paths. Never throws for a bad analyzer;
 * failures are returned in `errors`.
 */
export async function loadCustomAnalyzers(opts: LoadOptions): Promise<LoadResult> {
	const builtinIds = new Set(opts.builtinIds ?? []);
	const loaded: Analyzer[] = [];
	const errors: LoadError[] = [];
	const seenIds = new Map<string, string>(); // id → file that first claimed it

	// De-dup files (an explicit file may also live under a scanned dir).
	const files: string[] = [];
	const seenFiles = new Set<string>();
	for (const p of opts.paths ?? []) {
		for (const f of analyzerFilesFor(p)) {
			const abs = path.resolve(f);
			if (seenFiles.has(abs)) continue;
			seenFiles.add(abs);
			files.push(abs);
		}
	}

	for (const file of files) {
		let analyzer: Analyzer;
		try {
			analyzer = await importAnalyzer(file);
		} catch (err) {
			errors.push({ path: file, message: err instanceof Error ? err.message : String(err) });
			continue;
		}

		const validationError = validateAnalyzer(analyzer);
		if (validationError) {
			errors.push({ path: file, message: validationError });
			continue;
		}

		const id = analyzer.def.id;
		if (builtinIds.has(id)) {
			errors.push({ path: file, message: `analyzer id '${id}' collides with a built-in analyzer` });
			continue;
		}
		const prior = seenIds.get(id);
		if (prior) {
			errors.push({ path: file, message: `analyzer id '${id}' conflicts with the one already loaded from ${prior}` });
			continue;
		}
		seenIds.set(id, file);

		normalizeAndStamp(analyzer, file);
		loaded.push(analyzer);
	}

	return { loaded, errors };
}

/** Dynamically import an analyzer module with an mtime cache-busting query. */
async function importAnalyzer(file: string): Promise<Analyzer> {
	const mtime = fs.statSync(file).mtimeMs;
	const url = `${pathToFileURL(file).href}?v=${mtime}`;
	const mod = (await import(url)) as { default?: unknown; analyzer?: unknown };
	const candidate = (mod.default ?? mod.analyzer) as Analyzer | undefined;
	if (!candidate || typeof candidate !== "object") {
		throw new Error("module must default-export (or export `analyzer`) an Analyzer object");
	}
	return candidate;
}

/**
 * Structural validation with author-friendly messages. Returns an error string,
 * or null when the analyzer is well-formed. Runs before normalisation so a
 * missing `configHash` (which the loader fills) is not treated as a failure.
 */
export function validateAnalyzer(a: Analyzer): string | null {
	if (!a.def || typeof a.def !== "object") return "missing `def`";
	// Read id before the type-guard narrows a.def to `never` on the failure branch.
	const id = (a.def as { id?: unknown }).id;
	const idLabel = typeof id === "string" && id.length > 0 ? id : "?";
	if (!Check(AnalyzerDef, a.def)) return `invalid \`def\` (needs id, label, description, anchorSpan, dependencies[]) for '${idLabel}'`;
	if (!a.version || typeof a.version !== "object") return `missing \`version\` for '${a.def.id}'`;
	if (!Check(AnalyzerVersion, a.version)) return `invalid \`version\` (needs analyzerId, major, minor, implementationKind) for '${a.def.id}'`;
	if (a.version.analyzerId !== a.def.id) return `version.analyzerId '${a.version.analyzerId}' does not match def.id '${a.def.id}'`;
	if (typeof a.plan !== "function") return `analyzer '${a.def.id}' is missing a \`plan\` function`;
	if (typeof a.analyze !== "function") return `analyzer '${a.def.id}' is missing an \`analyze\` function`;
	if (!a.defaultConfig || typeof a.defaultConfig !== "object") return `analyzer '${a.def.id}' is missing \`defaultConfig\``;
	if (a.prompts && typeof a.prompts !== "object") return `analyzer '${a.def.id}' has an invalid \`prompts\` map`;
	return null;
}

/**
 * Fill loader-owned fields (config hash, prompt hashes) and stamp the identity
 * `contentHash` + `sourcePath`. Mutates the freshly-imported object in place.
 */
function normalizeAndStamp(a: Analyzer, file: string): void {
	if (!a.prompts) a.prompts = {};
	for (const [name, p] of Object.entries(a.prompts)) {
		if (!p.hash) p.hash = shortHash(`prompt(${name}:${p.content})`);
	}
	if (!a.defaultConfig.configHash) {
		a.defaultConfig.configHash = computeConfigHash(a.defaultConfig.configJson ?? {});
	}
	if (a.defaultConfig.analyzerId !== a.def.id) a.defaultConfig.analyzerId = a.def.id;

	const promptContents = Object.values(a.prompts)
		.map((p) => p.content)
		.join("\0");
	let source = "";
	try {
		source = fs.readFileSync(file, "utf-8");
	} catch {
		// If the file vanished between import and hash, fall back to the config
		// hash — still stable enough to distinguish this analyzer's identity.
		source = a.defaultConfig.configHash;
	}
	a.contentHash = shortHash(`analyzer-content(${source}\0${promptContents})`);
	a.sourcePath = file;
}
