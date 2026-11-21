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
import { compareFingerprints, parseCompareArgs, parseFingerprintText, resolveCompareRenderer } from "../fingerprint/compare.js";

/**
 * `/prospect-fingerprint [--source a,b] [--from DAY] [--to DAY] [--as-of DAY] [--format ID] [--out FILE]`:
 * print a shareable fingerprint of the indexed sessions.
 *
 * The fingerprint is a read of the session index and the analysis graph. It
 * writes no node, run, or edge, and it never runs analysis: a section whose
 * analyzer has not run on enough sessions is withheld, not computed. Its
 * sections come from the built-in analyzers' contributors; its formats from the
 * renderer table.
 *
 * `/prospect-fingerprint compare A.json B.json [--labels a,b] [--format text|markdown] [--out FILE]`:
 * print two fingerprint files side by side, with rates and shares in place of
 * counts. It reads only the two files; it opens no database.
 */

/** Read two fingerprint files, relative to `cwd`, and render their comparison. */
export function renderComparison(flags: string, cwd: string): { text: string; out?: string } {
	const request = parseCompareArgs(flags);
	const renderer = resolveCompareRenderer(request.format);
	const [a, b] = request.files.map((file) => {
		const resolved = path.resolve(cwd, file);
		if (!fs.existsSync(resolved)) throw new Error(`${file} does not exist`);
		return parseFingerprintText(fs.readFileSync(resolved, "utf8"), file);
	});
	const comparison = compareFingerprints(
		{ label: request.labels[0], fingerprint: a! },
		{ label: request.labels[1], fingerprint: b! },
		collectContributors(BUILTIN_ANALYZERS),
	);
	return { text: renderer.render(comparison), out: request.out };
}

/** Parse the flags, build the fingerprint on an open database, and render it. */
export async function renderFingerprint(db: AsyncDatabase, flags: string): Promise<{ text: string; fingerprint: Awaited<ReturnType<typeof buildFingerprint>>; out?: string }> {
	const request = parseFingerprintArgs(flags, new Date());
	const renderer = resolveRenderer(request.format);
	const fingerprint = await buildFingerprint(db, request, collectContributors(BUILTIN_ANALYZERS));
	return { text: renderer.render(fingerprint), fingerprint, out: request.out };
}

function emit(text: string, out: string | undefined, ctx: ExtensionCommandContext, what: string): void {
	if (out === undefined) {
		console.log(text.trimEnd());
		return;
	}
	const file = path.resolve(ctx.cwd ?? process.cwd(), out);
	fs.writeFileSync(file, text);
	ctx.ui.notify(`${what} written to ${file}`, "info");
}

export async function prospectFingerprint(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const [sub, ...rest] = (args ?? "").trim().split(/\s+/);
	if (sub === "compare") {
		try {
			const { text, out } = renderComparison(rest.join(" "), ctx.cwd ?? process.cwd());
			emit(text, out, ctx, "Comparison");
		} catch (err) {
			ctx.ui.notify(`prospect fingerprint: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
		return;
	}
	const db = openAsyncDatabase(getDbPath());
	try {
		await migrate(db);
		const { text, out } = await renderFingerprint(db, args);
		emit(text, out, ctx, "Fingerprint");
	} catch (err) {
		ctx.ui.notify(`prospect fingerprint: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		await db.close();
	}
}
