/**
 * How many lines of a session file the cursor should advance past, given the file
 * split on "\n".
 *
 * The cursor is the index of the first line not yet processed. A session file ends
 * with a newline, so the split ends with an empty element that holds no record.
 * Counting it puts the cursor one line past the last record, and the first line the
 * host appends lands on that index and is skipped for good. An empty file splits into
 * one empty element and holds no line.
 */
export function processedLineCount(lines: readonly string[]): number {
	if (lines.length === 0) return 0;
	return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}
