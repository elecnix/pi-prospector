import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionCommandContext } from "../pi-stubs.js";
import { getDbPath } from "../config.js";
import { openAsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { buildFingerprint, parseFingerprintArgs } from "../fingerprint/build.js";

/**
 * `/prospect-fingerprint [--source a,b] [--from DAY] [--to DAY] [--as-of DAY] [--out FILE]`:
 * print a shareable fingerprint of the indexed sessions as JSON.
 *
 * The fingerprint is a read of the session index and the analysis graph. It
 * writes no node, run, or edge, and it never runs analysis: a section whose
 * analyzer has not run on enough sessions is withheld, not computed.
 */
export async function prospectFingerprint(args: string, ctx: ExtensionCommandContext): Promise<void> {
	let request;
	try {
		request = parseFingerprintArgs(args, new Date());
	} catch (err) {
		ctx.ui.notify(`prospect fingerprint: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	const db = openAsyncDatabase(getDbPath());
	try {
		await migrate(db);
		const json = JSON.stringify(await buildFingerprint(db, request), null, 2) + "\n";
		if (request.out === undefined) {
			console.log(json.trimEnd());
			return;
		}
		const file = path.resolve(ctx.cwd ?? process.cwd(), request.out);
		fs.writeFileSync(file, json);
		ctx.ui.notify(`Fingerprint written to ${file}`, "info");
	} finally {
		await db.close();
	}
}
