import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listSessionIdsWithOpenProposals, countOpenProposalsByValidationStatus } from "../db/queries.js";
import { getAnalyzerPaths, getDbPath, getModelTiers, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze/framework.js";
import { registerAll } from "../analyze/defaults.js";
import { proposalValidateAnalyzer, PROPOSAL_VALIDATE_DEF } from "../analyze/analyzers/proposal-validate/index.js";
import { makePiLLMCaller } from "../analyze/pi-llm.js";
import { applyModelOverride } from "../analyze/model-tiers.js";
import { parseReviseArg, reachLabel } from "../analyze/version.js";
import type { ReviseReason } from "../analyze/types.js";

interface ValidateArgs {
	revise: ReviseReason[];
	limit?: number;
	session?: string;
	model?: string;
}

/**
 * Replay-validate open proposals (issue #6). Runs only the proposal-validate
 * analyzer; its dependencies are visited but their nodes are already current, so
 * no extra LLM work happens there. The validator model defaults to the `mid`
 * tier (distinct from the `cheap` tier that generated the proposals); `--model`
 * pins every tier for this run, and the resolved model is part of node identity.
 */
export async function prospectValidate(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const args = parseArgs(rawArgs ?? "");
	const reach = reachLabel(args.revise);
	const config = loadConfig();
	const modelTiers = applyModelOverride(getModelTiers(config), args.model);

	const db = new Database(getDbPath(config));
	migrate(db);

	try {
		const sessionIds = args.session ? [args.session] : listSessionIdsWithOpenProposals(db, args.limit);
		if (sessionIds.length === 0) {
			out(ctx, "No open proposals to validate. Run analyze first.", "info");
			return;
		}

		const llm = makePiLLMCaller(ctx, { modelTiers });
		const framework = new AnalyzerFramework({ db, llm, modelTiers });
		// Built-ins + custom analyzers, so a custom dependency of a custom validator
		// (or a custom analyzer that emits proposals) is present during validation.
		await registerAll(framework, { paths: getAnalyzerPaths([], config) });
		framework.register(proposalValidateAnalyzer);

		out(ctx, `Validating proposals in ${sessionIds.length} session(s) [${reach}]…`, "info");

		let validated = 0;
		let cost = 0;
		const errors: string[] = [];
		for (const sessionId of sessionIds) {
			try {
				const summary = await framework.run(sessionId, {
					revise: args.revise,
					analyzerIds: [PROPOSAL_VALIDATE_DEF.id],
					modelSpec: args.model,
				});
				const vr = summary.analyzerResults.find((r) => r.analyzerId === PROPOSAL_VALIDATE_DEF.id);
				validated += vr?.nodesProduced ?? 0;
				cost += summary.costUsd;
				errors.push(...summary.errors);
			} catch (err) {
				errors.push(`${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		// Report the grounded outcome distribution across all open proposals.
		const byStatus = countOpenProposalsByValidationStatus(db);

		const lines = [
			`Done [${reach}]. ${sessionIds.length} session(s) scanned.`,
			`  Validation nodes produced: ${validated}`,
			`  Open proposals — supported: ${byStatus["supported"] ?? 0}, unsupported: ${byStatus["unsupported"] ?? 0}, unvalidated: ${byStatus["unvalidated"] ?? 0}`,
			`  Estimated cost: $${cost.toFixed(4)}`,
		];
		if (errors.length > 0) {
			lines.push(`  Errors: ${errors.length}`);
			for (const e of errors.slice(0, 5)) lines.push(`    ${e}`);
		}
		out(ctx, lines.join("\n"), errors.length > 0 ? "warning" : "info");
	} finally {
		db.close();
	}
}

export function registerValidateCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-validate", {
		description:
			"Replay-validate open proposals: re-classify each proposal's originating turns with and without the candidate rule (distinct model) and write a grounded validated_score. Flags: --revise major|minor|config|all, --limit N, --session ID, --model provider/model.",
		handler: prospectValidate,
	});
}

function out(ctx: ExtensionCommandContext, text: string, level: string): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function parseArgs(raw: string): ValidateArgs {
	const result: ValidateArgs = { revise: [] };
	const parts = raw.trim().split(/\s+/).filter((p) => p.length > 0);
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (p === "--revise" && parts[i + 1]) {
			for (const r of parseReviseArg(parts[++i]!)) {
				if (!result.revise.includes(r)) result.revise.push(r);
			}
		} else if (p === "--limit" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!Number.isNaN(n)) result.limit = n;
		} else if (p === "--session" && parts[i + 1]) result.session = parts[++i];
		else if (p === "--model" && parts[i + 1]) result.model = parts[++i];
	}
	return result;
}
