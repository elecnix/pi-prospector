/**
 * The embedded client script for the viz page.
 *
 * Dependency-free vanilla JS, exported as one string constant so the renderer
 * can inline it into the self-contained HTML artifact. Everything interactive
 * the issue demands lives here: pan/zoom over the graph, click-a-node details,
 * proposal click-through onto anchored transcript messages, hover-an-edge kind
 * labels, node-kind / analyzer / retracted filters, collapsible revises
 * lineage, and depth-collapse.
 *
 * Written without template literals so it survives being embedded in one.
 */

export const VIZ_CLIENT_SCRIPT = String.raw`
"use strict";
var DATA = JSON.parse(document.getElementById("viz-data").textContent);

// ── layout constants ──
var COL_W = 260, ROW_H = 96, MSG_ROW_H = 74, CARD_W = 230, CARD_H = 78;

var NODE_KIND_COLORS = {
	metric: "#2a78d6", classification: "#eb6834", summary: "#1baf7a",
	validation: "#8e5bd6", error: "#d43d3d",
};

// ── columns ──
var analyzers = [];
DATA.nodes.forEach(function (n) { if (analyzers.indexOf(n.analyzerId) < 0) analyzers.push(n.analyzerId); });
analyzers.sort();

var COLUMN_OF = {};   // entityId -> {col,row}
function place(id, col, row) { COLUMN_OF[id] = { col: col, row: row }; }

DATA.messages.forEach(function (m, i) { place(m.id, 0, i); });
var colIndex = {};
analyzers.forEach(function (a, i) {
	colIndex[a] = i + 1;
	var rows = 0;
	DATA.nodes.forEach(function (n) { if (n.analyzerId === a) place(n.id, i + 1, rows++); });
});
var proposalCol = analyzers.length + 1;
var remediationCol = proposalCol + 1;
var auxCol = remediationCol + 1;
DATA.proposals.forEach(function (p, i) { place(p.id, proposalCol, i); });
DATA.remediations.forEach(function (r, i) { place(r.id, remediationCol, i); });

// auxiliary targets (session anchors, prompts, configs, assertions) stack in the last column
var AUX_IDS = [];
DATA.edges.forEach(function (e) {
	if (COLUMN_OF[e.toRefId] === undefined && e.toRefKind !== "analysis_node") {
		if (AUX_IDS.indexOf(e.toRefId) < 0) AUX_IDS.push(e.toRefId);
	}
});
AUX_IDS.forEach(function (id, i) { place(id, auxCol, i); });

function auxLabel(refKind, refId) {
	if (refKind === "session") return "session: " + DATA.session.id.slice(0, 12);
	if (refKind === "prompt_version") return "prompt: " + refId.slice(0, 10);
	if (refKind === "config_version") return "config: " + refId.slice(0, 10);
	if (refKind === "assertion") return "assertion: " + refId.slice(0, 10);
	return refKind + ": " + refId.slice(0, 10);
}

function posOf(entityId) {
	var c = COLUMN_OF[entityId];
	return { x: c.col * COL_W, y: 40 + c.row * (c.col === 0 ? MSG_ROW_H : ROW_H) };
}
function sizeOf(entityId) {
	var c = COLUMN_OF[entityId];
	if (c.col === 0) return { w: 200, h: MSG_ROW_H - 14 };
	if (c.col === proposalCol || c.col === remediationCol) return { w: CARD_W, h: CARD_H };
	if (c.col === auxCol) return { w: 190, h: 44 };
	return { w: 200, h: ROW_H - 20 };
}
var totalRows = Math.max(
	DATA.messages.length,
	Math.max.apply(null, [1].concat(Object.keys(COLUMN_OF).map(function (k) { return COLUMN_OF[k].row + 1; })))
);

// ── svg scaffolding ──
var NS = "http://www.w3.org/2000/svg";
var svg = document.getElementById("graph");
var viewport = document.getElementById("viewport");

function el(tag, attrs, parent) {
	var e = document.createElementNS(NS, tag);
	for (var k in attrs) e.setAttribute(k, attrs[k]);
	(parent || viewport).appendChild(e);
	return e;
}
function div(parent, cls, html) {
	var d = document.createElement("div");
	d.className = cls;
	if (html !== undefined) d.innerHTML = html;
	parent.appendChild(d);
	return d;
}
function wrap(s, n, maxLines) {
	if (!s) return [];
	var words = String(s).replace(/\s+/g, " ").trim().split(" ");
	var lines = [], line = "";
	for (var i = 0; i < words.length; i++) {
		while (words[i].length > n) {
			if (line) { lines.push(line); line = ""; }
			lines.push(words[i].slice(0, n)); words[i] = words[i].slice(n);
			if (lines.length >= maxLines) return lines;
		}
		if ((line + " " + words[i]).trim().length > n) { lines.push(line); line = words[i]; }
		else line = (line ? line + " " : "") + words[i];
		if (lines.length >= maxLines) return lines;
	}
	if (line && lines.length < maxLines) lines.push(line);
	return lines;
}
function textBlock(x, y, lines, parent, cls) {
	var t = el("text", { x: x + 8, y: y + 16, "class": cls || "label" }, parent);
	lines.forEach(function (ln, i) {
		var ts = document.createElementNS(NS, "tspan");
		ts.setAttribute("x", x + 8); ts.setAttribute("dy", i === 0 ? 0 : 13);
		ts.textContent = ln;
		t.appendChild(ts);
	});
	return t;
}

// ── state ──
var kindFilter = {}, analyzerFilter = {}, showRetracted = true, maxDepth = 0, collapseLineage = false;
var expandedGroups = {};
DATA.nodes.forEach(function (n) { kindFilter[n.nodeKind] = true; analyzerFilter[n.analyzerId] = true; if (n.depth > maxDepth) maxDepth = n.depth; });

// newest member per lineage group (the collapse keeps this visible)
var newestOfGroup = {};
DATA.lineageGroups.forEach(function (g) { newestOfGroup[g.index] = g.nodeIds[g.nodeIds.length - 1]; });

function hiddenReason(id) {
	var n = NODE_BY_ID[id];
	if (!n) return null;
	if (!kindFilter[n.nodeKind]) return "kind";
	if (!analyzerFilter[n.analyzerId]) return "analyzer";
	if (n.retractedAt && !showRetracted) return "retracted";
	if (n.depth > depthLimit()) return "depth";
	if (collapseLineage && n.lineageGroup !== null && expandedGroups[n.lineageGroup] !== true && id !== newestOfGroup[n.lineageGroup]) return "lineage";
	return null;
}
function depthLimit() { return Number(document.getElementById("depth-range").value); }
var NODE_BY_ID = {};
DATA.nodes.forEach(function (n) { NODE_BY_ID[n.id] = n; });

// ── draw nodes / cards / aux ──
var ENTITY = {};   // entityId -> its svg group
function drawBox(id, opts) {
	var p = posOf(id), s = sizeOf(id);
	var g = el("g", { "class": "entity " + (opts.cls || ""), "data-id": id });
	el("rect", { x: p.x, y: p.y, width: s.w, height: s.h, rx: 6 }, g);
	textBlock(p.x, p.y, wrap(opts.title, 26, 3), g, "title-label");
	if (opts.sub) textBlock(p.x, p.y + 42, wrap(opts.sub, 30, 2), g, "sub-label");
	ENTITY[id] = g;
	return g;
}

DATA.messages.forEach(function (m) {
	drawBox(m.id, {
		cls: "message" + (m.isError ? " msg-error" : "") + (m.role === "user" ? " msg-user" : ""),
		title: m.role + (m.isError ? "  ⚠" : "") + (m.timestamp ? "  " + m.timestamp.slice(11, 19) : ""),
		sub: m.text || m.toolCalls || "",
	});
});

DATA.nodes.forEach(function (n) {
	var g = drawBox(n.id, {
		cls: "node kind-" + n.nodeKind + (n.retractedAt ? " retracted" : ""),
		title: n.analyzerId + "\u00b7" + n.nodeKind + (n.retractedAt ? "  [retracted]" : "") + (n.lineageGroup !== null ? "  v" + n.lineageGroup : ""),
		sub: summarizeContent(n.content),
	});
	var s = sizeOf(n.id), p = posOf(n.id);
	var dot = el("circle", { cx: p.x + s.w - 12, cy: p.y + 12, r: 6, fill: NODE_KIND_COLORS[n.nodeKind] || "#888" }, g);
	g.addEventListener("click", function () { showNodeDetail(n.id); });
	void dot;
});

function summarizeContent(content) {
	if (content === null || content === undefined) return "";
	if (typeof content === "string") return content;
	try {
		var keys = Object.keys(content);
		var parts = keys.slice(0, 4).map(function (k) {
			var v = content[k];
			var sv = (typeof v === "string") ? v : JSON.stringify(v);
			if (sv && sv.length > 40) sv = sv.slice(0, 40) + "…";
			return k + "=" + sv;
		});
		return parts.join("  ");
	} catch (e) { return ""; }
}

DATA.proposals.forEach(function (p) {
	var g = drawBox(p.id, {
		cls: "proposal sev-" + p.severity,
		title: "[" + p.severity + "/" + p.status + "] " + p.title,
		sub: (p.validatedScore !== null ? "validated " + Math.round(p.validatedScore * 100) + "% · " : "unvalidated · ") + (p.confidence !== null ? "confidence " + p.confidence : ""),
	});
	g.addEventListener("click", function () { highlightEvidence(p.id); });
});

DATA.remediations.forEach(function (r) {
	var g = drawBox(r.id, {
		cls: "remediation",
		title: "remediation " + r.id.slice(0, 10),
		sub: r.description + "  (" + r.decisionInputKeys.length + " decisions)",
	});
});

AUX_IDS.forEach(function (id) {
	var refKind = "analysis_node";
	DATA.edges.forEach(function (e) { if (e.toRefId === id) refKind = e.toRefKind; });
	drawBox(id, { cls: "aux", title: auxLabel(refKind, id) });
});

// ── edges ──
var EDGE_ELS = [];
DATA.edges.forEach(function (e) {
	var from = COLUMN_OF[e.fromNodeId], to = COLUMN_OF[e.toRefId];
	if (!from || !to) return;
	var a = posOf(e.fromNodeId), sa = sizeOf(e.fromNodeId);
	var b = posOf(e.toRefId), sb = sizeOf(e.toRefId);
	var x1 = a.x + sa.w, y1 = a.y + sa.h / 2, x2 = b.x, y2 = b.y + sb.h / 2;
	var mx = (x1 + x2) / 2;
	var path = el("path", {
		d: "M" + x1 + " " + y1 + " C " + mx + " " + y1 + ", " + mx + " " + y2 + ", " + x2 + " " + y2,
		"class": "edge edge-" + e.edgeKind, fill: "none",
	}, viewport);
	path.setAttribute("data-from", e.fromNodeId);
	path.setAttribute("data-to", e.toRefId);
	path.setAttribute("data-kind", e.edgeKind);
	var tip = el("title", {}, path);
	tip.textContent = e.edgeKind + "  →  " + e.toRefKind + ":" + e.toRefId.slice(0, 16);
	path.addEventListener("mouseenter", function () {
		document.getElementById("statusbar").textContent = "edge: " + e.edgeKind + " (" + e.toRefKind + ")";
	});
	EDGE_ELS.push(path);
});

// remediation → proposal grouping links (distinct dashed layer)
DATA.remediations.forEach(function (r) {
	r.decisionInputKeys.forEach(function (key) {
		DATA.proposals.forEach(function (p) {
			if (p.inputKey !== key) return;
			var a = posOf(r.id), sa2 = sizeOf(r.id);
			var b = posOf(p.id);
			var mx = (a.x + b.x) / 2;
			el("path", {
				d: "M" + a.x + " " + (a.y + sa2.h / 2) + " C " + mx + " " + a.y + ", " + mx + " " + b.y + ", " + b.x + " " + (b.y + CARD_H / 2),
				"class": "edge remediation-link", fill: "none",
			});
		});
	});
});

// column headers
function header(colIdx, label) {
	var x = colIdx * COL_W;
	var t = el("text", { x: x + 8, y: 22, "class": "col-header" }, viewport);
	t.textContent = label;
}
header(0, "transcript");
analyzers.forEach(function (a) { header(colIndex[a], a); });
header(proposalCol, "proposals");
header(remediationCol, "remediations");
if (AUX_IDS.length > 0) header(auxCol, "references");

// ── visibility ──
function applyVisibility() {
	var shown = {};
	function showEntity(id) { shown[id] = true; }
	Object.keys(ENTITY).forEach(function (id) {
		var r = hiddenReason(id);
		ENTITY[id].style.display = r ? "none" : "";
		if (!r) showEntity(id);
	});
	EDGE_ELS.forEach(function (path) {
		var f = path.getAttribute("data-from"), t = path.getAttribute("data-to");
		var hide = !shown[f] || !(shown[t] || (COLUMN_OF[t] !== undefined && !hiddenReason(t)));
		path.style.display = hide ? "none" : "";
	});
	document.querySelectorAll(".lineage-note").forEach(function (n) { n.remove(); });
	DATA.lineageGroups.forEach(function (g) {
		var rep = NODE_BY_ID[newestOfGroup[g.index]];
		if (!rep || hiddenReason(rep.id)) return;
		var p = posOf(rep.id), s = sizeOf(rep.id);
		var note = el("text", { x: p.x, y: p.y + s.h + 14, "class": "lineage-note" }, viewport);
		note.textContent = (expandedGroups[g.index] ? "▾" : "▸") + " lineage: " + g.nodeIds.length + " versions (click)";
		note.addEventListener("click", function () {
			expandedGroups[g.index] = !expandedGroups[g.index];
			applyVisibility();
		});
	});
}

// ── detail panel ──
var detail = document.getElementById("detail");
function clearDetail() { while (detail.firstChild) detail.removeChild(detail.firstChild); }
function kv(label, value) { div(detail, "kv", "<span class=\"k\">" + esc(label) + "</span> " + esc(value)); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }

function showNodeDetail(id) {
	var n = NODE_BY_ID[id];
	clearDetail();
	div(detail, "panel-title", n.analyzerId + " · " + n.nodeKind + (n.retractedAt ? " (retracted " + n.retractedAt + ")" : ""));
	kv("created", n.createdAt);
	kv("input_key", n.inputKey);
	kv("output_key", n.outputKey);
	if (n.modelUsed) kv("model", n.modelUsed);
	if (n.costUsd !== null) kv("cost", "$" + n.costUsd);
	if (n.tokensUsed !== null) kv("tokens", n.tokensUsed);
	if (n.depth > 0) kv("consumes-depth", n.depth);
	div(detail, "section", "content");
	var pre = document.createElement("pre");
	pre.textContent = JSON.stringify(n.content, null, 2);
	detail.appendChild(pre);
	div(detail, "section", "outgoing edges");
	var out = DATA.edges.filter(function (e) { return e.fromNodeId === id; });
	if (out.length === 0) div(detail, "kv", "(none)");
	out.forEach(function (e) {
		var line = div(detail, "kv edge-row", "");
		line.innerHTML = "<span class=\"edge-kind\">" + esc(e.edgeKind) + "</span> → " + esc(e.toRefKind) + ":" + esc(String(e.toRefId).slice(0, 24));
		line.addEventListener("mouseenter", function () {
			document.getElementById("statusbar").textContent = "edge: " + e.edgeKind;
		});
	});
	hl([id], [], []);
}

// ── proposal evidence click-through ──
var HIGHLIGHT_CLASS = "hl";
var currentHl = [];
function hl(nodes, messages, edges) {
	currentHl.forEach(function (e) { e.classList.remove(HIGHLIGHT_CLASS); });
	currentHl = [];
	nodes.concat(messages).forEach(function (id) {
		var g = ENTITY[id];
		if (!g) return;
		g.classList.add(HIGHLIGHT_CLASS);
		currentHl.push(g);
	});
	EDGE_ELS.forEach(function (p) {
		var f = p.getAttribute("data-from"), t = p.getAttribute("data-to");
		if (nodes.indexOf(f) >= 0 && (nodes.indexOf(t) >= 0 || messages.indexOf(t) >= 0)) {
			p.classList.add(HIGHLIGHT_CLASS);
			currentHl.push(p);
		}
		void edges;
	});
}

function highlightEvidence(proposalId) {
	var p = PROPOSAL_BY_ID[proposalId];
	clearDetail();
	div(detail, "panel-title", "[" + p.severity + "/" + p.status + "] " + p.title);
	kv("target", p.targetType + (p.targetPath ? " " + p.targetPath : ""));
	kv("confidence", p.confidence === null ? "—" : p.confidence + (p.validatedScore !== null ? " (replay-validated: " + p.validatedScore + ")" : " (model-rated)"));
	kv("validation", p.validationStatus);
	kv("input_key", p.inputKey);
	div(detail, "section", "summary");
	div(detail, "kv", esc(p.summary));
	if (p.evidence) { div(detail, "section", "evidence"); div(detail, "kv", esc(p.evidence)); }
	div(detail, "section", "evidence trail (" + p.evidenceNodes.length + " nodes → " + p.evidenceMessages.length + " messages)");
	p.evidenceMessages.forEach(function (mid) {
		var m = MESSAGE_BY_ID[mid];
		if (m) div(detail, "kv ev-msg", esc(m.role + ": " + ((m.text || "").slice(0, 120))));
	});
	hl(p.evidenceNodes, p.evidenceMessages, []);
	// bring the first anchored message into view
	var first = p.evidenceMessages.map(function (m) { return ENTITY[m]; }).filter(Boolean)[0];
	if (first) centerOn(posOf(first.getAttribute("data-id")));
}
var PROPOSAL_BY_ID = {}, MESSAGE_BY_ID = {};
DATA.proposals.forEach(function (p) { PROPOSAL_BY_ID[p.id] = p; });
DATA.messages.forEach(function (m) { MESSAGE_BY_ID[m.id] = m; });

// also let raw message boxes show their text
Object.keys(ENTITY).forEach(function (id) {
	if (!MESSAGE_BY_ID[id]) return;
	ENTITY[id].addEventListener("click", function () {
		var m = MESSAGE_BY_ID[id];
		clearDetail();
		div(detail, "panel-title", m.role + (m.isError ? " ⚠" : ""));
		if (m.timestamp) kv("at", m.timestamp);
		var pre = document.createElement("pre");
		pre.textContent = m.text || m.toolCalls || "(empty)";
		detail.appendChild(pre);
	});
});

// ── pan / zoom ──
var view = { x: 40, y: 20, k: 0.9 };
function applyView() { viewport.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")"); }
applyView();
svg.addEventListener("wheel", function (ev) {
	ev.preventDefault();
	var factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
	factor = Math.max(0.2, Math.min(3, view.k * factor)) / view.k;
	view.k *= factor;
	var rect = svg.getBoundingClientRect();
	var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
	view.x = mx - (mx - view.x) * factor;
	view.y = my - (my - view.y) * factor;
	applyView();
}, { passive: false });
var dragging = false, dx = 0, dy = 0;
svg.addEventListener("mousedown", function (ev) { dragging = true; dx = ev.clientX - view.x; dy = ev.clientY - view.y; });
window.addEventListener("mousemove", function (ev) { if (dragging) { view.x = ev.clientX - dx; view.y = ev.clientY - dy; applyView(); } });
window.addEventListener("mouseup", function () { dragging = false; });
function centerOn(p) {
	var rect = svg.getBoundingClientRect();
	view.x = rect.width / 2 - (p.x + 100) * view.k;
	view.y = rect.height / 2 - p.y * view.k;
	applyView();
}

// ── controls ──
var kindsRow = document.getElementById("filter-kinds");
Object.keys(kindFilter).sort().forEach(function (k) {
	addCheckbox(kindsRow, k, true, function (on) { kindFilter[k] = on; applyVisibility(); }, NODE_KIND_COLORS[k]);
});
var anRow = document.getElementById("filter-analyzers");
analyzers.forEach(function (a) {
	addCheckbox(anRow, a, true, function (on) { analyzerFilter[a] = on; applyVisibility(); });
});
function addCheckbox(row, name, on, fn, color) {
	var lab = document.createElement("label");
	lab.className = "chk";
	var cb = document.createElement("input");
	cb.type = "checkbox"; cb.checked = on;
	cb.addEventListener("change", function () { fn(cb.checked); });
	lab.appendChild(cb);
	var sw = document.createElement("span");
	sw.className = "swatch";
	sw.style.background = color || "#777";
	lab.appendChild(sw);
	lab.appendChild(document.createTextNode(name));
	row.appendChild(lab);
}
document.getElementById("toggle-retracted").addEventListener("change", function (ev) { showRetracted = ev.target.checked; applyVisibility(); });
var range = document.getElementById("depth-range");
range.max = String(maxDepth);
range.value = String(maxDepth);
document.getElementById("depth-label").textContent = "depth ≤ " + range.value;
range.addEventListener("input", function () {
	document.getElementById("depth-label").textContent = "depth ≤ " + range.value;
	applyVisibility();
});
document.getElementById("toggle-lineage").addEventListener("change", function (ev) {
	collapseLineage = ev.target.checked;
	expandedGroups = {};
	applyVisibility();
});

applyVisibility();
`;
