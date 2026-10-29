/**
 * Content filters: `key=value` specs matched against a node's parsed content.
 *
 * `prospect nodes --filter` reads the graph with them, and a run's
 * `reviseWhere` narrows a revise with them. Typed matching uses the analyzer's
 * declared `outputSchema`; with no declared schema, matching falls back to a
 * best-effort comparison over the parsed value.
 */

import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { TSchema } from "typebox";
import type { AnalyzerDef } from "./types.js";

/** A parsed `key=value` content filter. */
export const FilterSpec = Type.Object({
	key: Type.String(),
	raw: Type.String(),
});
export type FilterSpec = Static<typeof FilterSpec>;

/** Split `key=value` on the first `=`. Throws, naming `flag`, when the spec has no value. */
export function parseFilterSpec(spec: string, flag = "--filter"): FilterSpec {
	const eq = spec.indexOf("=");
	if (eq <= 0) throw new Error(`malformed ${flag} '${spec}' (expected key=value)`);
	return { key: spec.slice(0, eq), raw: spec.slice(eq + 1) };
}

// ─────────────────────────── typed filtering ───────────────────────────

/** The declared schema for one top-level content property, if the analyzer declares its output shape. */
function declaredProperty(def: AnalyzerDef | undefined, key: string): TSchema | undefined {
	const props = (def?.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
	const schema = props?.[key];
	return schema ? (schema as TSchema) : undefined;
}

/** Canonical JSON comparison — key order independent, so two parses of equivalent JSON match. */
function sameJson(a: unknown, b: unknown): boolean {
	return stableStringify(a) === stableStringify(b);
}

export function stableStringify(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Coerce a raw filter string to the declared property's type. Throws on mismatch. */
function coerceDeclared(raw: string, key: string, schema: TSchema): unknown {
	const t = (schema as { type?: string | string[] }).type;
	const kind = Array.isArray(t) ? t[0] : t;
	switch (kind) {
		case "number":
		case "integer": {
			const n = Number(raw);
			if (!Number.isFinite(n)) throw new Error(`--filter ${key}=${raw}: declared ${kind}, value must be numeric`);
			return n;
		}
		case "boolean": {
			if (raw === "true") return true;
			if (raw === "false") return false;
			throw new Error(`--filter ${key}=${raw}: declared boolean, value must be true or false`);
		}
		case "array":
		case "object": {
			try {
				return JSON.parse(raw) as unknown;
			} catch {
				throw new Error(`--filter ${key}=${raw}: declared ${kind}, value must be JSON`);
			}
		}
		default:
			return raw;
	}
}

/** Match one node content value against one filter, using the declared schema when available. */
export function valueMatches(value: unknown, spec: FilterSpec, def: AnalyzerDef | undefined): boolean {
	const schema = declaredProperty(def, spec.key);
	if (schema) {
		const expected = coerceDeclared(spec.raw, spec.key, schema);
		// Schema-validate the coerced value so enums/constraints are honoured, not just the base type.
		const wrapper = Type.Object({ [spec.key]: schema });
		if (!Check(wrapper, { [spec.key]: expected })) {
			throw new Error(`--filter ${spec.key}=${spec.raw}: value does not match the declared schema for '${spec.key}'`);
		}
		if (typeof expected === "number" && typeof value === "number") return expected === value;
		return sameJson(expected, value);
	}
	// Best-effort: no declared schema (or undeclared property on a schema'd analyzer).
	if (typeof value === "number") {
		const n = Number(spec.raw);
		return Number.isFinite(n) && n === value;
	}
	if (typeof value === "boolean") return spec.raw === (value ? "true" : "false");
	try {
		return sameJson(JSON.parse(spec.raw) as unknown, value);
	} catch {
		return String(value) === spec.raw;
	}
}

/** True when every filter matches the node's parsed content. */
export function contentMatchesFilters(content: Record<string, unknown>, filters: FilterSpec[], def: AnalyzerDef | undefined): boolean {
	return filters.every((f) => valueMatches(content[f.key], f, def));
}
