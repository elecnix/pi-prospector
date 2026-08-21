/**
 * The two outputs `token-units` declares.
 *
 *   `report`  — a self-contained HTML page: a hero figure, a nested
 *               square-in-square treemap whose hierarchy the reader can
 *               re-order, per-dimension tables, and a table view.
 *   `classes` — the same data as a CSV of classes and their cost in tokens,
 *               for anything that is not a browser.
 *
 * Both fold the same leaf list, so the page and the CSV cannot disagree.
 *
 * On colour. A treemap sets arbitrary rectangles side by side, which makes it an
 * all-pairs form for colourblind safety, and only three hues clear the
 * separation floors in both light and dark — a fourth seats yellow beside orange
 * and fails. So three or fewer top-level groups each get a hue, and past that the
 * diagram drops to a single hue and lets labels and area carry identity. The
 * alternative — colouring the three biggest and greying the rest — reads as a
 * grouping that does not exist.
 */

import type { AnalyzerOutput, AnalyzerOutputContext, OutputArtifact } from "../../types.js";
import { DEFAULT_TOKEN_UNITS_CONFIG, EQUIVALENTS_PER_MITE, type TokenUnitsConfig } from "./config.js";
import { buildLeaves, classCosts, type BuildLeavesResult, type Leaf } from "./leaves.js";
import { REPORT_CLIENT_SCRIPT } from "./report-client.js";

/** Validated light/dark categorical slots plus the de-emphasis gray. */
const PALETTE = {
	light: { series: ["#2a78d6", "#eb6834", "#1baf7a"], other: "#898781" },
	dark: { series: ["#3987e5", "#d95926", "#199e70"], other: "#898781" },
};

function localToday(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Read the shared options both outputs honour.
 *
 * `day` defaults to today and accepts `all` for the whole corpus — a report over
 * every indexed session is a legitimate question, and silently forcing a single
 * day would make it unaskable.
 */
function readOptions(ctx: AnalyzerOutputContext): { day?: string; previews: boolean; label: string } {
	const raw = (ctx.options.day ?? "").trim();
	const previews = ctx.options.previews !== "false";
	if (raw === "all") return { previews, label: "all indexed sessions" };
	const day = raw === "" ? localToday() : raw;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
		throw new Error(`day must be YYYY-MM-DD or 'all', got '${day}'`);
	}
	return { day, previews, label: day };
}

async function gather(ctx: AnalyzerOutputContext): Promise<{ built: BuildLeavesResult; day?: string; label: string; previews: boolean }> {
	const { day, previews, label } = readOptions(ctx);
	const built = await buildLeaves({
		db: ctx.db,
		tokenNodes: await ctx.ownNodes,
		classNodes: await ctx.getNodes("request-classes"),
		day,
		previews,
	});
	return { built, day, label, previews };
}

function fmtMite(n: number): string {
	if (n >= 100) return n.toFixed(0);
	if (n >= 10) return n.toFixed(1);
	if (n >= 1) return n.toFixed(2);
	return n.toFixed(3);
}

// ── the HTML report ──

export const reportOutput: AnalyzerOutput = {
	def: {
		id: "report",
		label: "Daily token report (HTML)",
		description:
			"A self-contained page: total MITE, a nested treemap of where it went, and per-class, per-model, per-project and per-hour tables. Options: day=YYYY-MM-DD|all (default today), previews=false to leave request text out.",
	},
	render: async (ctx: AnalyzerOutputContext): Promise<OutputArtifact[]> => {
		const { built, label, previews } = await gather(ctx);
		const cfg = (ctx.config as unknown as TokenUnitsConfig) ?? DEFAULT_TOKEN_UNITS_CONFIG;
		const filenameDay = label === "all indexed sessions" ? "all" : label;

		return [
			{
				filename: `token-report-${filenameDay}.html`,
				mediaType: "text/html",
				content: renderPage(built, label, cfg, previews),
				summary: `${fmtMite(built.totals.mite)} MITE over ${built.sessionsWithSpend} session(s)`,
			},
		];
	},
};

/** Leaves become tuples so the page carries no repeated key names. */
function leafTuple(l: Leaf): unknown[] {
	return [l.source, l.project, l.className, l.sessionLabel, l.model, l.hour, l.totals.mite, l.totals.calls, l.preview];
}

