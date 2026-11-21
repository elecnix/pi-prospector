import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { FingerprintContributor, MeasureSpec } from "./contributor.js";
import { FINGERPRINT_SCHEMA_VERSION, Fingerprint, oneOf, SECTION_KINDS, type Bucket, type DistributionUnit } from "./schema.js";

/**
 * Two corpus fingerprints side by side. A fingerprint holds absolute counts,
 * and two corpora rarely have the same size, so the comparison turns every
 * figure into something that does not grow with the corpus: a total becomes a
 * rate per measured session, a session count becomes a share of the measured
 * sessions, a group becomes the share of sessions it touches, and a
 * distribution is read by its quantiles and the share of sessions in each
 * declared bucket.
 *
 * Groups are matched by their values, never by their position in the list,
 * and every cell says when it rests on few sessions or when one side withheld
 * it. The comparison reads only the two fingerprints and the contributors'
 * declarations (labels, measure kinds, bucket edges); it reads no database.
 */

/** A cell resting on fewer sessions than this is marked low: it is published, but noisy. */
export const LOW_COUNT = 20;

/** A section measured on a smaller share of its side's sessions than this gets a note. */
export const THIN_COVERAGE_PERCENT = 50;

/** What a cell can be marked with. */
export const CELL_FLAGS = ["low", "merged", "withheld", "absent"] as const;

export const Cell = Type.Object({
	text: Type.String(),
	/** The number the text shows, for the diff; null when there is none. */
	value: Type.Union([Type.Number(), Type.Null()]),
	flags: Type.Array(oneOf(CELL_FLAGS)),
});
export type Cell = Static<typeof Cell>;

/** How two values of a row differ: a ratio for rates and quantiles, a difference in points for shares. */
export const DIFF_KINDS = ["ratio", "points", "none"] as const;

export const ComparedRow = Type.Object({
	label: Type.String(),
	a: Cell,
	b: Cell,
	diff: Type.String(),
});
export type ComparedRow = Static<typeof ComparedRow>;

export const ComparedSection = Type.Object({
	id: Type.String(),
	label: Type.String(),
	description: Type.String(),
	kind: oneOf(SECTION_KINDS),
	/** Problems a reader should know before trusting the rows. */
	notes: Type.Array(Type.String()),
	rows: Type.Array(ComparedRow),
});
export type ComparedSection = Static<typeof ComparedSection>;

export const ComparedSide = Type.Object({
	label: Type.String(),
	asOf: Type.String(),
	sessions: Type.Integer(),
	/** `2026-03 to 2026-06`, `withheld`, or `not stated` for a fingerprint from before the period. */
	period: Type.String(),
	filter: Type.String(),
});
export type ComparedSide = Static<typeof ComparedSide>;

export const Comparison = Type.Object({
	sides: Type.Tuple([ComparedSide, ComparedSide]),
	/** Problems with the comparison as a whole. */
	notes: Type.Array(Type.String()),
	sections: Type.Array(ComparedSection),
});
export type Comparison = Static<typeof Comparison>;

export const FingerprintSide = Type.Object({ label: Type.String(), fingerprint: Fingerprint });
export type FingerprintSide = Static<typeof FingerprintSide>;

export const CompareRequest = Type.Object({
	files: Type.Tuple([Type.String(), Type.String()]),
	labels: Type.Tuple([Type.String(), Type.String()]),
	format: Type.Optional(Type.String()),
	out: Type.Optional(Type.String()),
});
export type CompareRequest = Static<typeof CompareRequest>;

/** A file's label when none is given: its name without the directory or `.json`. */
function labelOf(file: string): string {
	return file.replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
}

/** Parse `A.json B.json [--labels a,b] [--format text|markdown] [--out FILE]`. */
export function parseCompareArgs(raw: string): CompareRequest {
	const tokens = raw.trim().split(/\s+/).filter((t) => t.length > 0);
	const files: string[] = [];
	const flags: Record<string, string> = {};
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) {
			files.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
		const value = eq === -1 ? tokens[++i] : token.slice(eq + 1);
		if (name !== "labels" && name !== "format" && name !== "out") throw new Error(`unknown flag --${name} (use --labels, --format, --out)`);
		if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`--${name} needs a value`);
		flags[name] = value;
	}
	const [a, b] = files;
	if (files.length !== 2 || a === undefined || b === undefined) throw new Error("compare takes two fingerprint files: compare A.json B.json");
	let labels: [string, string] = [labelOf(a), labelOf(b)];
	if (flags["labels"] !== undefined) {
		const given = flags["labels"].split(",").map((l) => l.trim()).filter((l) => l.length > 0);
		if (given.length !== 2) throw new Error("--labels takes two labels, comma-separated");
		labels = [given[0]!, given[1]!];
	}
	return { files: [a, b], labels, format: flags["format"], out: flags["out"] };
}

