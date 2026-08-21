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
		const content = await fs.readFile(parentPath, "utf-8");
		const firstLine = content.split("\n")[0]?.trim();
		if (!firstLine) return null;
		const parsed = parseLine(firstLine);
		if (!parsed || parsed.kind !== "session") return null;
		parentId = parsed.header.id;
	} catch {
		return null;
	}

	// Count lines in parent (branch point is the end of parent)
	const parentContent = await fs.readFile(parentPath, "utf-8");
	const branchLine = parentContent.split("\n").filter((l) => l.trim()).length;

	return {
		parentSessionId: parentId,
		parentFilePath: parentPath,
		branchLine,
	};
}