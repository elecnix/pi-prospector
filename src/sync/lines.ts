/**
 * How many lines of a session file the cursor should advance past.
 *
 * The cursor is the index of the first line not yet processed. A session file
 * ends with a newline, so `content.split("\n")` leaves an empty last element that
 * holds no record. Counting it puts the cursor one line past the last record, and
 * the first line the host appends lands on that index and is skipped for good.
 *
 * The count is the split length, less the empty last element when the file ends
 * with a newline, and zero for an empty file. Codex has the same rule in `codexProcessedCount`.
 */
export function processedLineCount(content: string, splitLength: number): number {
	// An empty file splits into one empty element and holds no line.
	if (content === "") return 0;
	return content.endsWith("\n") ? Math.max(0, splitLength - 1) : splitLength;
}
