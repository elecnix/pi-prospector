/**
 * Container/filesystem evidence extractors — the SecretScanner-style
 * extraction layer.
 *
 * Licence (issue #172): Deepfence SecretScanner's repository root is MIT, but
 * its detection rules are split across `config.yaml` signatures and a YARA
 * rules include with mixed provenance, so **no upstream rule text or code was
 * vendored or ported**. What this module reimplements is SecretScanner's
 * *method*: layered extraction — recognise the artifact a piece of text came
 * from (a Dockerfile, a compose file, a `.env` file, a build log, a CI log, a
 * shell export block) and segment it into key/value candidates before any
 * secret pattern is applied. Reference implementation studied:
 * `deepfence/SecretScanner`, release v2.5.8 (method and config surface only;
 * zero rule text consulted).
 *
 * This is the contribution no flat regex scan provides: a finding can say
 * WHERE the value lived ("ENV in Dockerfile", ".env entry", "shell export"),
 * not just that a pattern matched. Everything here is pure and deterministic:
 * same text in, same candidates out, in the same order.
 *
 * Extractors never decide whether something is a secret — they only segment
 * artifact contexts into (artifact kind, key, value) candidates. Detection
 * (catalogue matching plus structural name/shape checks) lives in
 * `detectors.ts`.
 */

import { Type, type Static } from "typebox";

// ──────────────────────────── kinds ────────────────────────────

/**
 * The artifact context a candidate was extracted from. One extractor may
 * recognise more than one kind (the containerfile extractor yields both
 * `dockerfile` and `compose` candidates).
 */
export const ArtifactKind = Type.Union([
	Type.Literal("dockerfile"),
	Type.Literal("compose"),
	Type.Literal("dotenv"),
	Type.Literal("build-log"),
	Type.Literal("ci-log"),
	Type.Literal("shell-export"),
]);
export type ArtifactKind = Static<typeof ArtifactKind>;

/** All artifact kinds, in stable order (for counts and config validation). */
export const ARTIFACT_KINDS: readonly ArtifactKind[] = [
	"dockerfile",
	"compose",
	"dotenv",
	"build-log",
	"ci-log",
	"shell-export",
];

/**
 * One key/value pair segmented out of an artifact context. `value` is the raw
 * assigned value (quotes stripped); it is a *candidate*, not a finding — most
 * candidates are benign (`PATH`, `LANG`, …).
 */
export interface ArtifactCandidate {
	/** The artifact context the pair was extracted from. */
	kind: ArtifactKind;
	/**
	 * Human-readable location, e.g. "ENV in Dockerfile", ".env entry",
	 * "shell export". A finding carries this verbatim so a reader knows where
	 * the value lived.
	 */
	location: string;
	/** The variable/entry name (never secret-bearing itself). */
	key: string;
	/** The raw assigned value, quotes stripped, as it appeared. */
	value: string;
	/** Character offset of the assignment within the scanned field text. */
	index: number;
}

/** Which extractors run — mirrors the config's extraction toggles. */
export interface ExtractorToggles {
	extractDockerfiles: boolean;
	extractDotenv: boolean;
	extractBuildLogs: boolean;
	extractCiLogs: boolean;
	extractShellExports: boolean;
}

// ──────────────────────────── helpers ────────────────────────────

/** A shell/identifier-style name: `KEY`, `KEY_2`, `_private`. */
const KEY_RE = "[A-Za-z_][A-Za-z0-9_]*";

interface Line {
	text: string;
	/** Character offset of the line start within the field text. */
	start: number;
}

function* iterLines(text: string): Generator<Line> {
	let start = 0;
	for (;;) {
		const nl = text.indexOf("\n", start);
		const line = nl === -1 ? text.slice(start) : text.slice(start, nl);
		yield { text: line, start };
		if (nl === -1) break;
		start = nl + 1;
	}
}

/** Strip one layer of surrounding single/double quotes from a raw value. */
function stripQuotes(raw: string): string {
	const v = raw.trim();
	if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
		return v.slice(1, -1);
	}
	return v;
}

/** Parse `KEY=value KEY2="value2"` runs (Dockerfile multi-assignment form). */
function parseKeyValueRuns(rest: string): Array<{ key: string; value: string; offset: number }> {
	const out: Array<{ key: string; value: string; offset: number }> = [];
	const re = new RegExp(`(${KEY_RE})\\s*=\\s*("[^"]*"|'[^']*'|[^\\s]+)`, "g");
	for (const m of rest.matchAll(re)) {
		out.push({ key: m[1]!, value: stripQuotes(m[2]!), offset: m.index ?? 0 });
	}
	return out;
}

