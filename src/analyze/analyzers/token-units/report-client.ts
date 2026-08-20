/**
 * The browser half of the HTML report, kept as a string so the rendered page is
 * a single portable file with nothing to fetch.
 *
 * It is a `.ts` module rather than a `.js` asset on purpose: an asset beside the
 * source would have to be copied by the build, and the first time someone ran
 * the compiled package the report would render blank. A string module is
 * compiled like any other code and cannot go missing.
 *
 * The text is a raw template literal, so it must contain no backtick and no
 * `${` sequence. The generator asserts both.
 */

export const REPORT_CLIENT_SCRIPT = String.raw`
/**
 * Client half of the token report. Everything here runs in the generated page.
 *
 * The page ships one flat fact table of leaves and builds every view from it in
 * the browser, so re-nesting the treemap is instant and no view can disagree
 * with another — they are folds of the same rows.
 */
(function () {
	"use strict";

	var D = JSON.parse(document.getElementById("payload").textContent);

	// Leaves arrive as tuples to keep the page small.
	var L_SOURCE = 0, L_PROJECT = 1, L_CLASS = 2, L_SESSION = 3, L_MODEL = 4, L_HOUR = 5, L_MITE = 6, L_CALLS = 7, L_PREVIEW = 8;

	var DIMS = {
		source: { label: "Agent", get: function (r) { return r[L_SOURCE]; } },
		project: { label: "Project", get: function (r) { return r[L_PROJECT]; } },
		class: { label: "Class", get: function (r) { return titleCase(r[L_CLASS]); } },
		session: { label: "Session", get: function (r) { return r[L_SESSION]; } },
		model: { label: "Model", get: function (r) { return r[L_MODEL]; } },
		hour: { label: "Hour", get: function (r) { return r[L_HOUR] === null ? "unknown" : pad(r[L_HOUR]) + ":00"; } },
	};

	var HIERARCHIES = [
		{ id: "spcs", dims: ["source", "project", "class", "session"] },
		{ id: "cspm", dims: ["class", "source", "project", "model"] },
		{ id: "pcsm", dims: ["project", "class", "session", "model"] },
		{ id: "mcps", dims: ["model", "class", "project", "session"] },
		{ id: "hcps", dims: ["hour", "class", "project", "session"] },
	];

	function pad(n) { return String(n).padStart(2, "0"); }
	function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

	function fmtMite(n) {
		if (n >= 100) return n.toFixed(0);
		if (n >= 10) return n.toFixed(1);
		if (n >= 1) return n.toFixed(2);
		return n.toFixed(3);
	}
	function fmtInt(n) { return Math.round(n).toLocaleString("en-US"); }
	function fmtCompact(n) {
		if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
		if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
		return String(Math.round(n));
	}
	function share(n) { return D.totals.mite > 0 ? ((100 * n) / D.totals.mite).toFixed(1) + "%" : "—"; }

	// ── theme ──

	function isDark() {
		var t = document.documentElement.getAttribute("data-theme");
		if (t === "dark") return true;
		if (t === "light") return false;
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	}
	var palette = function () { return isDark() ? D.palette.dark : D.palette.light; };

	document.getElementById("theme").addEventListener("click", function () {
		var next = isDark() ? "light" : "dark";
		document.documentElement.setAttribute("data-theme", next);
		render();
	});
	window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
		if (document.documentElement.getAttribute("data-theme") === "auto") render();
	});

	// ── grouping ──

	function buildTree(rows, dims) {
		var root = { name: "all", value: 0, calls: 0, children: [], depth: 0 };
		var index = new Map();
		for (var i = 0; i < rows.length; i++) {
			var row = rows[i];
			var node = root;
			root.value += row[L_MITE];
			root.calls += row[L_CALLS];
			var keyPath = "";
			for (var d = 0; d < dims.length; d++) {
				var name = DIMS[dims[d]].get(row);
				keyPath += " " + name;
				var child = index.get(keyPath);
				if (!child) {
					child = { name: name, value: 0, calls: 0, children: [], depth: d + 1, parent: node, sample: row };
					index.set(keyPath, child);
					node.children.push(child);
				}
				child.value += row[L_MITE];
				child.calls += row[L_CALLS];
				node = child;
			}
			node.leafRows = node.leafRows || [];
			node.leafRows.push(row);
		}
		sortTree(root);
		return root;
	}

	function sortTree(node) {
		node.children.sort(function (a, b) { return b.value - a.value; });
		for (var i = 0; i < node.children.length; i++) sortTree(node.children[i]);
	}

	function rollup(rows, dimKey) {
		var map = new Map();
		for (var i = 0; i < rows.length; i++) {
			var name = DIMS[dimKey].get(rows[i]);
			var e = map.get(name) || { name: name, value: 0, calls: 0 };
			e.value += rows[i][L_MITE];
			e.calls += rows[i][L_CALLS];
			map.set(name, e);
		}
		return Array.from(map.values()).sort(function (a, b) { return b.value - a.value; });
	}

	// ── squarified treemap ──

	function worstRatio(row, side, scale) {
		var sum = 0, min = Infinity, max = 0;
		for (var i = 0; i < row.length; i++) {
			var a = row[i].value * scale;
			sum += a;
			if (a < min) min = a;
			if (a > max) max = a;
		}
		if (sum <= 0 || side <= 0) return Infinity;
		return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
	}

	/** Assign each child a rect inside 'rect', keeping rects near-square. */
	function squarify(children, rect) {
		var out = [];
		var pending = children.filter(function (c) { return c.value > 0; });
		var total = pending.reduce(function (s, c) { return s + c.value; }, 0);
		if (total <= 0) return out;

		var r = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
		var remainingValue = total;

		while (pending.length > 0 && r.w > 0.5 && r.h > 0.5) {
			var side = Math.min(r.w, r.h);
			var scale = (r.w * r.h) / remainingValue;
			var row = [];
			var best = Infinity;
			while (pending.length > 0) {
				var candidate = row.concat([pending[0]]);
				var ratio = worstRatio(candidate, side, scale);
				if (row.length === 0 || ratio <= best) {
					best = ratio;
					row = candidate;
					pending.shift();
				} else break;
			}

			var rowSum = row.reduce(function (s, c) { return s + c.value; }, 0);
			var frac = rowSum / remainingValue;
			var i, acc;
			if (r.w >= r.h) {
				var rw = r.w * frac;
				acc = r.y;
				for (i = 0; i < row.length; i++) {
					var nh = r.h * (row[i].value / rowSum);
					out.push({ node: row[i], x: r.x, y: acc, w: rw, h: nh });
					acc += nh;
				}
				r = { x: r.x + rw, y: r.y, w: r.w - rw, h: r.h };
			} else {
				var rh = r.h * frac;
				acc = r.x;
				for (i = 0; i < row.length; i++) {
					var nw = r.w * (row[i].value / rowSum);
					out.push({ node: row[i], x: acc, y: r.y, w: nw, h: rh });
					acc += nw;
				}
				r = { x: r.x, y: r.y + rh, w: r.w, h: r.h - rh };
			}
			remainingValue -= rowSum;
			if (remainingValue <= 0) break;
		}
		return out;
	}

	/**
	 * Fold the tail of a child list into one "Other" square.
	 *
	 * Unsteered extraction names classes per session, so a day carries hundreds of
	 * them and many are near-synonyms. Drawn literally that is confetti: squares
	 * too small to label, read, or hit. Folding is a *rendering* decision — the
	 * class tables below still list every one — and it is applied per container,
	 * so a small branch keeps its detail instead of being folded by a global rank.
	 */
	var MIN_LEAF_AREA = 420; // px², roughly the smallest square that can hold a label
	var MAX_CHILDREN = 14;

	function foldTail(children, rect) {
		if (children.length <= 1) return children;
		var area = Math.max(rect.w, 0) * Math.max(rect.h, 0);
		var total = children.reduce(function (s, c) { return s + c.value; }, 0);
		if (total <= 0 || area <= 0) return children;

		var kept = [];
		var folded = [];
		for (var i = 0; i < children.length; i++) {
			var projected = (children[i].value / total) * area;
			if (kept.length < MAX_CHILDREN && projected >= MIN_LEAF_AREA) kept.push(children[i]);
			else folded.push(children[i]);
		}
		// Folding one child into "Other" trades a real name for a vague one.
		if (folded.length < 2 || kept.length === 0) return children;

		var sum = folded.reduce(function (s, c) { return s + c.value; }, 0);
		var calls = folded.reduce(function (s, c) { return s + c.calls; }, 0);
		kept.push({
			name: folded.length + " smaller",
			value: sum,
			calls: calls,
			children: [],
			depth: children[0].depth,
			parent: children[0].parent,
			isOther: true,
			foldedNames: folded.slice(0, 8).map(function (c) { return c.name; }),
			foldedCount: folded.length,
		});
		return kept;
	}

	// ── colour ──

	/**
	 * Hue carries identity only when it can carry it for *every* branch.
	 *
	 * A treemap sets arbitrary rectangles side by side, so it is an all-pairs
	 * form, and only three hues clear the colourblind and normal-vision floors in
	 * both modes — a fourth seats yellow beside orange and fails. So three or
	 * fewer top-level branches each get a hue. Past that, hue is abandoned rather
	 * than faked: three coloured branches beside a gray tail reads as a meaningful
	 * grouping when it only means "the three biggest". With one hue, identity
	 * comes from the labels and the area, as on any single-series chart.
	 */
	var HUE_SLOTS = 3;

	function useHues(topLevel) { return topLevel.length <= HUE_SLOTS; }

	function assignColours(topLevel) {
		var p = palette();
		var map = new Map();
		var hues = useHues(topLevel);
		for (var i = 0; i < topLevel.length; i++) {
			map.set(topLevel[i].name, hues ? p.series[i] : p.series[0]);
		}
		return map;
	}

	function hexToRgb(hex) {
		var n = parseInt(hex.slice(1), 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
	function rgba(hex, a) {
		var c = hexToRgb(hex);
		return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
	}
	/** Ink or white on a filled mark, whichever clears contrast on that fill. */
	function inkOn(hex) {
		var c = hexToRgb(hex);
		var lin = c.map(function (v) { var s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
		var lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
		return lum > 0.45 ? "#0b0b0b" : "#ffffff";
	}

	// ── treemap render ──

	var SVG_NS = "http://www.w3.org/2000/svg";
	var GAP = 2;
	var HEADER = 17;
	var CHAR_W = 6.1;

	function svgEl(name, attrs) {
		var e = document.createElementNS(SVG_NS, name);
		for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
		return e;
	}

	function fits(text, w, size) { return text.length * (size / 11) * CHAR_W + 10 <= w; }

	function truncateTo(text, w, size) {
		var max = Math.floor((w - 10) / ((size / 11) * CHAR_W));
		if (max >= text.length) return text;
		if (max < 4) return null;
		return text.slice(0, max - 1) + "…";
	}

	function renderTreemap(root, colours) {
		var svg = document.getElementById("treemap");
		while (svg.firstChild) svg.removeChild(svg.firstChild);

		var width = svg.clientWidth || svg.parentNode.clientWidth || 900;
		var height = parseInt(getComputedStyle(svg).height, 10) || 620;
		svg.setAttribute("viewBox", "0 0 " + width + " " + height);

		if (!root.children.length || root.value <= 0) {
			var msg = svgEl("text", { x: width / 2, y: height / 2, "text-anchor": "middle", fill: "var(--text-secondary)", "font-size": 13 });
			msg.textContent = "No spend recorded for this day.";
			svg.appendChild(msg);
			return;
		}

		var full = { x: 0, y: 0, w: width, h: height };
		var placed = squarify(foldTail(root.children, full), full);
		for (var i = 0; i < placed.length; i++) {
			drawNode(svg, placed[i], colours.get(placed[i].node.name) || palette().other, 1);
		}
	}

	function drawNode(parent, box, colour, level) {
		var node = box.node;
		var x = box.x + GAP / 2, y = box.y + GAP / 2;
		var w = Math.max(0, box.w - GAP), h = Math.max(0, box.h - GAP);
		if (w <= 0.5 || h <= 0.5) return;

		var isLeaf = node.children.length === 0;
		var g = svgEl("g", isLeaf ? { class: "leaf", tabindex: "0", role: "listitem" } : {});

		// Depth reads as a lighter step of the branch's own colour. That ramp is
		// ordered by nesting level, never by value — area already carries value.
		// A folded square is not an entity, so it wears the de-emphasis gray.
		var ownColour = node.isOther ? palette().other : colour;
		var fill = isLeaf ? ownColour : rgba(ownColour, Math.min(0.08 + 0.06 * level, 0.28));
		var rect = svgEl("rect", { x: x, y: y, width: w, height: h, rx: Math.min(4, w / 2, h / 2), fill: fill });
		g.appendChild(rect);

		if (isLeaf) {
			g.appendChild(makeTitle(node));
			attachHover(g, node, ownColour);
			labelLeaf(g, node, x, y, w, h, ownColour);
			parent.appendChild(g);
			return;
		}

		// A container gets a header band only when its label can sit in it without
		// stealing the room its children need.
		var headerShown = h > HEADER + 14 && w > 46;
		if (headerShown) {
			var label = truncateTo(node.name, w - 46, 11);
			if (label) {
				var t = svgEl("text", { x: x + 6, y: y + 12, "font-size": 11, "font-weight": "600", fill: "var(--text-primary)" });
				t.textContent = label;
				g.appendChild(t);
				var v = fmtMite(node.value);
				if (fits(label + v, w - 12, 11)) {
					var tv = svgEl("text", { x: x + w - 6, y: y + 12, "font-size": 10, "text-anchor": "end", fill: "var(--text-secondary)" });
					tv.textContent = v;
					g.appendChild(tv);
				}
			}
		}

		var inner = {
			x: x + 2,
			y: y + (headerShown ? HEADER : 2),
			w: w - 4,
			h: h - (headerShown ? HEADER + 2 : 4),
		};
		parent.appendChild(g);
		if (inner.w <= 1 || inner.h <= 1) return;

		var kids = squarify(foldTail(node.children, inner), inner);
		for (var i = 0; i < kids.length; i++) drawNode(parent, kids[i], colour, level + 1);
	}

	function makeTitle(node) {
		var title = svgEl("title");
		title.textContent = pathOf(node) + " — " + fmtMite(node.value) + " MITE";
		return title;
	}

	function labelLeaf(g, node, x, y, w, h, colour) {
		var ink = inkOn(colour);
		var name = truncateTo(node.name, w, 11);
		if (!name || h < 16) return;
		var t = svgEl("text", { x: x + 6, y: y + 13, "font-size": 11, "font-weight": "500", fill: ink });
		t.textContent = name;
		g.appendChild(t);
		var value = fmtMite(node.value);
		if (h >= 30 && fits(value, w, 10)) {
			var tv = svgEl("text", { x: x + 6, y: y + 26, "font-size": 10, fill: ink, opacity: "0.78" });
			tv.textContent = value;
			g.appendChild(tv);
		}
	}

	function pathOf(node) {
		var parts = [];
		var n = node;
		while (n && n.depth > 0) { parts.unshift(n.name); n = n.parent; }
		return parts.join("  ›  ");
	}

	// ── tooltip ──

	var tip = document.getElementById("tip");

	function attachHover(g, node, colour) {
		function show(evt) {
			while (tip.firstChild) tip.removeChild(tip.firstChild);

			var v = document.createElement("div");
			v.className = "v";
			v.textContent = fmtMite(node.value) + " MITE";
			tip.appendChild(v);

			var p = document.createElement("div");
			p.className = "path";
			var key = document.createElement("span");
			key.className = "key";
			key.style.background = colour;
			p.appendChild(key);
			p.appendChild(document.createTextNode(pathOf(node)));
			tip.appendChild(p);

			var meta = document.createElement("div");
			meta.textContent = share(node.value) + " of the day · " + fmtInt(node.calls) + " calls";
			tip.appendChild(meta);

			if (node.isOther) {
				var fold = document.createElement("div");
				fold.className = "prev";
				fold.textContent =
					"Folded to keep the diagram readable: " + node.foldedNames.join(", ") +
					(node.foldedCount > node.foldedNames.length ? ", and " + (node.foldedCount - node.foldedNames.length) + " more" : "") +
					". All of them are listed in the tables below.";
				tip.appendChild(fold);
			}

			var rows = node.leafRows || [];
			if (rows.length && rows[0][L_PREVIEW]) {
				var pv = document.createElement("div");
				pv.className = "prev";
				pv.textContent = "“" + rows[0][L_PREVIEW] + "”";
				tip.appendChild(pv);
			}

			tip.style.opacity = "1";
			position(evt);
		}
		function position(evt) {
			var pt = evt.touches ? evt.touches[0] : evt;
			var cx = pt && pt.clientX !== undefined ? pt.clientX : 0;
			var cy = pt && pt.clientY !== undefined ? pt.clientY : 0;
			if (!pt || pt.clientX === undefined) {
				var b = g.getBoundingClientRect();
				cx = b.left + b.width / 2;
				cy = b.top;
			}
			var r = tip.getBoundingClientRect();
			var left = Math.min(cx + 14, window.innerWidth - r.width - 12);
			var top = Math.max(10, Math.min(cy + 14, window.innerHeight - r.height - 12));
			tip.style.left = left + "px";
			tip.style.top = top + "px";
		}
		function hide() { tip.style.opacity = "0"; }

		g.addEventListener("pointerenter", show);
		g.addEventListener("pointermove", position);
		g.addEventListener("pointerleave", hide);
		g.addEventListener("focus", show);
		g.addEventListener("blur", hide);
	}

	// ── tables ──

	function tableInto(el, columns, rows) {
		while (el.firstChild) el.removeChild(el.firstChild);
		var thead = document.createElement("thead");
		var htr = document.createElement("tr");
		columns.forEach(function (c) {
			var th = document.createElement("th");
			if (c.num) th.className = "num";
			if (c.cls) th.className = c.cls;
			th.textContent = c.label;
			htr.appendChild(th);
		});
		thead.appendChild(htr);
		el.appendChild(thead);

		var tbody = document.createElement("tbody");
		rows.forEach(function (r) {
			var tr = document.createElement("tr");
			columns.forEach(function (c) {
				var td = document.createElement("td");
				if (c.num) td.className = "num";
				if (c.cls) td.className = c.cls;
				var v = c.get(r);
				if (v instanceof Node) td.appendChild(v);
				else td.textContent = v;
				tr.appendChild(td);
			});
			tbody.appendChild(tr);
		});
		el.appendChild(tbody);
	}

	function barCell(value, max, colour) {
		var wrap = document.createElement("div");
		var bar = document.createElement("div");
		bar.className = "bar";
		bar.style.width = Math.max(2, (100 * value) / (max || 1)) + "%";
		bar.style.background = colour;
		wrap.appendChild(bar);
		return wrap;
	}

	function renderTables() {
		var p = palette();

		var classes = rollup(D.leaves, "class");
		var maxClass = classes.length ? classes[0].value : 1;
		tableInto(document.getElementById("classTable"), [
			{ label: "Class", get: function (r) { return r.name; } },
			{ label: "", cls: "barcell", get: function (r) { return barCell(r.value, maxClass, r.name === "Unclassified" ? p.other : p.series[0]); } },
			{ label: "MITE", num: true, get: function (r) { return fmtMite(r.value); } },
			{ label: "Share", num: true, get: function (r) { return share(r.value); } },
			{ label: "Calls", num: true, get: function (r) { return fmtInt(r.calls); } },
		], classes);

		var host = document.getElementById("dimTables");
		while (host.firstChild) host.removeChild(host.firstChild);
		[["model", "Model"], ["project", "Project"], ["hour", "Hour of day"]].forEach(function (spec, idx) {
			var rows = rollup(D.leaves, spec[0]);
			if (spec[0] === "hour") rows.sort(function (a, b) { return a.name.localeCompare(b.name); });
			var max = rows.reduce(function (m, r) { return Math.max(m, r.value); }, 1);
			var h = document.createElement("h3");
			h.style.cssText = "font-size:13px;font-weight:600;margin:" + (idx ? "22px" : "0") + " 0 8px";
			h.textContent = spec[1];
			host.appendChild(h);
			var t = document.createElement("table");
			host.appendChild(t);
			tableInto(t, [
				{ label: spec[1], get: function (r) { return r.name; } },
				{ label: "", cls: "barcell", get: function (r) { return barCell(r.value, max, p.series[idx % 3]); } },
				{ label: "MITE", num: true, get: function (r) { return fmtMite(r.value); } },
				{ label: "Share", num: true, get: function (r) { return share(r.value); } },
			], rows);
		});

		var leafRows = D.leaves.slice().sort(function (a, b) { return b[L_MITE] - a[L_MITE]; }).slice(0, 400);
		var cols = [
			{ label: "Agent", get: function (r) { return DIMS.source.get(r); } },
			{ label: "Project", get: function (r) { return r[L_PROJECT]; } },
			{ label: "Class", get: function (r) { return titleCase(r[L_CLASS]); } },
			{ label: "Model", get: function (r) { return r[L_MODEL]; } },
			{ label: "Hour", num: true, get: function (r) { return DIMS.hour.get(r); } },
			{ label: "MITE", num: true, get: function (r) { return fmtMite(r[L_MITE]); } },
			{ label: "Calls", num: true, get: function (r) { return fmtInt(r[L_CALLS]); } },
		];
		if (D.leaves.some(function (r) { return r[L_PREVIEW]; })) {
			cols.push({ label: "Request", cls: "prev", get: function (r) { return r[L_PREVIEW]; } });
		}
		tableInto(document.getElementById("leafTable"), cols, leafRows);
	}

	// ── header, legend, method ──

	function renderHeader() {
		var t = D.totals;
		document.getElementById("heroValue").textContent = fmtMite(t.mite);
		document.getElementById("subtitle").textContent =
			D.day + " · local time · generated " + new Date(D.generatedAt).toLocaleString();

		var raw = t.input + t.output + t.cacheRead + t.cacheWrite;
		document.getElementById("heroNote").textContent =
			"one MITE = a million input-token equivalents — " + fmtCompact(raw) + " raw tokens over " +
			fmtInt(t.calls) + " billed calls in " + D.sessionsWithSpend + " sessions";

		var cacheShare = raw > 0 ? ((100 * t.cacheRead) / raw).toFixed(0) + "%" : "—";
		var classes = rollup(D.leaves, "class");
		var top = classes.length ? classes[0] : null;

		var kpis = [
			{ label: "Output tokens", value: fmtCompact(t.output), foot: "×" + D.weights.output + " — " + fmtMite((t.output * D.weights.output) / D.equivalentsPerMite) + " MITE" },
			{ label: "Fresh input", value: fmtCompact(t.input), foot: "×1 — " + fmtMite(t.input / D.equivalentsPerMite) + " MITE" },
			{ label: "Cache reads", value: fmtCompact(t.cacheRead), foot: "×" + D.weights.cache_read + " — " + cacheShare + " of raw tokens" },
			{ label: "Busiest class", value: top ? fmtMite(top.value) : "—", foot: top ? top.name : "" },
			{ label: "Classified", value: D.sessionsWithSpend ? Math.round((100 * D.classifiedSessions) / D.sessionsWithSpend) + "%" : "—", foot: D.classifiedSessions + " of " + D.sessionsWithSpend + " sessions" },
		];
		var host = document.getElementById("kpis");
		while (host.firstChild) host.removeChild(host.firstChild);
		kpis.forEach(function (k) {
			var d = document.createElement("div");
			d.className = "kpi";
			["label", "value", "foot"].forEach(function (cls) {
				var e = document.createElement("div");
				e.className = cls;
				e.textContent = k[cls];
				d.appendChild(e);
			});
			host.appendChild(d);
		});
	}

	function renderLegend(topLevel, colours) {
		var host = document.getElementById("legend");
		while (host.firstChild) host.removeChild(host.firstChild);

		// One hue means one series: a legend box with a single swatch would only
		// restate the heading, so the outermost group is named in words instead.
		if (!useHues(topLevel)) {
			var note = document.createElement("span");
			note.className = "item";
			note.textContent =
				topLevel.length + " " + currentTopLabel().toLowerCase() + " groups — too many for colour to tell apart, so each is named in place. Area is MITE.";
			host.appendChild(note);
			return;
		}
		topLevel.forEach(function (n) {
			host.appendChild(legendItem(colours.get(n.name), n.name + " · " + fmtMite(n.value)));
		});
	}

	function currentTopLabel() {
		var h = HIERARCHIES[parseInt(hierSelect.value, 10) || 0];
		return DIMS[h.dims[0]].label;
	}

	function legendItem(colour, text) {
		var item = document.createElement("span");
		item.className = "item";
		var sw = document.createElement("span");
		sw.className = "swatch";
		sw.style.background = colour;
		item.appendChild(sw);
		item.appendChild(document.createTextNode(text));
		return item;
	}

	function renderMethod() {
		var w = D.weights;
		var items = [
			"<strong>The unit.</strong> One <strong>MITE</strong> is a million input-token equivalents. An input token counts 1, an output token " + w.output + ", a cache-read token " + w.cache_read + ", and a cache-write token " + w.cache_write + ". The first three rates were set by the operator; the cache-write rate is the conventional 1.25× and is the one assumption here.",
			"<strong>Why not dollars.</strong> Claude Code records no per-message cost, and pi records one only for routes that priced the call, so a dollar report would quietly omit most of the corpus. MITE is computable everywhere.",
			"<strong>One call counted once.</strong> Claude Code writes a transcript line per content block, each repeating the same <code>usage</code>. Calls are folded by the provider's own message id, so a response split across five lines counts once — without this the Claude totals run 2.1× high.",
			"<strong>Classes are the model's own words.</strong> No taxonomy was supplied: the model was asked to name a set of classes describing the request types it saw, and to say which requests belong to each. Near-synonyms from different sessions stay separate, because merging them would need the steering the extraction avoids.",
			"<strong>Splitting.</strong> A request in several classes divides its spend evenly among them, so class totals still add to the day total. Spend attaches to the request segment that caused it — a user turn plus every call answering it.",
			"<strong>Days are local.</strong> Each call is bucketed by its own local calendar day, so a session running past midnight is split across both days rather than assigned to the one it started in.",
		];
		if (D.unclassifiedMite > 0) {
			items.push("<strong>Unclassified.</strong> " + share(D.unclassifiedMite) + " of the day carries no class — session preamble before the first request, or a session not yet run through the class analyzer.");
		}
		if (D.truncatedRequests > 0) {
			items.push("<strong>Truncation.</strong> " + D.truncatedRequests + " request(s) past the per-session cap were not classified; their spend shows as unclassified.");
		}
		if (D.coverage.callsWithoutUsage > 0) {
			items.push("<strong>Coverage.</strong> " + D.coverage.callsWithoutUsage + " of " + fmtInt(D.totals.calls + D.coverage.callsWithoutUsage) + " calls recorded no usage at all. They are counted as unknown, never as zero, so the total is a lower bound.");
		}
		if (D.coverage.rowsWithoutKey > 0) {
			items.push("<strong>Older rows.</strong> " + D.coverage.rowsWithoutKey + " row(s) predate the de-duplication key and fall back to their own id; those may still be over-counted.");
		}
		var ul = document.createElement("ul");
		ul.style.cssText = "margin:0;padding-left:18px";
		items.forEach(function (html) {
			var li = document.createElement("li");
			li.innerHTML = html; // fixed strings assembled above; no data is interpolated as markup
			ul.appendChild(li);
		});
		var host = document.getElementById("method");
		while (host.firstChild) host.removeChild(host.firstChild);
		host.appendChild(ul);
	}

	// ── wiring ──

	var hierSelect = document.getElementById("hier");
	var depthSelect = document.getElementById("depth");

	HIERARCHIES.forEach(function (h, i) {
		var opt = document.createElement("option");
		opt.value = String(i);
		opt.textContent = h.dims.map(function (d) { return DIMS[d].label; }).join(" → ");
		hierSelect.appendChild(opt);
	});

	function render() {
		var h = HIERARCHIES[parseInt(hierSelect.value, 10) || 0];
		var depth = parseInt(depthSelect.value, 10) || 3;
		var root = buildTree(D.leaves, h.dims.slice(0, depth));
		var colours = assignColours(root.children);
		renderLegend(root.children, colours);
		renderTreemap(root, colours);
		renderTables();
	}

	hierSelect.addEventListener("change", render);
	depthSelect.addEventListener("change", render);
	var resizeTimer = null;
	window.addEventListener("resize", function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(render, 120);
	});

	renderHeader();
	renderMethod();
	render();
})();
`;
