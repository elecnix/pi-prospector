/**
 * Custom-session-source loader — discovery + dynamic import + validation.
 *
 * The composition root resolves a custom source by name: config `sources` may
 * name one beside the built-in keys, and a matching directory holding
 * `index.{ts,js,mjs}` under a discovery path supplies the adapter. Because the
 * extension runs under `tsx`, a custom source can be plain `.ts`; `.js`/`.mjs`
 * work too.
 *
 * Discovery resolves a precedence-ordered list of directories — the user (Pi
 * agent) sources dir, a project-local dir, and any extra paths config or tests
 * supply — and looks up exactly `<dir>/index.{ts,js,mjs}`. Directories are not
 * scanned for anything else: a helper file next to `index.ts` is never
 * imported as a source, because only the composition root names sources, and
 * it names one per directory.
 *
 * Failures are collected, never thrown — an iterating author gets the sources
 * that loaded plus a precise error for each bad one, the same contract the
 * custom-analyzer loader keeps (`src/analyze/loader.ts`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as os from "node:os";
import type { SessionSourceAdapter } from "./adapter.js";

/** A load failure tied to the name (and, when known, the file) that produced it. */
export interface SourceLoadError {
	name: string;
	file?: string;
	message: string;
}

export interface SourceLoadResult {
	loaded: SessionSourceAdapter[];
	errors: SourceLoadError[];
}

export interface SourceLoadOptions {
	/** Source names to resolve, in config order. */
	names: string[];
	/** Directories to search for `<name>/index.{ts,js,mjs}`, in precedence order. */
	paths: string[];
	/** Built-in source tags a custom source must not claim. */
	builtinIds?: string[];
}

/** File names a source directory may carry, tried in order. */
const SOURCE_FILE_NAMES = ["index.ts", "index.js", "index.mjs"] as const;

/** Inputs to {@link resolveSourcePaths}; kept explicit so it is pure/testable. */
export interface ResolveSourcePathsInput {
	/** Config `sourcePaths` (or any caller-supplied list), highest precedence. A leading ~ is expanded. */
	config?: { sourcePaths?: string[] };
	/** Project-local convention dir, when it exists. */
	projectDir?: string;
	/** User-level convention dir, when it exists. */
	userDir?: string;
}

/**
 * Assemble the precedence-ordered directory list: config paths → project dir →
 * user dir. Duplicates are dropped, keeping the first (highest-precedence)
 * occurrence.
 */
export function resolveSourcePaths(input: ResolveSourcePathsInput): string[] {
	const expanded = (input.config?.sourcePaths ?? []).map((p) => p.replace(/^~/, os.homedir()));
	const ordered = [...expanded, ...(input.projectDir ? [input.projectDir] : []), ...(input.userDir ? [input.userDir] : [])];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of ordered) {
		if (seen.has(p)) continue;
		seen.add(p);
		out.push(p);
	}
	return out;
}

/**
 * Load the named custom sources from the given directories. Never throws for a
 * bad source; failures are returned in `errors`.
 */
export async function loadCustomSources(opts: SourceLoadOptions): Promise<SourceLoadResult> {
	const builtinIds = new Set(opts.builtinIds ?? []);
	const loaded: SessionSourceAdapter[] = [];
	const errors: SourceLoadError[] = [];
	const claimedTags = new Map<string, string>(); // tag → name that first claimed it

	for (const name of opts.names) {
		const file = findSourceFile(opts.paths, name);
		if (!file) {
			errors.push({ name, message: `no source named '${name}' under ${opts.paths.join(", ")}` });
			continue;
		}

		let adapter: SessionSourceAdapter;
		try {
			adapter = await importSource(file);
		} catch (err) {
			errors.push({ name, file, message: err instanceof Error ? err.message : String(err) });
			continue;
		}

		const validationError = validateSource(adapter);
		if (validationError) {
			errors.push({ name, file, message: `source '${adapter.source ?? name}': ${validationError}` });
			continue;
		}

		if (builtinIds.has(adapter.source)) {
			errors.push({ name, file, message: `source tag '${adapter.source}' collides with a built-in source` });
			continue;
		}
		const prior = claimedTags.get(adapter.source);
		if (prior) {
			errors.push({ name, file, message: `source tag '${adapter.source}' conflicts with the one already loaded for '${prior}'` });
			continue;
		}
		claimedTags.set(adapter.source, name);
		loaded.push(adapter);
	}

	return { loaded, errors };
}

/** The first `<paths[i]>/<name>/index.{ts,js,mjs}` that exists, or undefined. */
function findSourceFile(paths: string[], name: string): string | undefined {
	for (const dir of paths) {
		for (const fileName of SOURCE_FILE_NAMES) {
			const candidate = path.join(dir, name, fileName);
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// not there; keep looking
			}
		}
	}
	return undefined;
}

/**
 * Dynamically import a source module with an mtime cache-busting query.
 *
 * The documented export is a class (the README's example) or a ready adapter
 * object; both load. A class is instantiated with no arguments — a source that
 * needs settings resolves them itself, the way the analyzer loader's modules do.
 */
async function importSource(file: string): Promise<SessionSourceAdapter> {
	const mtime = fs.statSync(file).mtimeMs;
	const url = `${pathToFileURL(file).href}?v=${mtime}`;
	const mod = (await import(url)) as { default?: unknown };
	const candidate = mod.default;
	if (typeof candidate === "function") {
		const Ctor = candidate as new () => SessionSourceAdapter;
		return new Ctor();
	}
	if (!candidate || typeof candidate !== "object") {
		throw new Error("module must default-export a session source (a class or an adapter object with discover and read)");
	}
	return candidate as SessionSourceAdapter;
}

/** Structural validation with author-friendly messages. */
function validateSource(a: SessionSourceAdapter): string | null {
	if (typeof a.source !== "string" || a.source.length === 0) return "missing or empty `source` tag";
	if (typeof a.discover !== "function") return "missing a `discover` function";
	if (typeof a.read !== "function") return "missing a `read` function";
	return null;
}
