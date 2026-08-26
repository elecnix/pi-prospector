/**
 * The viz renderer — one self-contained interactive HTML page per session.
 *
 * Pure function of the collected data: same DB, same bytes. No timestamp of
 * its own, no randomness, no network resources — the graph data rides along
 * as embedded JSON inside a `<script type="application/json">` element, so the
 * artifact is a single portable file that opens with no server and no access.
 * Rendering writes nothing back: the append-only invariant makes this a pure
 * read that is safe to repeat forever.
 */

import { VIZ_CLIENT_SCRIPT } from "./client-script.js";
import type { VizData } from "./types.js";

/** Embed JSON safely inside an inline script element. */
function embedJson(data: VizData): string {
	return JSON.stringify(data, null, 1).replace(/<\//g, "<\\/");
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f5f2; color: #222; }
header { padding: 8px 14px; border-bottom: 1px solid #d9d7d0; background: #fff; }
header h1 { font-size: 15px; margin: 0 0 4px; }
#controls { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; font-size: 12px; }
#controls .group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
#controls .group-label { font-weight: 600; opacity: 0.75; }
.chk { display: inline-flex; align-items: center; gap: 4px; }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
main { display: grid; grid-template-columns: 1fr 340px; height: calc(100vh - 96px); }
#graph-wrap { position: relative; overflow: hidden; border-right: 1px solid #d9d7d0; }
svg#graph { width: 100%; height: 100%; cursor: grab; user-select: none; }
.entity rect { fill: #fff; stroke: #b9b7b0; stroke-width: 1.2; }
.entity.message.msg-user rect { fill: #eef4fc; stroke: #2a78d6; }
.entity.message.msg-error rect { fill: #fdeeee; stroke: #d43d3d; stroke-dasharray: none; }
.entity.node rect { stroke-width: 1.4; }
.entity.retracted rect { stroke-dasharray: 5 3; opacity: 0.65; }
.entity.proposal rect { fill: #fffbe9; stroke: #b08c1e; }
.entity.remediation rect { fill: #f0eefb; stroke: #8e5bd6; stroke-width: 1.6; }
.entity.aux rect { fill: #f4f3ef; stroke-dasharray: 3 2; }
.label, .title-label, .sub-label { font-size: 11px; pointer-events: none; }
.title-label { font-weight: 600; fill: #333; }
.sub-label { fill: #666; }
.col-header { font-size: 13px; font-weight: 700; fill: #555; }
.edge { stroke: #a9a7a0; stroke-width: 1.1; }
.edge-anchors { stroke: #7fb069; }
.edge-consumes { stroke: #2a78d6; }
.edge-produces { stroke: #b08c1e; stroke-width: 1.6; }
.edge-revises { stroke: #8e5bd6; stroke-dasharray: 6 3; }
.edge-mutes { stroke: #d43d3d; stroke-dasharray: 2 3; }
.edge-uses_prompt, .edge-uses_config { stroke: #999; stroke-dasharray: 1 3; }
.edge.contrasts_with { stroke: #eb6834; stroke-dasharray: 4 4; }
.edge.remediation-link { stroke: #8e5bd6; stroke-width: 1.6; stroke-dasharray: 7 4; }
.hl rect, path.hl { stroke: #ff2f92; stroke-width: 3; filter: drop-shadow(0 0 4px #ff2f92); }
.hl rect { fill: #fff0f7 !important; }
.lineage-note { font-size: 11px; fill: #8e5bd6; cursor: pointer; }
#detail { overflow-y: auto; padding: 12px; font-size: 12px; background: #fff; }
.panel-title { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
.section { font-weight: 700; margin: 12px 0 4px; text-transform: uppercase; font-size: 10px; letter-spacing: 0.05em; opacity: 0.6; }
.kv { margin: 2px 0; word-break: break-all; line-height: 1.45; }
.kv .k { font-weight: 600; opacity: 0.7; }
.kv .edge-kind { background: #eee; padding: 1px 5px; border-radius: 3px; }
.ev-msg { background: #fdf2f9; padding: 2px 4px; border-radius: 3px; }
pre { background: #f4f3ef; padding: 8px; border-radius: 6px; overflow-x: auto; font-size: 11px; max-width: 100%; white-space: pre-wrap; }
#statusbar { position: absolute; bottom: 0; left: 0; right: 0; padding: 3px 10px; font-size: 11px; background: rgba(255,255,255,0.85); border-top: 1px solid #d9d7d0; min-height: 20px; }
@media (prefers-color-scheme: dark) {
	body { background: #1d1c19; color: #ddd; }
	header, #detail, .entity rect, #statusbar { background: #26251f; }
	.entity rect { fill: #26251f; stroke: #55534a; }
	header, #statusbar { border-color: #3a382f; }
	.entity.message.msg-user rect { fill: #20304a; }
	.entity.message.msg-error rect { fill: #46201f; }
	.entity.proposal rect { fill: #37301a; }
	.entity.remediation rect { fill: #2c2444; }
	.entity.aux rect { fill: #23221d; }
	pre { background: #17160f; }
	.col-header { fill: #aaa; } .title-label { fill: #ddd; } .sub-label { fill: #999; }
	.edge { stroke: #55534a; }
}
`;

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderVizHtml(data: VizData): string {
	const sessionLine = [
		data.session.name ?? data.session.id,
		data.session.source,
		data.session.project,
		`${data.messages.length} messages`,
		`${data.nodes.length} nodes`,
		`${data.edges.length} edges`,
		`${data.proposals.length} proposals`,
		`${data.remediations.length} remediations`,
	].filter(Boolean).join(" · ");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>prospect viz — ${esc(data.session.name ?? data.session.id)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
<h1>prospect viz — ${esc(sessionLine)}</h1>
<div id="controls">
  <div class="group"><span class="group-label">kind:</span><span id="filter-kinds" class="group"></span></div>
  <div class="group"><span class="group-label">analyzer:</span><span id="filter-analyzers" class="group"></span></div>
  <label class="chk"><input type="checkbox" id="toggle-retracted" checked> show retracted</label>
  <span class="chk"><label for="depth-range" id="depth-label">depth ≤ ∞</label><input type="range" id="depth-range" min="0" max="99" value="99"></span>
  <label class="chk"><input type="checkbox" id="toggle-lineage"> collapse revises lineage</label>
</div>
</header>
<main>
  <div id="graph-wrap">
    <svg id="graph" role="img" aria-label="analysis graph for ${esc(data.session.id)}"><g id="viewport"></g></svg>
    <div id="statusbar">drag to pan · wheel to zoom · click a node or proposal · hover an edge for its kind</div>
  </div>
  <aside id="detail"><div class="panel-title">session</div><div class="kv">${esc(data.session.id)}</div><div class="kv">${esc(data.session.cwd || data.session.project)}</div></aside>
</main>
<script id="viz-data" type="application/json">${embedJson(data)}</script>
<script>${VIZ_CLIENT_SCRIPT}</script>
</body>
</html>
`;
}

/** Deterministic artifact name for one session's page. */
export function vizFilename(sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return `prospect-viz-${safe}.html`;
}
