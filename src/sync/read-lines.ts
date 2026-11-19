/**
 * Read a session file as an array of lines, the same array `content.split("\n")`
 * gives: a file that ends with a newline has an empty last element.
 *
 * A file too large for one string (V8 stops near 512 MB, and two real transcripts
 * passed it) fails `readFile(..., "utf-8")` with "Invalid string length". Above
 * `MAX_WHOLE_READ_BYTES` the file is read as a stream and split as it arrives, so
 * no string holds more than one line. Multi-byte characters that straddle a chunk
 * boundary are decoded whole.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { SyncFault } from "./faults.js";

/** Files up to this size are read whole. */
export const MAX_WHOLE_READ_BYTES = 256 * 1024 * 1024;

/**
 * The longest single line the streaming reader accepts, in characters. A line is one
 * string, and V8 stops near 512 MB, so a longer line cannot be held at all. That file
 * ends as a `line-too-large` fault instead of overflowing partway.
 */
export const MAX_LINE_CHARS = 256 * 1024 * 1024;

let wholeReadLimit = MAX_WHOLE_READ_BYTES;
let chunkBytes = 64 * 1024;
let maxLineChars = MAX_LINE_CHARS;

/** Lower the limits for a test, so a small file exercises the streaming path. Pass null to restore them. */
export function setReadLimitsForTests(limits: { wholeReadBytes: number; chunkBytes: number; maxLineChars?: number } | null): void {
	wholeReadLimit = limits?.wholeReadBytes ?? MAX_WHOLE_READ_BYTES;
	chunkBytes = limits?.chunkBytes ?? 64 * 1024;
	maxLineChars = limits?.maxLineChars ?? MAX_LINE_CHARS;
}

/** The line limit in force: the default, or the one a test lowered. */
export function currentMaxLineChars(): number {
	return maxLineChars;
}

export async function readSessionLines(filePath: string): Promise<string[]> {
	const { size } = await fsp.stat(filePath);
	if (size <= wholeReadLimit) return (await fsp.readFile(filePath, "utf-8")).split("\n");
	return streamLines(filePath);
}

function streamLines(filePath: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const lines: string[] = [];
		const decoder = new StringDecoder("utf8");
		const limit = maxLineChars;
		let partial = "";
		let failed = false;
		const stream = fs.createReadStream(filePath, { highWaterMark: chunkBytes });
		const fail = (err: Error): void => {
			if (failed) return;
			failed = true;
			stream.destroy();
			reject(err);
		};
		const tooLarge = (): void => fail(new SyncFault("line-too-large", `A line in ${filePath} is longer than ${limit} characters`));
		const take = (text: string): void => {
			const parts = text.split("\n");
			// Checked before joining, so no string ever grows past the limit.
			if (partial.length + (parts[0]?.length ?? 0) > limit) return tooLarge();
			parts[0] = partial + parts[0];
			partial = parts.pop() ?? "";
			if (partial.length > limit) return tooLarge();
			for (const p of parts) lines.push(p);
		};
		stream.on("data", (chunk) => {
			if (!failed) take(decoder.write(chunk as Buffer));
		});
		stream.on("error", fail);
		stream.on("end", () => {
			if (failed) return;
			take(decoder.end());
			if (failed) return;
			lines.push(partial);
			resolve(lines);
		});
	});
}
