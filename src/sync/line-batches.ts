/**
 * Read a session file as batches of lines, so no more than one batch is in memory.
 *
 * `readSessionLines` returns every line of a file, which is fine for a transcript of a
 * few megabytes and fatal for one of tens of gigabytes. This reader streams the file,
 * splits it as `content.split("\n")` would, and yields a batch when it holds
 * `maxLines` lines or `maxBytes` bytes. The last batch is flagged; it ends with the
 * file's final element, which is "" after a trailing newline. A batch is yielded only
 * once the next one starts or the file ends, so a consumer always knows which is last.
 *
 * A single line past `maxLineChars` cannot be held, so that file fails with the class
 * `line-too-large` (the same class a whole-file read gives).
 */
import * as fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { SyncFault } from "./faults.js";

export interface LineBatch {
	/** Index in the file of this batch's first line. */
	start: number;
	lines: string[];
	last: boolean;
}

export interface BatchLimits {
	maxLines: number;
	maxBytes: number;
	/** Largest single line, in characters. */
	maxLineChars: number;
	chunkBytes: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = { maxLines: 5_000, maxBytes: 16 * 1024 * 1024, maxLineChars: 256 * 1024 * 1024, chunkBytes: 1024 * 1024 };

let limits: BatchLimits = DEFAULT_BATCH_LIMITS;

/** Lower the limits for a test. Pass null to restore the defaults. */
export function setBatchLimitsForTests(next: Partial<BatchLimits> | null): void {
	limits = next ? { ...DEFAULT_BATCH_LIMITS, ...next } : DEFAULT_BATCH_LIMITS;
}

export function currentBatchLimits(): BatchLimits {
	return limits;
}

export async function* lineBatches(filePath: string, use: BatchLimits = limits): AsyncGenerator<LineBatch> {
	const decoder = new StringDecoder("utf8");
	const stream = fs.createReadStream(filePath, { highWaterMark: use.chunkBytes });
	let partial = "";
	let index = 0;
	let held: LineBatch | null = null;
	let current: string[] = [];
	let currentBytes = 0;
	let currentStart = 0;
	const tooLarge = (): never => {
		throw new SyncFault("line-too-large", `A line in ${filePath} is longer than ${use.maxLineChars} characters`);
	};
	try {
		for await (const chunk of stream) {
			const parts = decoder.write(chunk as Buffer).split("\n");
			if (partial.length + (parts[0]?.length ?? 0) > use.maxLineChars) tooLarge();
			parts[0] = partial + parts[0];
			partial = parts.pop() ?? "";
			if (partial.length > use.maxLineChars) tooLarge();
			for (const line of parts) {
				current.push(line);
				currentBytes += line.length + 1;
				index++;
				if (current.length >= use.maxLines || currentBytes >= use.maxBytes) {
					if (held) yield held;
					held = { start: currentStart, lines: current, last: false };
					current = [];
					currentBytes = 0;
					currentStart = index;
				}
			}
		}
		const tail = decoder.end();
		if (partial.length + tail.length > use.maxLineChars) tooLarge();
		current.push(partial + tail);
		if (held) yield held;
		yield { start: currentStart, lines: current, last: true };
	} finally {
		stream.destroy();
	}
}

/** The first `n` non-empty lines of a file, without reading the rest. */
export async function firstLines(filePath: string, n: number): Promise<string[]> {
	const out: string[] = [];
	for await (const batch of lineBatches(filePath, { ...limits, maxLines: n * 4, maxBytes: 1024 * 1024 })) {
		for (const l of batch.lines) if (l.trim() && out.length < n) out.push(l);
		if (out.length >= n || batch.last) break;
	}
	return out;
}
