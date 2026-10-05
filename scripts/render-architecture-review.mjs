// Render docs/architecture-review.html from its authoring source into a
// self-contained artifact with no network at all.
//
// Why: the review is a tracked file that anyone may open in a browser. Loading
// Tailwind and Mermaid from CDNs means opening it executes code this repository
// does not control, with no integrity hash and no version pin available for the
// Tailwind Play CDN. This script bakes both down at authoring time instead —
// the generated CSS is inlined and each Mermaid diagram becomes static SVG — so
// the committed artifact renders identically, forever, offline.
//
// The authoring source keeps the CDN scripts and the Mermaid diagram source, so
// a diagram is still edited as Mermaid text. This script is the build step:
// edit the source, re-run it, commit both files.
//
// Requires a Chrome/Chromium binary for headless rendering.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC = "docs/architecture-review.src.html";
const OUT = "docs/architecture-review.html";

const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"google-chrome",
	"chromium",
	"chromium-browser",
].filter(Boolean);

/** First Chrome binary that answers --version, or null. */
function findChrome() {
	for (const bin of CHROME_CANDIDATES) {
		try {
			execFileSync(bin, ["--version"], { stdio: "ignore" });
			return bin;
		} catch {
			// next candidate
		}
	}
	return null;
}

const chrome = findChrome();
if (!chrome) {
	console.error(`No Chrome binary found. Set CHROME_PATH, or install one of: ${CHROME_CANDIDATES.join(", ")}`);
	process.exit(1);
}

const source = readFileSync(SRC, "utf8");

// The authoring source renders its own Tailwind + Mermaid. We append a probe
// that, once the page has settled, serialises every computed stylesheet and
// every rendered diagram into the DOM base64-encoded, so --dump-dom can carry
// them out without HTML-escaping ambiguity.
const probe = `
<script type="module">
	window.addEventListener("load", () => setTimeout(() => {
		const css = Array.from(document.styleSheets)
			.flatMap((sheet) => {
				try {
					return Array.from(sheet.cssRules, (r) => r.cssText);
				} catch {
					return []; // cross-origin sheet we cannot read
				}
			})
			.join("\\n");
		const svgs = Array.from(document.querySelectorAll('svg[id^="mermaid"]')).map((s) => s.outerHTML);
		const enc = (v) => btoa(unescape(encodeURIComponent(v)));
		document.body.innerHTML =
			'<pre id="__CSS__">' + enc(css) + '</pre>' +
			'<pre id="__SVG__">' + enc(JSON.stringify(svgs)) + '</pre>';
	}, 4000));
</script>
`;

