import * as fs from "node:fs";
import * as path from "node:path";
import { parseLine } from "./parser.js";
import type { ForkInfo } from "../types.js";

/**
 * Resolve fork info for a session with a parentSession header.
 * Returns null if the parent file doesn't exist.
 */
export function resolveFork(parentSession: string, sessionsDir: string): ForkInfo | null {
	const parentPath = path.isAbsolute(parentSession)
		? parentSession
		: path.resolve(sessionsDir, parentSession);

	if (!fs.existsSync(parentPath)) return null;

	// Read the parent's header to get the parent session ID
	let parentId = "";
	try {
		const content = fs.readFileSync(parentPath, "utf-8");
		const firstLine = content.split("\n")[0]?.trim();
		if (!firstLine) return null;
		const parsed = parseLine(firstLine);
		if (!parsed || parsed.kind !== "session") return null;
		parentId = parsed.header.id;
	} catch {
		return null;
	}

	// Count lines in parent (branch point is the end of parent)
	const parentContent = fs.readFileSync(parentPath, "utf-8");
	const branchLine = parentContent.split("\n").filter((l) => l.trim()).length;

	return {
		parentSessionId: parentId,
		parentFilePath: parentPath,
		branchLine,
	};
}