import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listProposals, acceptProposal, rejectProposal } from "../db/queries.js";
import { getDbPath } from "../config.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

export async function prospectProposals(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const status = args?.trim() || undefined;
		const proposals = listProposals(db, status);

		if (proposals.length === 0) {
			output(ctx, "No proposals found.");
			return;
		}

		const lines = proposals.map((p) => {
			const short = p.id.slice(0, 8);
			const target = p.target_path ? `${p.target_type}: ${p.target_path}` : p.target_type;
			return `[${p.status}] ${short} | ${p.severity} | ${target}\n  ${p.title}\n  ${p.summary}`;
		});
		output(ctx, `Proposals (${proposals.length}):\n${lines.join("\n\n")}`);
	} finally {
		db.close();
	}
}

export async function prospectAccept(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const id = args?.trim();
	if (!id) {
		output(ctx, "Usage: /prospect-accept <id>", "warning");
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const ok = acceptProposal(db, id);
		output(ctx, ok ? `Proposal ${id} applied.` : `Proposal ${id} not found or not open.`, ok ? "info" : "warning");
	} finally {
		db.close();
	}
}

export async function prospectReject(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const id = args?.trim();
	if (!id) {
		output(ctx, "Usage: /prospect-reject <id>", "warning");
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const ok = rejectProposal(db, id);
		output(ctx, ok ? `Proposal ${id} rejected.` : `Proposal ${id} not found or not open.`, ok ? "info" : "warning");
	} finally {
		db.close();
	}
}

export function registerProposalsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-proposals", {
		description: "List proposals (optionally filter by status: open, applied, rejected, duplicate)",
		handler: prospectProposals,
	});

	pi.registerCommand("prospect-accept", {
		description: "Accept (apply) a proposal by ID",
		handler: prospectAccept,
	});

	pi.registerCommand("prospect-reject", {
		description: "Reject a proposal by ID",
		handler: prospectReject,
	});
}
