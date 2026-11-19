/**
 * Recognise a transcript that `prospect export-session` (or the restore tool before
 * it) wrote, so the sync never treats a rebuild as an original.
 *
 * The marker is documented once: every record an export writes carries a top-level
 * `restoredFrom` field, and a `<name>.restore.json` report sits beside the file. Either
 * one marks the file. A real transcript has neither: the field is checked on the first
 * few records' top-level keys only, so a transcript that mentions the word in its text
 * is not mistaken for a rebuild.
 */
import * as fs from "node:fs/promises";

/** The value the export writes in `restoredFrom`. */
export const RESTORED_FROM = "pi-prospector";

/** How many leading records are checked for the field. */
const LEADING_RECORDS = 5;

export async function isRebuiltTranscript(filePath: string, lines: readonly string[]): Promise<boolean> {
	let seen = 0;
	for (const line of lines) {
		const text = line.trim();
		if (!text) continue;
		if (seen++ >= LEADING_RECORDS) break;
		if (!text.includes('"restoredFrom"')) continue;
		try {
			const obj: unknown = JSON.parse(text);
			if (obj !== null && typeof obj === "object" && typeof (obj as Record<string, unknown>)["restoredFrom"] === "string") return true;
		} catch {
			/* not a record */
		}
	}
	const stem = filePath.replace(/\.jsonl$/i, "");
	for (const report of new Set([`${stem}.restore.json`, `${filePath}.restore.json`])) {
		try {
			await fs.access(report);
			return true;
		} catch {
			/* no report there */
		}
	}
	return false;
}