const dir = mkdtempSync(join(tmpdir(), "arch-review-"));
try {
	// The probe closes the document, so it goes after the LAST </body>. Splicing
	// at the first one — which is what String.replace with a string pattern
	// does — would truncate the real body if the source ever contained that
	// literal text earlier, e.g. inside a code sample or a comment, and the
	// render would then fail with a probe error naming neither cause.
	const bodyClose = source.lastIndexOf("</body>");
	if (bodyClose === -1) {
		throw new Error(`${SRC} has no </body> — the probe cannot be appended`);
	}
	const probePage = join(dir, "probe.html");
	writeFileSync(probePage, `${source.slice(0, bodyClose)}${probe}${source.slice(bodyClose)}`);

	const dom = execFileSync(
		chrome,
		[
			"--headless",
			"--disable-gpu",
			"--no-sandbox",
			"--virtual-time-budget=30000",
			"--dump-dom",
			`file://${probePage}`,
		],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
	);

	const pick = (id) => {
		const m = dom.match(new RegExp(`<pre id="${id}">([A-Za-z0-9+/=]*)</pre>`));
		if (!m) throw new Error(`probe produced no ${id} — the authoring source may not have finished rendering`);
		return Buffer.from(m[1], "base64").toString("utf8");
	};

	const css = pick("__CSS__");
	let svgs;
	try {
		svgs = JSON.parse(pick("__SVG__"));
	} catch (cause) {
		// JSON.parse throws a SyntaxError in practice, but naming the cause is
		// the whole point of this message, so do not assume it is an Error.
		const why = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`probe payload in __SVG__ is not valid JSON (${why}) — the probe did not finish rendering`);
	}
	if (!Array.isArray(svgs)) {
		throw new Error("probe payload in __SVG__ is not an array of diagrams");
	}

	// One pattern, shared by the count and the replacement below, so the two
	// cannot disagree about how many figures there are. An earlier version
	// counted `/<pre class="mermaid">/g` but replaced with a pattern that also
	// required a newline, so a source whose block differed in whitespace passed
	// the guard and then spliced `undefined` into the page as a figure.
	const MERMAID_BLOCK = /<pre class="mermaid">[\s\S]*?<\/pre>/g;

	// Every diagram in the source must have rendered, or we would silently ship
	// a file with a missing figure.
	const declared = (source.match(MERMAID_BLOCK) ?? []).length;
	if (svgs.length !== declared) {
		throw new Error(`source declares ${declared} diagram(s) but ${svgs.length} rendered — fix the Mermaid source first`);
	}

	// Drop the two CDN script tags; carry the custom layer and the generated
	// Tailwind CSS in one <style> instead.
	const customLayerMatch = source.match(/<style>[\s\S]*?<\/style>/);
	if (!customLayerMatch) {
		throw new Error(`authoring source has no <style> block — ${SRC} must keep its custom CSS layer`);
	}
	const customLayer = customLayerMatch[0];
	const customCss = customLayer.replace(/<\/?style>/g, "");

	const withoutScripts = source
		.replace(/<script src="https:\/\/cdn\.tailwindcss\.com"><\/script>\s*/g, "")
		.replace(/<script type="module">[\s\S]*?<\/script>\s*/g, "");

	// The custom <style> block is what marks where the generated CSS goes, and
	// String.replace with a string needle does nothing at all when the needle
	// is gone. Since the script stripping above runs regexes over this same
	// region of the file, assert the marker survived before relying on it —
	// otherwise the artifact ships with the source's own style layer and none
	// of the generated Tailwind, and still exits 0.
	if (!withoutScripts.includes(customLayer)) {
		throw new Error("script stripping consumed the custom <style> block — the generated CSS cannot be spliced in");
	}

	let out = withoutScripts.replace(customLayer, `<style>\n/* Generated by scripts/render-architecture-review.mjs — do not edit by hand. */\n${css}\n</style>`);

	// Replace each Mermaid block, in order, with its rendered SVG. The Mermaid
	// text is NOT carried into the output: it still lives in the authoring
	// source, and it contains `-->`, which would close an HTML comment early
	// and spill diagram source into the rendered page.
	let fig = 0;
	// The count above is taken from the source; the replacement runs on `out`,
	// which is the source minus its scripts and with the style layer swapped.
	// Comparing the two makes an honest statement of what is being replaced,
	// and keeps the leftover check below meaningful rather than unreachable.
	const blocks = out.match(MERMAID_BLOCK) ?? [];
	if (blocks.length !== declared) {
		throw new Error(`source declares ${declared} diagram(s) but ${blocks.length} survive into the output — a script or style replacement consumed one`);
	}
	out = out.replace(MERMAID_BLOCK, () => {
		const svg = svgs.shift();
		fig += 1;
		if (!svg) {
			throw new Error(`figure ${fig} has no rendered SVG — the render pass produced fewer than the ${declared} declared`);
		}
		return `<div class="mermaid">${svg}</div>`;
	});
	if (svgs.length > 0) {
		throw new Error(`${svgs.length} rendered SVG(s) had no matching block in the output — the replacement consumed fewer figures than were rendered`);
	}

	// Mermaid stamps each render with a fresh id (mermaid-<epoch-ms>) and
	// references it from the SVG's own CSS, its marker urls, its aria wiring,
	// and a page-level stylesheet. Left alone, every regeneration rewrites
	// those ids and the tracked artifact shows a diff that changes nothing.
	// Renumber them per figure, everywhere at once — the page-level stylesheet
	// is the reason this runs over `out` rather than over each SVG. The number
	// must stay unique per figure: each SVG carries its own `#mermaid-N { ... }`
	// rules, so a collision would silently restyle one figure with the other.
	const idMap = new Map();

	out = out.replace(/\bmermaid-(\d+)/g, (match, stamp) => {
		if (!idMap.has(stamp)) idMap.set(stamp, idMap.size + 1);
		return `mermaid-${idMap.get(stamp)}`;
	});

	if (out.includes("<script")) {
		throw new Error("output still contains a script tag — the artifact must not execute anything");
	}
	if (/<(link|img)[^>]+href="http/i.test(out)) {
		throw new Error("output still references a remote asset");
	}

	// The custom layer's rules reach the artifact inside the generated stylesheet
	// dump, not through the splice above, so assert each rule survived. Compared
	// selector-to-selector and property-name-to-property-name, because the
	// browser rewrites authored values when it serialises cssText — `5 5`
	// becomes `5, 5`, `.12em` becomes `0.12em` — so a rule's text can never be
	// compared literally. The property check is what makes this stronger than a
	// bare selector test: a generated class sharing the name would pass that.
	// Look each selector up where a rule actually starts — after a `}` or at
	// the top of the stylesheet — rather than harvesting every rule in the file,
	// which mis-attributes rules when a comment or a nested block throws the
	// brace counting off.
	const bodyOf = (sel) => {
		const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// multiline: a rule can start at the beginning of a line inside the
		// stylesheet, which `^` alone would miss.
		const m = out.match(new RegExp(`(?:^|[};])\\s*${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "m"));
		return m ? m[1] : undefined;
	};
	const missing = [];
	for (const rule of customCss.split("}")) {
		const body = rule.replace(/\/\*[^]*?\*\//g, "").trim();
		const brace = body.indexOf("{");
		if (brace === -1) continue;
		const props = (body.slice(brace + 1).match(/[-a-zA-Z]+\s*:/g) ?? []).map((p) => p.replace(/\s*:/, ""));
		for (const sel of body.slice(0, brace).split(",").map((s) => s.trim())) {
			if (!sel.startsWith(".") && !sel.startsWith("#")) continue;
			const got = bodyOf(sel);
			if (got === undefined) {
				missing.push(`${sel} (no such rule in the output)`);
				continue;
			}
			const absent = props.filter((p) => !got.includes(p));
			if (absent.length > 0) missing.push(`${sel} (missing ${absent.join(", ")})`);
		}
	}
	if (missing.length > 0) {
		throw new Error(`custom CSS did not survive into the output:\n  ${missing.join("\n  ")}`);
	}

	writeFileSync(OUT, out);
	console.log(`rendered ${OUT} — ${declared} diagram(s) inlined, no scripts, no remote assets`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}