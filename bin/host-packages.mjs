// Module resolve hook for the `prospect` executable.
//
// pi provides some packages to its extensions at runtime, and pi-prospector
// declares them as optional peers so pi doesn't load a second copy (#297).
// Under plain Node they may not be installed next to this package. When one
// can't be found, this hook resolves it again from the pi on PATH, the way
// pi's own extension loader would.

import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** Packages pi provides to extensions that this package imports by name. */
const HOST_PACKAGES = ["typebox"];

/** A file URL inside pi's package, used as the parent of the retried lookup. */
let piParent;

/** Called by `module.register` with `{ piRoot }`: pi's package directory, or undefined. */
export function initialize(data) {
	piParent = data?.piRoot ? pathToFileURL(path.join(data.piRoot, "package.json")).href : undefined;
}

export async function resolve(specifier, context, nextResolve) {
	try {
		return await nextResolve(specifier, context);
	} catch (err) {
		if (!piParent || err?.code !== "ERR_MODULE_NOT_FOUND" || !isHostPackage(specifier)) throw err;
		return nextResolve(specifier, { ...context, parentURL: piParent });
	}
}

export function isHostPackage(specifier) {
	return HOST_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}
