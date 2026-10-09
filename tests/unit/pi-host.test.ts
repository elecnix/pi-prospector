import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findPiPackageRoot, importPiPackage, resolvePiPackageEntry } from "../../src/pi-host.js";

/**
 * A fake pi install laid out the way npm installs pi globally: the `pi`
 * executable is a symlink into the package, and pi-ai sits in the package's own
 * node_modules.
 */
let tmpDir: string;
let binDir: string;
let piRoot: string;

function writePackage(dir: string, manifest: Record<string, unknown>, files: Record<string, string>): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest));
	for (const [file, body] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), body);
	}
}

before(() => {
	tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "prospector-pi-host-")));
	piRoot = path.join(tmpDir, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
	writePackage(
		piRoot,
		{ name: "@earendil-works/pi-coding-agent", exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } } },
		{ "dist/index.js": "export const which = 'agent';\n", "dist/bundle/cli.js": "" },
	);
	writePackage(
		path.join(piRoot, "node_modules", "@earendil-works", "pi-ai"),
		{ name: "@earendil-works/pi-ai", exports: { ".": { import: "./dist/index.js" } } },
		{ "dist/index.js": "export const which = 'ai';\n" },
	);
	binDir = path.join(tmpDir, "bin");
	fs.mkdirSync(binDir);
	fs.symlinkSync(path.join(piRoot, "dist", "bundle", "cli.js"), path.join(binDir, "pi"));
});

after(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pi-host", () => {
	it("finds pi's package directory from the executable on PATH", () => {
		const pathEnv = [path.join(tmpDir, "empty"), binDir].join(path.delimiter);
		assert.equal(findPiPackageRoot(pathEnv), piRoot);
	});

	it("finds nothing when PATH has no pi", () => {
		assert.equal(findPiPackageRoot(path.join(tmpDir, "empty")), undefined);
	});

	it("resolves pi's own entry and its pi-ai dependency through their exports", () => {
		assert.equal(resolvePiPackageEntry("@earendil-works/pi-coding-agent", piRoot), path.join(piRoot, "dist", "index.js"));
		assert.equal(
			resolvePiPackageEntry("@earendil-works/pi-ai", piRoot),
			path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
		);
		assert.equal(resolvePiPackageEntry("@earendil-works/pi-missing", piRoot), undefined);
	});

	it("imports a package pi provides when normal resolution cannot find it", async () => {
		const module = await importPiPackage<{ which: string }>("@earendil-works/pi-ai", binDir);
		assert.equal(module.which, "ai");
	});

	it("says how to fix it when no pi is on PATH", async () => {
		await assert.rejects(importPiPackage("@earendil-works/pi-ai", path.join(tmpDir, "empty")), /no pi executable is on PATH/);
	});
});
