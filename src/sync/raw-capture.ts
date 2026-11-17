/**
 * Lossless capture of a session's source file (#400).
 *
 * The sync keeps a reduced projection of each message, so a transcript the host
 * later deletes cannot be rebuilt from it. This module keeps the original bytes
 * instead: one compressed chunk per sync, holding only the bytes the file gained
 * since the last one, so a growing transcript costs its growth and an unchanged
 * file costs nothing.
 *
 * Chunks are byte ranges, not line ranges. A host may be mid-write when sync
 * reads the file, and a half-written last line must not be lost or doubled: the
 * next chunk continues at the byte where the last one stopped, and the chunks
 * joined in order are the file. The line number of a chunk's first line is stored
 * beside it so a line is addressable without decompressing every chunk.
 */
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as zlib from "node:zlib";

/** What is already stored for one session, read before the file is. */
export interface RawState {
	/** Bytes of the file already stored. */
	bytes: number;
	/** Newline characters in those bytes: the line number the next chunk starts at. */
	lines: number;
	/** SHA-256 of the first `bytes` bytes, or null when nothing is stored. */
	prefixSha256: string | null;
	/** SHA-256 of each stored sidecar file, by path relative to the sessions root. */
	sidecars: Record<string, string>;
}

/** The empty state of a session with nothing stored. */
export const NO_RAW: RawState = { bytes: 0, lines: 0, prefixSha256: null, sidecars: {} };

/** One compressed range of a session file, ready for `insertRawChunk()`. */
export interface RawChunk {
	byteStart: number;
	rawBytes: number;
	lineStart: number;
	lineCount: number;
	/** SHA-256 of the file's first `byteStart + rawBytes` bytes. */
	prefixSha256: string;
	codec: string;
	data: Buffer;
}

/** A small file stored whole beside a transcript, ready for `upsertRawFile()`. */
export interface RawFile {
	relPath: string;
	sha256: string;
	codec: string;
	rawBytes: number;
	data: Buffer;
}

/** Everything one source captured for one session on one sync. */
export interface RawCapture {
	sessionId: string;
	/** The transcript's path relative to the sessions root, where an export writes it back. */
	relPath: string;
	chunk: RawChunk | null;
	files: RawFile[];
	/** Set when the stored bytes are no longer a prefix of the file, so nothing was captured. */
	conflict?: string;
}

/** The codec every chunk carries today. Stored per row so a later change reads old rows. */
export const CODEC_BROTLI = "br";

/** Brotli quality 6: about 4x faster than 9 on JSONL and within a few percent of its size. */
const BROTLI_QUALITY = 6;

export function sha256(data: Uint8Array): string {
	return crypto.createHash("sha256").update(data).digest("hex");
}

export function compress(data: Uint8Array): Buffer {
	return zlib.brotliCompressSync(data, {
		params: {
			[zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
			[zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
			[zlib.constants.BROTLI_PARAM_LGWIN]: 24,
		},
	});
}

export function decompress(codec: string, data: Uint8Array): Buffer {
	if (codec !== CODEC_BROTLI) throw new Error(`unknown raw codec "${codec}"`);
	return zlib.brotliDecompressSync(data);
}

/** The number of newline bytes in `data`. */
export function countNewlines(data: Uint8Array): number {
	let n = 0;
	let i = -1;
	const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	while ((i = buf.indexOf(0x0a, i + 1)) !== -1) n++;
	return n;
}

/**
 * The chunk that extends what is stored to the whole of `content`, or the reason
 * it cannot. `content` is the file as it is now.
 */
export function nextChunk(content: Buffer, state: RawState): { chunk: RawChunk | null; conflict?: string } {
	if (content.length < state.bytes) {
		return { chunk: null, conflict: `file shrank from ${state.bytes} to ${content.length} bytes` };
	}
	if (state.bytes > 0 && sha256(content.subarray(0, state.bytes)) !== state.prefixSha256) {
		return { chunk: null, conflict: "file no longer starts with the stored bytes" };
	}
	if (content.length === state.bytes) return { chunk: null };
	const added = content.subarray(state.bytes);
	return {
		chunk: {
			byteStart: state.bytes,
			rawBytes: added.length,
			lineStart: state.lines,
			lineCount: countNewlines(added),
			prefixSha256: sha256(content),
			codec: CODEC_BROTLI,
			data: compress(added),
		},
	};
}

/** A sidecar file as a `RawFile`, or null when the stored copy is already identical. */
export function sidecarFile(relPath: string, content: Buffer, state: RawState): RawFile | null {
	const digest = sha256(content);
	if (state.sidecars[relPath] === digest) return null;
	return { relPath, sha256: digest, codec: CODEC_BROTLI, rawBytes: content.length, data: compress(content) };
}

/**
 * The path a session file has under the sessions root, with `/` separators, which
 * is where an export writes it back. A file outside the root (a root that moved
 * since it was indexed) keeps its project directory and name.
 */
export function relPathUnderRoot(root: string, filePath: string, project: string): string {
	const rel = path.relative(root, filePath);
	if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
	return `${project}/${path.basename(filePath)}`;
}