function renderPage(built: BuildLeavesResult, label: string, cfg: TokenUnitsConfig, previews: boolean): string {
	// The payload is parsed at runtime, never interpolated into markup, so a
	// project or class name containing markup cannot break out of it.
	const payload = JSON.stringify({
		day: label,
		generatedAt: new Date().toISOString(),
		leaves: built.leaves.map(leafTuple),
		totals: {
			mite: built.totals.mite,
			calls: built.totals.calls,
			input: built.totals.input,
			output: built.totals.output,
			cacheRead: built.totals.cache_read,
			cacheWrite: built.totals.cache_write,
		},
		coverage: built.coverage,
		sessionsWithSpend: built.sessionsWithSpend,
		classifiedSessions: built.classifiedSessions,
		unclassifiedMite: built.unclassifiedMite,
		truncatedRequests: built.truncatedRequests,
		weights: cfg.weights ?? DEFAULT_TOKEN_UNITS_CONFIG.weights,
		equivalentsPerMite: EQUIVALENTS_PER_MITE,
		previews,
		palette: PALETTE,
	}).replace(/</g, "\\u003c");

	return `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session token report — ${escapeHtml(label)}</title>
<style>
${STYLES}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Session token report</h1>
    <button class="tgl" id="theme">Theme</button>
  </header>
  <p class="sub" id="subtitle"></p>

  <div class="card">
    <div class="hero"><span class="value" id="heroValue">—</span><span class="unit">MITE</span></div>
    <p class="hero-note" id="heroNote"></p>
    <div class="kpis" id="kpis"></div>
  </div>

  <div class="card">
    <h2>Where it went</h2>
    <div class="controls">
      <label class="ctl" for="hier">Nesting</label>
      <select id="hier"></select>
      <label class="ctl" for="depth">Depth</label>
      <select id="depth"><option value="2">2 levels</option><option value="3" selected>3 levels</option><option value="4">4 levels</option></select>
    </div>
    <div class="legend" id="legend"></div>
    <svg id="treemap" role="img" aria-label="Nested treemap of token spend"></svg>
    <p class="method" style="margin:10px 0 0">Area is MITE. Each square holds its children; colour marks the outermost group only, and depth is a lighter step of that same colour. Every value is also in the tables below.</p>
  </div>

  <div class="card">
    <h2>By class <span style="font-weight:400;color:var(--text-secondary);font-size:13px">— named by the model, not chosen from a list</span></h2>
    <div class="scroll"><table id="classTable"></table></div>
  </div>

  <div class="card">
    <h2>By model, project, and hour</h2>
    <div id="dimTables"></div>
  </div>

  <div class="card">
    <h2>Table view</h2>
    <p class="method" style="margin:-4px 0 12px">Every leaf of the treemap, largest first.</p>
    <div class="scroll"><table id="leafTable"></table></div>
  </div>

  <div class="card">
    <h2>How this is counted</h2>
    <div class="method" id="method"></div>
  </div>
</div>
<div class="tip" id="tip" role="status" aria-live="polite"></div>
<script id="payload" type="application/json">${payload}</script>
<script>
${REPORT_CLIENT_SCRIPT}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// ── the class-cost list ──

export const classCostsOutput: AnalyzerOutput = {
	def: {
		id: "classes",
		label: "Class cost list (CSV)",
		description:
			"One row per class: its MITE and the raw token counts behind it. Same options as the report. Classes are the model's own names, grouped only by case and whitespace.",
	},
	render: async (ctx: AnalyzerOutputContext): Promise<OutputArtifact[]> => {
		const { built, label } = await gather(ctx);
		const costs = classCosts(built.leaves, built.totals.mite);
		const filenameDay = label === "all indexed sessions" ? "all" : label;

		const header = [
			"class",
			"mite",
			"share",
			"calls",
			"input_tokens",
			"output_tokens",
			"cache_read_tokens",
			"cache_write_tokens",
		];
		const rows = costs.map((c) => [
			csvField(c.className),
			c.totals.mite.toFixed(6),
			c.share.toFixed(6),
			Math.round(c.totals.calls).toString(),
			Math.round(c.totals.input).toString(),
			Math.round(c.totals.output).toString(),
			Math.round(c.totals.cache_read).toString(),
			Math.round(c.totals.cache_write).toString(),
		]);

		return [
			{
				filename: `token-classes-${filenameDay}.csv`,
				mediaType: "text/csv",
				content: [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n",
				summary: `${costs.length} class(es) over ${fmtMite(built.totals.mite)} MITE`,
			},
		];
	},
};

/** RFC 4180 quoting. Class names are free text and do contain commas. */
function csvField(value: string): string {
	if (!/[",\n\r]/.test(value)) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

const STYLES = `
:root {
  color-scheme: light;
  --surface-1: #fcfcfb;
  --page: #f9f9f7;
  --text-primary: #0b0b0b;
  --text-secondary: #52514e;
  --text-muted: #898781;
  --grid: #e1e0d9;
  --axis: #c3c2b7;
  --border: rgba(11,11,11,0.10);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface-1: #1a1a19;
  --page: #0d0d0d;
  --text-primary: #ffffff;
  --text-secondary: #c3c2b7;
  --text-muted: #898781;
  --grid: #2c2c2a;
  --axis: #383835;
  --border: rgba(255,255,255,0.10);
}
@media (prefers-color-scheme: dark) {
  :root:where([data-theme="auto"]) {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --page: #0d0d0d;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted: #898781;
    --grid: #2c2c2a;
    --axis: #383835;
    --border: rgba(255,255,255,0.10);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 28px 64px;
  background: var(--page); color: var(--text-primary);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { max-width: 1180px; margin: 0 auto; }
header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 4px; }
h1 { font-size: 19px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 15px; font-weight: 600; margin: 0 0 12px; }
.sub { color: var(--text-secondary); font-size: 13px; margin: 0 0 28px; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 20px; }
.hero { display: flex; align-items: flex-end; gap: 14px; margin-bottom: 6px; }
.hero .value { font-size: 56px; font-weight: 600; line-height: 1; letter-spacing: -0.02em; }
.hero .unit { font-size: 17px; color: var(--text-secondary); padding-bottom: 6px; }
.hero-note { color: var(--text-secondary); font-size: 13px; margin: 0; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 18px; margin-top: 22px; padding-top: 20px; border-top: 1px solid var(--grid); }
.kpi .label { color: var(--text-secondary); font-size: 12px; margin-bottom: 3px; }
.kpi .value { font-size: 21px; font-weight: 600; }
.kpi .foot { color: var(--text-muted); font-size: 11px; margin-top: 2px; }
.controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
label.ctl { color: var(--text-secondary); font-size: 13px; }
select, button.tgl {
  font: inherit; font-size: 13px; color: var(--text-primary);
  background: var(--surface-1); border: 1px solid var(--axis);
  border-radius: 7px; padding: 6px 10px; cursor: pointer;
}
.legend { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin: 0 0 12px; }
.legend .item { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-secondary); }
.legend .swatch { width: 11px; height: 11px; border-radius: 3px; flex: none; }
#treemap { width: 100%; height: 620px; display: block; }
#treemap rect { transition: opacity 120ms ease; }
#treemap g.leaf:hover rect, #treemap g.leaf:focus rect { opacity: 0.82; }
#treemap g.leaf:focus { outline: none; }
#treemap g.leaf:focus rect { stroke: var(--text-primary); stroke-width: 2px; }
#treemap text { pointer-events: none; }
.tip {
  position: fixed; z-index: 20; pointer-events: none; opacity: 0;
  background: var(--surface-1); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px;
  box-shadow: 0 6px 22px rgba(0,0,0,0.16); max-width: 340px; font-size: 12px;
  transition: opacity 90ms ease;
}
.tip .v { font-size: 17px; font-weight: 600; margin-bottom: 3px; }
.tip .path { color: var(--text-secondary); margin-bottom: 5px; }
.tip .key { display: inline-block; width: 14px; height: 2px; vertical-align: middle; margin-right: 6px; border-radius: 1px; }
.tip .prev { color: var(--text-muted); margin-top: 6px; font-style: italic; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--grid); }
th { color: var(--text-secondary); font-weight: 600; font-size: 12px; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.barcell, th.barcell { width: 230px; }
/* Request text is free-form and long; cap it so one row cannot force the whole
   table into a horizontal scroll. The numbers beside it stay fully visible. */
td.prev, th.prev { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
tbody tr:hover { background: rgba(128,128,128,0.06); }
.bar { height: 8px; border-radius: 4px; min-width: 2px; }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; }
.method { color: var(--text-secondary); font-size: 13px; }
.method code { background: rgba(128,128,128,0.12); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
.method li { margin-bottom: 7px; }
.scroll { max-height: 460px; overflow: auto; }
.empty { color: var(--text-secondary); padding: 40px 0; text-align: center; }
`;
