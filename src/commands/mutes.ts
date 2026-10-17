/**
 * Muting commands: surface the lexicon's tail, let the operator (or the
 * reviewing agent via the prospect tool) say "not that one", and mute it.
 *
 * Prompt tuning is the wrong instrument for vocabulary that merely looks like a
 * signal but is not for a given corpus. A mute is a content-addressed
 * judgement — the operator's, keyed on the term — that stops a term from
 * matching new turns while leaving its prior hit nodes intact as stale/config
 * lineage. Nobody hand-edits config.
 *
 *   prospect mute <term> [--reason "..."]
 *   prospect unmute <term>
 *   prospect mutes
 */

import type { ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { getDbPath } from "../config.js";
import {
	upsertAssertion,
	supersedeAssertion,
	listAssertions,
	attachMuteEdge,
	type AssertionRow,
} from "../db/assertions.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/**
 * Split a leading term from the rest of the arguments. A term in single or
 * double quotes is read whole, so a multi-word term survives; an unquoted term
 * runs up to the first `--` flag. An unterminated quote gives no term.
 */
function splitTerm(args: string): { term: string | undefined; rest: string } {
	const text = (args ?? "").trim();
	const quote = text[0];
	if (quote === '"' || quote === "'") {
		const end = text.indexOf(quote, 1);
		if (end === -1) return { term: undefined, rest: "" };
		const term = text.slice(1, end).trim();
		return { term: term.length > 0 ? term : undefined, rest: text.slice(end + 1).trim() };
	}
	const flag = text.search(/(^|\s)--/);
	const head = (flag === -1 ? text : text.slice(0, flag)).trim();
	const rest = flag === -1 ? "" : text.slice(flag).trim();
	return { term: head.length > 0 ? head : undefined, rest };
}

/** Parse `mute <term> [--reason …] [--by agent|operator]`. The reason is everything after `--reason` (up to `--by`). */
export function parseMuteArgs(args: string): { term?: string; reason: string | null; by: string | null } {
	const { term, rest } = splitTerm(args);
	const toks = rest.split(/\s+/).filter(Boolean);
	let reason: string | null = null;
	let by: string | null = null;
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!.toLowerCase();
		if (t === "--reason") {
			const words: string[] = [];
			i++;
			while (i < toks.length && toks[i]!.toLowerCase() !== "--by") words.push(toks[i++]!);
			const joined = words.join(" ").trim();
			if (joined.length > 0) reason = joined;
			i--;
		} else if (t === "--by" && toks[i + 1]) {
			by = toks[++i]!;
		}
	}
	return { term, reason, by };
}

/** Parse `unmute <term>` with the same term rules as `mute`. */
export function parseUnmuteArgs(args: string): string | undefined {
	return splitTerm(args).term;
}

/** Normalise a term the way the tokeniser would, so mute keys match lexicon keys. */
export function normaliseTerm(raw: string): string {
	const unquoted = raw.trim().replace(/^(["'])(.*)\1$/s, "$2");
	return unquoted.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Mute a lexicon term. Records a content-addressed assertion (survives a wipe/
 * recompute) and, when the term already has a lexicon verdict node, wires the
 * `mutes` edge so the mute is reachable from the graph. Returns the recorded
 * outcome for reuse by the tool and tests.
 */
export async function muteTerm(
	db: AsyncDatabase,
	args: { term: string; reason?: string | null; by?: string | null },
): Promise<{ muted: boolean; assertionId: string }> {
	const term = normaliseTerm(args.term);
	const assertionId = await upsertAssertion(db, {
		subjectKind: "term",
		subjectKey: term,
		verdict: "muted",
		reason: args.reason ?? null,
		assertedBy: args.by ?? "operator",
	});
	await attachMuteEdge(db, term, assertionId);
	return { muted: true, assertionId };
}

/** Unmute a lexicon term (append-only via superseded_at). Returns rows superseded. */
export async function unmuteTerm(db: AsyncDatabase, term: string): Promise<number> {
	return supersedeAssertion(db, {
		subjectKind: "term",
		subjectKey: normaliseTerm(term),
		verdict: "muted",
	});
}

/** One-line render of an assertion row. */
export function formatAssertion(a: AssertionRow): string {
	const by = a.asserted_by ? ` by ${a.asserted_by}` : "";
	const reason = a.reason ? ` — ${a.reason}` : "";
	const state = a.superseded_at ? `unmuted ${a.superseded_at}` : "active";
	return `  [${state}] ${a.subject_kind}:${a.subject_key} → ${a.verdict} (asserted ${a.asserted_at}${by})${reason}`;
}

export async function prospectMute(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { term, reason, by } = parseMuteArgs(args);
	if (!term) {
		output(ctx, 'Usage: /prospect-mute <term> [--reason "why"] [--by operator|agent] (quote a multi-word term)', "warning");
		return;
	}
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const { assertionId } = await muteTerm(db, { term, reason, by });
		const note = reason ? ` — ${reason}` : "";
		output(
			ctx,
			`Muted '${normaliseTerm(term)}'. It will stop matching new turns; its existing hit nodes stay as stale/config lineage.` +
				`\n  Run '/prospect-analyze --revise config' to recompute the nodes that consulted it.` +
				`\n  Assertion ${assertionId}${note}`,
		);
	} finally {
		await db.close();
	}
}

export async function prospectUnmute(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseUnmuteArgs(args);
	const term = parsed === undefined ? "" : normaliseTerm(parsed);
	if (!term) {
		output(ctx, 'Usage: /prospect-unmute <term> (quote a multi-word term)', "warning");
		return;
	}
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const n = await unmuteTerm(db, term);
		output(ctx, n > 0 ? `Unmuted '${term}'. Its prior hit nodes classify current again.` : `'${term}' was not muted.`, n > 0 ? "info" : "warning");
	} finally {
		await db.close();
	}
}

export async function prospectMutes(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const rows = await listAssertions(db, "term");
		if (rows.length === 0) {
			output(ctx, "No term assertions recorded.");
			return;
		}
		const active = rows.filter((r) => r.superseded_at === null).length;
		output(
			ctx,
			`Term assertions (${rows.length} total, ${active} active; the mute corpus is the training input for the classifier prompt):\n${rows.map(formatAssertion).join("\n")}`,
		);
	} finally {
		await db.close();
	}
}
