import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getUnanalyzedSessions, getSessionMessages, markAnalyzed, insertProposal, computeDedupHash } from "../db/queries.js";
import { getDbPath, loadConfig } from "../config.js";
import { buildAnalysisPrompt, ANALYSIS_TOOL_SCHEMA } from "../analyze/prompt.js";
import { parseAnalysisResponse } from "../analyze/parser.js";
import { randomUUID } from "node:crypto";

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description: "Run LLM analysis over unanalyzed sessions to generate proposals",
		handler: async (args, ctx) => {
			const config = loadConfig();
			const parsedArgs = parseArgs(args ?? "");
			const modelSpec = parsedArgs.model ?? config.model;

			if (!modelSpec) {
				ctx.ui.notify("No model configured. Use --model provider/model or set in ~/.pi/agent/prospector.json", "error");
				return;
			}

			const db = new Database(getDbPath());
			migrate(db);

			try {
				const unanalyzed = getUnanalyzedSessions(db, parsedArgs.limit);
				if (unanalyzed.length === 0) {
					ctx.ui.notify("No unanalyzed sessions. Run /prospect-sync first.", "info");
					return;
				}

				ctx.ui.notify(`Analyzing ${unanalyzed.length} session(s) with ${modelSpec}...`, "info");

				let totalProposals = 0;
				let errors = 0;

				for (const session of unanalyzed) {
					try {
						const messages = getSessionMessages(db, session.id);
						if (messages.length < 2) {
							markAnalyzed(db, session.id);
							continue;
						}

						// Build transcript
						const transcript = messages.map((m) => {
							if (m.role === "user") return `USER: ${m.content_text ?? ""}`;
							if (m.role === "assistant") {
								const parts: string[] = [];
								if (m.content_thinking) parts.push(`THINKING: ${m.content_thinking.slice(0, 1000)}`);
								if (m.content_text) parts.push(`AGENT: ${m.content_text.slice(0, 2000)}`);
								if (m.tool_calls) parts.push(`TOOLS: ${m.tool_calls.slice(0, 500)}`);
								return parts.join("\n");
							}
							return `[${m.role}]: ${(m.content_text ?? "").slice(0, 200)}`;
						}).join("\n\n");

						if (transcript.length < 100) {
							markAnalyzed(db, session.id);
							continue;
						}

						// TODO: Call LLM via @earendil-works/pi-ai
						// For now this is a stub — marks as analyzed without generating proposals
						markAnalyzed(db, session.id);
					} catch (err) {
						errors++;
						ctx.ui.notify(`Error on session ${session.id}: ${err}`, "warning");
					}
				}

				ctx.ui.notify(`Done. ${unanalyzed.length - errors} analyzed, ${totalProposals} proposals, ${errors} errors.`, "info");
			} finally {
				db.close();
			}
		},
	});
}

function parseArgs(raw: string): { model?: string; limit?: number } {
	const result: { model?: string; limit?: number } = {};
	const parts = raw.split(/\s+/);
	for (let i = 0; i < parts.length; i++) {
		if (parts[i] === "--model" && parts[i + 1]) result.model = parts[++i];
		else if (parts[i] === "--limit" && parts[i + 1]) {
			const n = parseInt(parts[++i]!, 10);
			if (!isNaN(n)) result.limit = n;
		}
	}
	return result;
}