/** Parse a fingerprint file's text. `name` is used in the error messages. */
export function parseFingerprintText(text: string, name: string): Fingerprint {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${name} is not JSON`);
	}
	if (typeof value !== "object" || value === null || (value as { kind?: unknown }).kind !== "corpus-fingerprint") {
		throw new Error(`${name} is not a corpus fingerprint`);
	}
	const version = (value as { schemaVersion?: unknown }).schemaVersion;
	if (version !== FINGERPRINT_SCHEMA_VERSION) {
		throw new Error(`${name} has schema version ${String(version)}; this build reads version ${FINGERPRINT_SCHEMA_VERSION}`);
	}
	if (!Check(Fingerprint, value)) throw new Error(`${name} does not match the fingerprint schema`);
	return value;
}

/** `turnFailures` → `turn failures`. */
export function humanize(id: string): string {
	return id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

type Section = Record<string, unknown> & { status: string; sessionsMeasured?: number };

const isOk = (s: unknown): s is Section & { sessionsMeasured: number } =>
	typeof s === "object" && s !== null && (s as Section).status === "ok" && typeof (s as Section).sessionsMeasured === "number";

const isWithheld = (v: unknown): boolean => typeof v === "object" && v !== null && (v as { status?: unknown }).status === "withheld";

const cell = (text: string, value: number | null, flags: Cell["flags"] = []): Cell => ({ text, value, flags });
const WITHHELD_CELL = cell("withheld", null, ["withheld"]);
const ABSENT_CELL = cell("–", null, ["absent"]);

function pct(part: number, whole: number): number {
	return whole === 0 ? 0 : (part / whole) * 100;
}

function pctText(p: number): string {
	return p < 1 && p > 0 ? "<1%" : `${Math.round(p)}%`;
}

function fixed(n: number): string {
	return Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(2);
}

function ratio(a: Cell, b: Cell): string {
	if (a.value === null || b.value === null) return "";
	if (a.value === 0) return b.value === 0 ? "=" : "";
	return `×${(b.value / a.value).toFixed(1)}`;
}

function points(a: Cell, b: Cell): string {
	if (a.value === null || b.value === null) return "";
	const d = Math.round(b.value - a.value);
	return d === 0 ? "=" : `${d > 0 ? "+" : ""}${d} pp`;
}

function diffOf(kind: (typeof DIFF_KINDS)[number], a: Cell, b: Cell): string {
	return kind === "ratio" ? ratio(a, b) : kind === "points" ? points(a, b) : "";
}

/** One measure of one side: a function from a row key to a cell, plus the row keys it has. */
interface MeasureCells {
	keys: string[];
	cell(key: string): Cell;
}

function lowFlag(sessions: number): Cell["flags"] {
	return sessions < LOW_COUNT ? ["low"] : [];
}

function bucketLabel(from: number, to: number | null): string {
	return to === null ? `${from}+` : `${from}–${to}`;
}

const UNIT_NAMES: Record<DistributionUnit, string> = {
	minutes: "minutes",
	prompts: "prompts",
	"tool-calls": "tool calls",
	mite: "MITE",
	percent: "%",
	ratio: "ratio",
	files: "files",
};

/**
 * A measure's name for its rows. A name like `per session` gets its section's
 * label in front, so it reads alone.
 */
function measureName(measure: MeasureSpec, sectionLabel: string): string {
	const name = humanize(measure.id);
	return name.startsWith("per ") ? `${sectionLabel.toLowerCase()} ${name}` : name;
}

/** The rows of one measure on one side of the comparison. */
function measureCells(measure: MeasureSpec, name: string, section: unknown): MeasureCells | "withheld" | "missing" {
	if (!isOk(section)) return isWithheld(section) ? "withheld" : "missing";
	const value = section[measure.id];
	if (value === undefined) return "missing";
	if (isWithheld(value)) return "withheld";
	const measured = section.sessionsMeasured;
	switch (measure.kind) {
		case "total": {
			const n = value as number;
			return { keys: [`${name} per session`], cell: () => cell(fixed(n / Math.max(measured, 1)), n / Math.max(measured, 1), lowFlag(measured)) };
		}
		case "sessions": {
			const p = pct(value as number, measured);
			return { keys: [name], cell: () => cell(pctText(p), p, lowFlag(value as number)) };
		}
		case "distinct":
			return { keys: [name], cell: () => cell(String(value), value as number, lowFlag(measured)) };
		case "distribution": {
			const d = value as { sessions: number; p50: number; p90: number; buckets: Bucket[] };
			const declared = measure.edges.map((from, i) => ({ from, to: measure.edges[i + 1] ?? null }));
			const unit = UNIT_NAMES[measure.unit];
			const named = name.includes(unit);
			const cells = new Map<string, Cell>([
				[named ? `${name} p50` : `${name} p50 (${unit})`, cell(fixed(d.p50), d.p50, lowFlag(d.sessions))],
				[named ? `${name} p90` : `${name} p90 (${unit})`, cell(fixed(d.p90), d.p90, lowFlag(d.sessions))],
			]);
			for (const want of declared) {
				const key = `${name}: ${bucketLabel(want.from, want.to)}${named ? "" : ` ${unit}`}`;
				const holder = d.buckets.find((bk) => bk.from <= want.from && (bk.to === null || (want.to !== null && want.to <= bk.to)));
				if (holder === undefined) continue;
				const p = pct(holder.sessions, d.sessions);
				const exact = holder.from === want.from && holder.to === want.to;
				if (exact) cells.set(key, cell(pctText(p), p, lowFlag(holder.sessions)));
				else if (holder.from === want.from) cells.set(key, cell(`${pctText(p)} (${bucketLabel(holder.from, holder.to)})`, null, ["merged", ...lowFlag(holder.sessions)]));
				else cells.set(key, cell("↑", null, ["merged"]));
			}
			return { keys: [...cells.keys()], cell: (key) => cells.get(key) ?? ABSENT_CELL };
		}
		case "groups": {
			const names = Object.keys(measure.dimensions);
			const groups = value as Array<Record<string, string | number>>;
			const cells = new Map<string, Cell>();
			for (const g of groups) {
				const key = `${name}: ${names.map((n) => String(g[n])).join(" / ")}`;
				const sessions = Number(g["sessions"]);
				const p = pct(sessions, measured);
				cells.set(key, cell(pctText(p), p, lowFlag(sessions)));
			}
			return { keys: [...cells.keys()], cell: (key) => cells.get(key) ?? ABSENT_CELL };
		}
	}
}

function diffKind(measure: MeasureSpec, key: string): (typeof DIFF_KINDS)[number] {
	switch (measure.kind) {
		case "total":
			return "ratio";
		case "distinct":
			return "none";
		case "sessions":
		case "groups":
			return "points";
		case "distribution":
			return / p\d+( \(.*\))?$/.test(key) ? "ratio" : "points";
	}
}

function sideCell(cells: MeasureCells | "withheld" | "missing", key: string): Cell {
	if (cells === "withheld") return WITHHELD_CELL;
	if (cells === "missing") return ABSENT_CELL;
	return cells.cell(key);
}

/** The largest share or value a row shows on either side, to put the biggest groups first. */
function weight(row: ComparedRow): number {
	return Math.max(row.a.value ?? 0, row.b.value ?? 0);
}

const VersionEntry = Type.Object({ analyzer: Type.String(), version: Type.String(), sessions: Type.Integer() });
type VersionEntry = Static<typeof VersionEntry>;

function versionsOf(section: unknown): VersionEntry[] | null {
	if (!isOk(section)) return null;
	const v = section["versions"];
	return Array.isArray(v) && v.every((e) => Check(VersionEntry, e)) ? (v as VersionEntry[]) : null;
}

/** `failure-modes 1.3 (75%), 1.2 (25%)`: each analyzer's versions with their share of its sessions. */
function mixText(entries: readonly VersionEntry[]): string {
	const analyzers = [...new Set(entries.map((e) => e.analyzer))];
	return analyzers
		.map((analyzer) => {
			const mine = entries.filter((e) => e.analyzer === analyzer);
			const total = mine.reduce((n, e) => n + e.sessions, 0);
			return `${analyzer} ${mine.map((e) => `${e.version} (${pctText(pct(e.sessions, total))})`).join(", ")}`;
		})
		.join("; ");
}

/** What a reader should know about the analyzer versions behind a section's two sides. */
function versionNotes(def: FingerprintContributor["def"], a: FingerprintSide["label"], sa: unknown, b: FingerprintSide["label"], sb: unknown): string[] {
	if (def.analyzers === undefined || !isOk(sa) || !isOk(sb)) return [];
	const va = versionsOf(sa);
	const vb = versionsOf(sb);
	const missing = [va === null ? a : null, vb === null ? b : null].filter((l) => l !== null);
	if (missing.length > 0) return [`${missing.join(" and ")} does not say which analyzer versions measured this section.`];
	const keys = (v: VersionEntry[]) => [...new Set(v.map((e) => `${e.analyzer}@${e.version}`))].sort().join(",");
	const mixed = (v: VersionEntry[]) => v.length > new Set(v.map((e) => e.analyzer)).size;
	if (keys(va!) !== keys(vb!)) return [`Analyzer versions differ: ${a} ${mixText(va!)}; ${b} ${mixText(vb!)}.`];
	if (mixed(va!) || mixed(vb!)) return [`Both sides mix analyzer versions: ${a} ${mixText(va!)}; ${b} ${mixText(vb!)}.`];
	return [];
}

/**
 * A note about one side of a section that a reader needs before its rows: it
 * covers a thin share of the corpus. A distribution never holds two values for
 * one session, because the builder refuses a second row per session.
 */
function sideNotes(label: string, section: unknown, total: number): string[] {
	if (!isOk(section)) return [];
	const coverage = pct(section.sessionsMeasured, total);
	return coverage < THIN_COVERAGE_PERCENT ? [`${label} is measured on ${pctText(coverage)} of its sessions; its figures describe that subset.`] : [];
}

function compareSection(contributor: FingerprintContributor, a: unknown, b: unknown, totals: [number, number], labels: [string, string]): ComparedSection {
	const { def } = contributor;
	const notes: string[] = [...versionNotes(def, labels[0], a, labels[1], b), ...sideNotes(labels[0], a, totals[0]), ...sideNotes(labels[1], b, totals[1])];
	const coverage = (s: unknown, total: number): Cell => {
		if (isOk(s)) {
			const p = pct(s.sessionsMeasured, total);
			return cell(`${s.sessionsMeasured} (${pctText(p)})`, p, lowFlag(s.sessionsMeasured));
		}
		return isWithheld(s) ? WITHHELD_CELL : ABSENT_CELL;
	};
	const ca = coverage(a, totals[0]);
	const cb = coverage(b, totals[1]);
	const rows: ComparedRow[] = [{ label: "sessions measured", a: ca, b: cb, diff: points(ca, cb) }];
	for (const measure of def.measures) {
		const name = measureName(measure, def.label);
		const sa = measureCells(measure, name, a);
		const sb = measureCells(measure, name, b);
		const keys = [...new Set([...(typeof sa === "object" ? sa.keys : []), ...(typeof sb === "object" ? sb.keys : [])])];
		if (keys.length === 0) {
			const label = measure.kind === "total" ? `${name} per session` : name;
			const left = sideCell(sa, label);
			const right = sideCell(sb, label);
			rows.push({ label, a: left, b: right, diff: "" });
			continue;
		}
		const measureRows = keys.map((key) => {
			const left = sideCell(sa, key);
			const right = sideCell(sb, key);
			return { label: key, a: left, b: right, diff: diffOf(diffKind(measure, key), left, right) };
		});
		if (measure.kind === "groups") measureRows.sort((x, y) => weight(y) - weight(x));
		rows.push(...measureRows);
	}
	return { id: def.id, label: def.label, description: def.description, kind: def.kind, notes, rows };
}

function filterText(fp: Fingerprint): string {
	const { sources, from, to } = fp.filter;
	const parts = [sources === null ? "all sources" : sources.join(",")];
	if (from !== null || to !== null) parts.push(`${from ?? "…"} to ${to ?? "…"}`);
	return parts.join(", ");
}

const Period = Type.Object({ from: Type.String(), to: Type.String() });
type Period = Static<typeof Period>;

function periodOf(fp: Fingerprint): Period | null {
	const p = fp.period;
	return p !== undefined && "from" in p ? p : null;
}

function periodText(fp: Fingerprint): string {
	if (fp.period === undefined) return "not stated";
	const p = periodOf(fp);
	return p === null ? "withheld" : `${p.from} to ${p.to}`;
}

/** The last day of a `YYYY-MM` month. */
function lastDay(month: string): string {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** A note when the two periods differ, naming the months they share and the flags that select them. */
function periodNotes(a: Fingerprint, b: Fingerprint): string[] {
	const pa = periodOf(a);
	const pb = periodOf(b);
	if (pa === null || pb === null) return a.period === undefined || b.period === undefined ? ["A side does not state its period, so the comparison cannot check that both cover the same months."] : [];
	if (pa.from === pb.from && pa.to === pb.to) return [];
	const from = pa.from > pb.from ? pa.from : pb.from;
	const to = pa.to < pb.to ? pa.to : pb.to;
	if (from > to) return ["The periods do not overlap."];
	return [`The periods differ; they share ${from} to ${to}. To compare like for like, rebuild both with --from ${from}-01 --to ${lastDay(to)}.`];
}

/** A source mix that differs by more than this many points between the sides gets a note. */
export const SOURCE_MIX_POINTS = 10;

/** Each source's share of the sessions, from the `sources` section, largest first; empty when it is not published. */
function sourceMix(fp: Fingerprint): Array<[string, number]> {
	const section = fp.objective["sources"];
	if (!isOk(section) || !Array.isArray(section["bySource"])) return [];
	return (section["bySource"] as Array<{ source: string; sessions: number }>)
		.map((g): [string, number] => [g.source, pct(g.sessions, section.sessionsMeasured)])
		.sort((x, y) => y[1] - x[1]);
}

/**
 * A note when the harness mix differs by more than {@link SOURCE_MIX_POINTS}
 * points: most figures vary by harness, so the mix alone can explain a
 * difference. It names the source both sides have most of, to rebuild on.
 */
function sourceNotes(a: FingerprintSide, b: FingerprintSide): string[] {
	const ma = sourceMix(a.fingerprint);
	const mb = sourceMix(b.fingerprint);
	if (ma.length === 0 || mb.length === 0) return [];
	const share = (mix: Array<[string, number]>, source: string) => mix.find(([s]) => s === source)?.[1] ?? 0;
	const sources = [...new Set([...ma, ...mb].map(([s]) => s))];
	if (!sources.some((s) => Math.abs(share(ma, s) - share(mb, s)) > SOURCE_MIX_POINTS)) return [];
	const best = [...sources].sort((x, y) => Math.min(share(ma, y), share(mb, y)) - Math.min(share(ma, x), share(mb, x)))[0]!;
	const text = (mix: Array<[string, number]>) => mix.map(([s, p]) => `${s} ${pctText(p)}`).join(", ");
	return [
		`The source mix differs (${a.label}: ${text(ma)}; ${b.label}: ${text(mb)}), and figures vary by harness. To compare like for like, rebuild both with --source ${best}.`,
	];
}

/** Compare two fingerprints section by section, in the contributors' order. */
export function compareFingerprints(a: FingerprintSide, b: FingerprintSide, contributors: readonly FingerprintContributor[]): Comparison {
	const notes: string[] = [...periodNotes(a.fingerprint, b.fingerprint), ...sourceNotes(a, b)];
	if (a.fingerprint.minGroupSize !== b.fingerprint.minGroupSize) notes.push("The two sides were built with different minimum group sizes.");
	const totals: [number, number] = [a.fingerprint.sessions.count, b.fingerprint.sessions.count];
	const sections = contributors.map((c) => compareSection(c, a.fingerprint[c.def.kind][c.def.id], b.fingerprint[c.def.kind][c.def.id], totals, [a.label, b.label]));
	const known = new Set(contributors.map((c) => `${c.def.kind}.${c.def.id}`));
	for (const side of [a, b]) {
		for (const kind of SECTION_KINDS) {
			for (const id of Object.keys(side.fingerprint[kind])) {
				if (!known.has(`${kind}.${id}`)) notes.push(`${side.label} has a section this build does not know (${kind}.${id}); it is not shown.`);
			}
		}
	}
	const side = (s: FingerprintSide): ComparedSide => ({ label: s.label, asOf: s.fingerprint.asOf, sessions: s.fingerprint.sessions.count, period: periodText(s.fingerprint), filter: filterText(s.fingerprint) });
	return { sides: [side(a), side(b)], notes, sections };
}

// ───────────────────────────── renderers ─────────────────────────────

/** A format a comparison can be printed in, keyed by id like the fingerprint's own renderers. */
export interface CompareRenderer {
	id: string;
	label: string;
	render(comparison: Comparison): string;
}

const LEGEND = [
	"Totals are per measured session; session counts and groups are shares of the measured sessions.",
	"Distributions: p50/p90 in the declared unit, then the share of sessions in each declared bucket.",
	`* rests on fewer than ${LOW_COUNT} sessions.  – absent: zero, or folded into 'other' under the minimum group size.`,
	"(a–b) a bucket the guard merged with its neighbour; ↑ the share is in the merged bucket above.",
	"×n is b divided by a; pp is the difference in percentage points.",
];

function cellText(c: Cell): string {
	return c.flags.includes("low") ? `${c.text}*` : c.text;
}

function sideLines(comparison: Comparison): string[] {
	return comparison.sides.map((s, i) => `${i === 0 ? "a" : "b"}: ${s.label} — ${s.sessions} sessions started ${s.period}, as of ${s.asOf}, ${s.filter}`);
}

export const textCompareRenderer: CompareRenderer = {
	id: "text",
	label: "Plain-text table",
	render(comparison) {
		const [a, b] = comparison.sides;
		const lines: string[] = ["Corpus fingerprint comparison", "", ...sideLines(comparison), ...comparison.notes.map((n) => `! ${n}`), ""];
		const width = Math.max(30, ...comparison.sections.flatMap((s) => s.rows.map((r) => r.label.length)));
		const cols = Math.max(12, a.label.length, b.label.length, ...comparison.sections.flatMap((s) => s.rows.flatMap((r) => [cellText(r.a).length, cellText(r.b).length])));
		const line = (label: string, x: string, y: string, d: string) => `  ${label.padEnd(width)}  ${x.padStart(cols)}  ${y.padStart(cols)}  ${d}`.trimEnd();
		for (const section of comparison.sections) {
			lines.push(`${section.label} (${section.kind})`);
			for (const note of section.notes) lines.push(`  ! ${note}`);
			lines.push(line("", a.label, b.label, "diff"));
			for (const r of section.rows) lines.push(line(r.label, cellText(r.a), cellText(r.b), r.diff));
			lines.push("");
		}
		lines.push(...LEGEND);
		return lines.join("\n") + "\n";
	},
};

function mdCell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

export const markdownCompareRenderer: CompareRenderer = {
	id: "markdown",
	label: "Markdown tables",
	render(comparison) {
		const [a, b] = comparison.sides;
		const lines: string[] = ["# Corpus fingerprint comparison", "", ...sideLines(comparison).map((l) => `- ${l}`), ...comparison.notes.map((n) => `- **${n}**`), ""];
		for (const section of comparison.sections) {
			lines.push(`## ${section.label} (${section.kind})`, "", section.description, "");
			for (const note of section.notes) lines.push(`> ${note}`, "");
			lines.push(`| measure | ${mdCell(a.label)} | ${mdCell(b.label)} | diff |`, "|---|---:|---:|---:|");
			for (const r of section.rows) lines.push(`| ${mdCell(r.label)} | ${mdCell(cellText(r.a))} | ${mdCell(cellText(r.b))} | ${r.diff} |`);
			lines.push("");
		}
		lines.push(...LEGEND.map((l) => `- ${l}`));
		return lines.join("\n") + "\n";
	},
};

export const COMPARE_RENDERERS: readonly CompareRenderer[] = [textCompareRenderer, markdownCompareRenderer];

export function resolveCompareRenderer(id: string | undefined, renderers: readonly CompareRenderer[] = COMPARE_RENDERERS): CompareRenderer {
	const wanted = id ?? "text";
	const found = renderers.find((r) => r.id === wanted);
	if (!found) throw new Error(`unknown format '${wanted}' (use ${renderers.map((r) => r.id).join(", ")})`);
	return found;
}