// ──────────────────────────── containerfile ────────────────────────────

/** A line that only makes sense inside a Dockerfile (or Containerfile). The
 * optional leading `"key":` tolerates a JSON-embedded field (a tool call's
 * arguments) where the instruction follows a JSON key on the same line. */
const CONTAINERFILE_INSTRUCTION_RE = /^\s*(?:\\?"[A-Za-z_]+\\?"\s*:\s*)?(FROM|RUN|CMD|LABEL|EXPOSE|ADD|COPY|ENTRYPOINT|VOLUME|WORKDIR|USER|SHELL|STOPSIGNAL|ONBUILD|HEALTHCHECK)\s/i;

/** A Dockerfile instruction embedded as a JSON string value:
 * `"content":"FROM node:22 …"`. */
const JSON_EMBEDDED_INSTRUCTION_RE = /"[A-Za-z_]+"\s*:\s*"?(?:FROM|RUN|CMD|LABEL|EXPOSE|ADD|COPY|ENTRYPOINT|VOLUME|WORKDIR|USER|SHELL|STOPSIGNAL|ONBUILD|HEALTHCHECK)\s/i;

/**
 * Compose/GitLab-CI environment sections: a header line (`environment:`,
 * `variables:`, `env:`) followed by deeper-indented `- KEY=value` list items
 * or `KEY: value` mapping entries.
 */
function extractEnvironmentSections(text: string, kind: ArtifactKind, location: string): ArtifactCandidate[] {
	const out: ArtifactCandidate[] = [];
	const headerRe = new RegExp(`^(\\s*)(environment|variables|env)\\s*:\\s*$`);
	const listItemRe = new RegExp(`^\\s*-\\s*(${KEY_RE})\\s*=\\s*(.*)$`);
	const mapItemRe = new RegExp(`^(\\s+)(${KEY_RE})\\s*:\\s*(.*)$`);

	let headerIndent: number | null = null;
	for (const line of iterLines(text)) {
		const header = headerRe.exec(line.text);
		if (header) {
			headerIndent = header[1]!.length;
			continue;
		}
		if (headerIndent === null) continue;
		// A non-empty line at indent <= the header's ends the section.
		if (line.text.trim().length > 0 && line.text.length - line.text.trimStart().length <= headerIndent) {
			headerIndent = null;
			continue;
		}
		const listItem = listItemRe.exec(line.text);
		if (listItem) {
			out.push({
				kind,
				location,
				key: listItem[1]!,
				value: stripQuotes(listItem[2]!),
				index: line.start + line.text.indexOf(listItem[1]!),
			});
			continue;
		}
		const mapItem = mapItemRe.exec(line.text);
		if (mapItem) {
			out.push({
				kind,
				location,
				key: mapItem[2]!,
				value: stripQuotes(mapItem[3]!),
				index: line.start + mapItem[1]!.length + line.text.indexOf(mapItem[2]!),
			});
		}
	}
	return out;
}

/**
 * Dockerfile / compose extractor. Dockerfile instructions are only recognised
 * when the text carries containerfile evidence (an instruction line), so an
 * ordinary sentence starting with "ENV" in free prose is not misread. Compose
 * environment sections are recognised by their YAML shape.
 */
export function extractContainerfileCandidates(text: string): ArtifactCandidate[] {
	const lines = [...iterLines(text)];
	const looksLikeContainerfile = lines.some(
		(l) => CONTAINERFILE_INSTRUCTION_RE.test(l.text) || JSON_EMBEDDED_INSTRUCTION_RE.test(l.text),
	);

	const out: ArtifactCandidate[] = [];
	if (looksLikeContainerfile) {
		for (const line of lines) {
			// `ENV KEY=value KEY2=value2` / `ARG KEY=value` (buildkit-normalised form;
			// optional leading `"key":` for JSON-embedded fields)
			const instr = new RegExp(`^\\s*(?:\\?"[A-Za-z_]+\\?"\\s*:\\s*)?(ENV|ARG)\\s+(.+)$`).exec(line.text);
			if (instr) {
				const kind: ArtifactKind = "dockerfile";
				const location = `${instr[1]} in Dockerfile`;
				const base = line.start + line.text.indexOf(instr[2]!);
				for (const kv of parseKeyValueRuns(instr[2]!)) {
					out.push({ kind, location, key: kv.key, value: kv.value, index: base + kv.offset });
				}
				// Legacy space-separated form: `ENV KEY value`
				const legacy = new RegExp(`^\\s*ENV\\s+(${KEY_RE})\\s+([^=\\s].*)$`).exec(line.text);
				if (legacy && parseKeyValueRuns(instr[2]!).length === 0) {
					out.push({
						kind,
						location,
						key: legacy[1]!,
						value: stripQuotes(legacy[2]!),
						index: line.start + line.text.indexOf(legacy[1]!),
					});
				}
			}
		}
	}
	out.push(...extractEnvironmentSections(text, "compose", "compose environment block"));
	return out;
}

