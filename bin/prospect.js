#!/usr/bin/env node
// The `prospect` executable. The sources are TypeScript, so tsx compiles them on load.
import { register as registerHook } from "node:module";
import { register } from "tsx/esm/api";

register();
// Packages pi provides, like typebox, come from the pi on PATH when they aren't
// installed here. Registered after tsx, so this hook runs first and falls back
// to pi only when tsx's resolution fails. The hook is only a fallback: if
// setting it up fails, commands still run with whatever is installed here.
try {
	const { findPiPackageRoot } = await import("../src/pi-host.ts");
	registerHook("./host-packages.mjs", import.meta.url, { data: { piRoot: findPiPackageRoot(process.env.PATH ?? "") } });
} catch (err) {
	console.error(`prospect: couldn't set up loading packages from pi (${err instanceof Error ? err.message : String(err)}); continuing without it.`);
}
const { main } = await import("../src/cli.ts");
const code = await main(process.argv.slice(2));
// Exit once stdout is flushed, even if a model client left a connection open.
process.stdout.write("", () => process.exit(code));
