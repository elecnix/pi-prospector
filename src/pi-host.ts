import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Loads pi's own packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`)
 * for code that may run outside pi.
 *
 * Inside pi, the extension loader resolves these packages, so a plain dynamic
 * import works. The standalone `prospect` command runs under plain Node, where
 * they are not installed next to this package: they are optional peers. It then
 * borrows them from the pi installed on PATH, which is where pi keeps the model
 * catalogue and the credentials an LLM analyzer needs.
 */

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/**
 * Import one of pi's packages: from the normal module resolution first, then from
 * the pi found on `pathEnv`. Throws with a message that says how to fix it when
 * neither has the package.
 */
export async function importPiPackage<T>(name: string, pathEnv = process.env["PATH"] ?? ""): Promise<T> {
	try {
		return (await import(name)) as T;
	} catch (err) {
		if (!isModuleNotFound(err)) throw err;
	}
	const piRoot = findPiPackageRoot(pathEnv);
	if (!piRoot) {
		throw new Error(`${name} is not installed, and no pi executable is on PATH. Install pi, or run this command inside pi.`);
	}
	const entry = resolvePiPackageEntry(name, piRoot);
	if (!entry) throw new Error(`The pi installed at ${piRoot} does not include ${name}.`);
	return (await import(pathToFileURL(entry).href)) as T;
}

/**
 * The directory of the pi package behind the first `pi` executable on `pathEnv`,
 * found by following the executable's symlink up to a `package.json` that names
 * pi. Undefined when PATH has no pi.
 */
export function findPiPackageRoot(pathEnv: string): string | undefined {
	for (const dir of pathEnv.split(path.delimiter)) {
		if (dir === "") continue;
		const executable = path.join(dir, "pi");
		if (!fs.existsSync(executable)) continue;
		let current = path.dirname(fs.realpathSync(executable));
		while (current !== path.dirname(current)) {
			if (readPackageName(current) === PI_PACKAGE) return current;
			current = path.dirname(current);
		}
	}
	return undefined;
}

/**
 * The ESM entry file of package `name` as pi itself resolves it: pi's own
 * directory for pi, otherwise the nearest `node_modules/<name>` from pi's
 * directory upward.
 */
export function resolvePiPackageEntry(name: string, piRoot: string): string | undefined {
	let packageDir: string | undefined;
	if (readPackageName(piRoot) === name) {
		packageDir = piRoot;
	} else {
		for (let current = piRoot; current !== path.dirname(current); current = path.dirname(current)) {
			const candidate = path.join(current, "node_modules", name);
			if (fs.existsSync(path.join(candidate, "package.json"))) {
				packageDir = candidate;
				break;
			}
		}
	}
	if (!packageDir) return undefined;
	const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf-8")) as {
		exports?: unknown;
		main?: string;
	};
	const entry = exportedEntry(manifest.exports) ?? manifest.main ?? "index.js";
	return path.join(packageDir, entry);
}

/** The `import` (or `default`) target of a package's `.` export. */
function exportedEntry(exports: unknown): string | undefined {
	if (typeof exports === "string") return exports;
	if (exports === null || typeof exports !== "object") return undefined;
	const root = (exports as Record<string, unknown>)["."] ?? exports;
	if (typeof root === "string") return root;
	if (root === null || typeof root !== "object") return undefined;
	const conditions = root as Record<string, unknown>;
	for (const condition of ["import", "default"]) {
		const target = conditions[condition];
		if (typeof target === "string") return target;
	}
	return undefined;
}

function readPackageName(dir: string): string | undefined {
	try {
		const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8")) as { name?: unknown };
		return typeof manifest.name === "string" ? manifest.name : undefined;
	} catch {
		return undefined;
	}
}

function isModuleNotFound(err: unknown): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND";
}
