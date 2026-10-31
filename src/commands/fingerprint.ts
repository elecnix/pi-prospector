import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "../pi-stubs.js";
import { getDbPath } from "../config.js";
import { BUILTIN_ANALYZERS } from "../analyze/defaults.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { buildFingerprint, parseFingerprintArgs } from "../fingerprint/build.js";
import { collectContributors } from "../fingerprint/registry.js";
import { resolveRenderer } from "../fingerprint/renderers.js";

/**
 * `/prospect-fingerprint [--source a,b] [--from DAY] [--to DAY] [--as-of DAY] [--format ID] [--out FILE]`:
 * print a shareable fingerprint of the indexed sessions.
 *
 * The fingerprint is a read of the session index and the analysis graph. It
 * writes no node, run, or edge, and it never runs analysis: a section whose
 * analyzer has not run on enough sessions is withheld, not computed. Its
 * sections come from the built-in analyzers' contributors; its formats from the
 * renderer table.
 */

/** Parse the flags, build the fingerprint on an open database, and render it. */
export async function renderFingerprint(db: AsyncDatabase, flags: string): Promise<{ text: string; fingerprint: Awaited<ReturnType<typeof buildFingerprint>>; out?: string }> {
	const request = parseFingerprintArgs(flags, new Date());
	const renderer = resolveRenderer(request.format);
	const fingerprint = await buildFingerprint(db, request, collectContributors(BUILTIN_ANALYZERS));
	return { text: renderer.render(fingerprint), fingerprint, out: request.out };
}

export async function prospectFingerprint(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = openAsyncDatabase(getDbPath());
	try {
		await migrate(db);
		const { text, out } = await renderFingerprint(db, args);
		if (out === undefined) {
			console.log(text.trimEnd());
			return;
		}
		const file = path.resolve(ctx.cwd ?? process.cwd(), out);
		fs.writeFileSync(file, text);
		ctx.ui.notify(`Fingerprint written to ${file}`, "info");
	} catch (err) {
		ctx.ui.notify(`prospect fingerprint: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		await db.close();
	}
}
