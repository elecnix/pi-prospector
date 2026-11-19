import { SyncFault } from "./faults.js";
import { lineBatches } from "./line-batches.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseLine } from "./parser.js";
import type { ForkInfo } from "../types.js";

/**
 * Resolve fork info for a session with a parentSession header.
 * Returns null if the parent file doesn't exist.
 */
export async function resolveFork(parentSession: string, sessionsDir: string): Promise<ForkInfo | null> {
	const parentPath = path.isAbsolute(parentSession)
		? parentSession
		: path.resolve(sessionsDir, parentSession);

	try {
		await fs.access(parentPath);
	} catch {
		return null;
	}

	// Read the parent's header to get the parent session ID
	let parentId = "";
	try {
		let firstLine: string | undefined;
		for await (const batch of lineBatches(parentPath)) {
			firstLine = batch.lines[0]?.trim();
			break;
		}
		if (!firstLine) return null;
		const parsed = parseLine(firstLine);
		if (!parsed || parsed.kind !== "session") return null;
		parentId = parsed.header.id;
	} catch {
		return null;
	}

	// Count lines in parent (branch point is the end of parent)
	// Counted as the parent streams past, so a huge parent is never held in memory.
	// A fault here (a line past the limit) is the parent's, but it ends the child's read, so the
	// message says whose it is. The class stays, so the summary counts it under its own name.
	let branchLine = 0;
	try {
		for await (const batch of lineBatches(parentPath)) for (const l of batch.lines) if (l.trim()) branchLine++;
	} catch (err) {
		if (err instanceof SyncFault) throw new SyncFault(err.faultClass, `Cannot count the lines of the parent session ${path.basename(parentPath)}: ${err.message}`);
		throw err;
	}

	return {
		parentSessionId: parentId,
		parentFilePath: parentPath,
		branchLine,
	};
}