// ──────────────────────────── dotenv ────────────────────────────

/**
 * A `.env`-file mention: `cat .env`, `--env-file .env.production`,
 * "dotenv". Opens a window in which `KEY=value` lines read as dotenv entries.
 */
const DOTENV_MENTION_RE = /(?:^|[\s"'`(=])\.env(?:\.[A-Za-z0-9_-]+)?(?:[\s"'`,:;)]|$)/;

const DOTENV_LINE_RE = new RegExp(`^(${KEY_RE})=(.*)$`);
const DOTENV_BLOCK_MIN = 3;
/** How many lines after a `.env` mention the window stays open. */
const DOTENV_MENTION_WINDOW = 30;

/**
 * Dotenv extractor. `.env` content is recognised two ways, both
 * deterministic: (a) within {@link DOTENV_MENTION_WINDOW} lines after a
 * `.env`/dotenv mention, or (b) inside a run of at least
 * {@link DOTENV_BLOCK_MIN} consecutive `KEY=value` lines whose keys are
 * uppercase-style — the dotenv naming convention. A qualifying block yields
 * every line in the run, not just from the third onward.
 */
export function extractDotenvCandidates(text: string): ArtifactCandidate[] {
	const out: ArtifactCandidate[] = [];
	const lines = [...iterLines(text)];

	// Pass 1: which lines are upper-style KEY=value entries, and which fall in
	// a run of at least DOTENV_BLOCK_MIN consecutive such lines.
	const isEntry = lines.map((l) => {
		const m = DOTENV_LINE_RE.exec(l.text);
		return !!m && /^[A-Z][A-Z0-9_]*$/.test(m[1]!);
	});
	const inBlock = lines.map(() => false);
	let run = 0;
	for (let i = 0; i <= lines.length; i++) {
		if (i < lines.length && isEntry[i]) {
			run++;
			continue;
		}
		if (run >= DOTENV_BLOCK_MIN) {
			for (let j = i - run; j < i; j++) inBlock[j] = true;
		}
		run = 0;
	}

	// Pass 2: emit entries inside a qualifying block or the mention window.
	let window = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (DOTENV_MENTION_RE.test(line.text)) window = DOTENV_MENTION_WINDOW;
		const m = DOTENV_LINE_RE.exec(line.text);
		if (m && (window > 0 || inBlock[i])) {
			out.push({
				kind: "dotenv",
				location: ".env entry",
				key: m[1]!,
				value: stripQuotes(m[2]!),
				index: line.start + line.text.indexOf(m[1]!),
			});
		}
		if (window > 0) window--;
	}
	return out;
}

// ──────────────────────────── build log ────────────────────────────

/**
 * `docker build` output. Classic builder: `Step 3/9 : ENV KEY=value`.
 * BuildKit: `=> [3/9] ENV KEY=value`. Plus `--build-arg KEY=value` anywhere.
 */
export function extractBuildLogCandidates(text: string): ArtifactCandidate[] {
	const out: ArtifactCandidate[] = [];
	const stepRe = new RegExp(`^\\s*Step\\s+\\d+/\\d+\\s*:\\s*(ENV|ARG)\\s+(.*)$`);
	const buildkitRe = new RegExp(`^\\s*=>?\\s*\\[\\d+/\\d+\\]\\s*(ENV|ARG)\\s+(.*)$`);
	const buildArgRe = new RegExp(`--build-arg\\s+(${KEY_RE})=("[^"]*"|'[^']*'|[^\\s]+)`, "g");

	for (const line of iterLines(text)) {
		const step = stepRe.exec(line.text) ?? buildkitRe.exec(line.text);
		if (step) {
			const base = line.start + line.text.indexOf(step[2]!);
			for (const kv of parseKeyValueRuns(step[2]!)) {
				out.push({
					kind: "build-log",
					location: "docker build log",
					key: kv.key,
					value: kv.value,
					index: base + kv.offset,
				});
			}
		}
		for (const m of line.text.matchAll(buildArgRe)) {
			out.push({
				kind: "build-log",
				location: "docker build --build-arg",
				key: m[1]!,
				value: stripQuotes(m[2]!),
				index: line.start + (m.index ?? 0) + "--build-arg ".length,
			});
		}
	}
	return out;
}

// ──────────────────────────── CI log ────────────────────────────

/**
 * CI-log env evidence: GitHub Actions' `::set-env name=KEY::value` workflow
 * command (and its `add-mask` sibling, which is deliberately *not* emitted —
 * a masked value proves a secret existed but is not itself a leak). Workflow
 * `env:` mapping sections are handled by the environment-section parser.
 */
export function extractCiLogCandidates(text: string): ArtifactCandidate[] {
	const out: ArtifactCandidate[] = [];
	const setEnvRe = new RegExp(`::set-env\\s+name=(${KEY_RE})::(.*)$`);
	for (const line of iterLines(text)) {
		const m = setEnvRe.exec(line.text);
		if (m) {
			out.push({
				kind: "ci-log",
				location: "CI log set-env",
				key: m[1]!,
				value: stripQuotes(m[2]!),
				index: line.start + line.text.indexOf(m[1]!),
			});
		}
	}
	out.push(...extractEnvironmentSections(text, "ci-log", "workflow env block"));
	return out;
}

// ──────────────────────────── shell export ────────────────────────────

/**
 * Shell export blocks and profile snippets: `export KEY=value`, including the
 * quoted forms. A bare `KEY=value` without `export` is *not* taken here —
 * that shape belongs to the dotenv extractor's block/mention heuristics.
 */
export function extractShellExportCandidates(text: string): ArtifactCandidate[] {
	const out: ArtifactCandidate[] = [];
	const exportRe = new RegExp(`^\\s*export\\s+(${KEY_RE})=(?:"([^"]*)"|'([^']*)'|([^\\s#]+))`);
	for (const line of iterLines(text)) {
		const m = exportRe.exec(line.text);
		if (m) {
			const value = m[2] ?? m[3] ?? m[4] ?? "";
			out.push({
				kind: "shell-export",
				location: "shell export",
				key: m[1]!,
				value,
				index: line.start + line.text.indexOf(m[1]!),
			});
		}
	}
	return out;
}

// ──────────────────────────── field normalisation ────────────────────────────

export interface NormalizedFieldText {
	/** The text with JSON string escapes (`\n`, `\"`) unfolded to real characters. */
	text: string;
	/** Map from normalized index → original field-text index (one entry per char, plus end sentinel). */
	map: number[];
}

/**
 * Unfold the JSON string escapes a transcript's `tool_calls`/`tool_results`
 * fields carry, so line-anchored extractors see real line breaks. The map
 * takes a candidate's normalized offset back to its original offset in the
 * raw field text, so findings keep pointing into the field as stored.
 */
export function normalizeFieldText(raw: string): NormalizedFieldText {
	let text = "";
	const map: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (ch === "\\" && i + 1 < raw.length) {
			const next = raw[i + 1];
			if (next === "n") {
				text += "\n";
				map.push(i);
				i++;
				continue;
			}
			if (next === '"') {
				text += '"';
				map.push(i);
				i++;
				continue;
			}
		}
		text += ch;
		map.push(i);
	}
	map.push(raw.length);
	return { text, map };
}

// ──────────────────────────── facade ────────────────────────────

/**
 * Run every enabled extractor over one field's text and merge the results.
 * Deterministic order: by candidate index, then artifact kind, then key.
 * Duplicate (kind, index) candidates are dropped — the first wins.
 */
export function extractArtifactCandidates(text: string, toggles: ExtractorToggles): ArtifactCandidate[] {
	const all: ArtifactCandidate[] = [];
	if (toggles.extractDockerfiles) all.push(...extractContainerfileCandidates(text));
	if (toggles.extractDotenv) all.push(...extractDotenvCandidates(text));
	if (toggles.extractBuildLogs) all.push(...extractBuildLogCandidates(text));
	if (toggles.extractCiLogs) all.push(...extractCiLogCandidates(text));
	if (toggles.extractShellExports) all.push(...extractShellExportCandidates(text));

	all.sort(
		(a, b) =>
			a.index - b.index ||
			a.kind.localeCompare(b.kind) ||
			a.key.localeCompare(b.key),
	);
	const seen = new Set<string>();
	const out: ArtifactCandidate[] = [];
	for (const c of all) {
		const k = `${c.kind}\u0000${c.index}`;
		if (seen.has(k)) continue;
		seen.add(k);
		out.push(c);
	}
	return out;
}
