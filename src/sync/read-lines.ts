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

/** Files up to this size are read whole. */
export const MAX_WHOLE_READ_BYTES = 256 * 1024 * 1024;

let wholeReadLimit = MAX_WHOLE_READ_BYTES;
let chunkBytes = 64 * 1024;

/** Lower the limits for a test, so a small file exercises the streaming path. Pass null to restore them. */
export function setReadLimitsForTests(limits: { wholeReadBytes: number; chunkBytes: number } | null): void {
	wholeReadLimit = limits?.wholeReadBytes ?? MAX_WHOLE_READ_BYTES;
	chunkBytes = limits?.chunkBytes ?? 64 * 1024;
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
		let partial = "";
		const take = (text: string): void => {
			const parts = text.split("\n");
			parts[0] = partial + parts[0];
			partial = parts.pop() ?? "";
			for (const p of parts) lines.push(p);
		};
		const stream = fs.createReadStream(filePath, { highWaterMark: chunkBytes });
		stream.on("data", (chunk) => take(decoder.write(chunk as Buffer)));
		stream.on("error", reject);
		stream.on("end", () => {
			take(decoder.end());
			lines.push(partial);
			resolve(lines);
		});
	});
}
