import type { ExtensionAPI } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { getUnanalyzedSessions, getSessionMessages } from "../db/queries.js";
import { getDbPath, loadConfig } from "../config.js";
import { AnalyzerFramework } from "../analyze.js";
import { turnPairCoreAnalyzer } from "./turn-pair-core-analyzer.js";

// ── LLM Implementation ──

interface OpenAICompatibleResponse {
	choices: Array<{
		message?: {
			content?: string;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
	};
}

async function callOpenRouterLLM(
	model: string,
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	systemPrompt?: string
): Promise<{ content: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
	const apiKey = process.env.OPENROUTER_API_KEY ?? process.env["OPENAI_API_KEY"] ?? "";
	const baseUrl = "https://openrouter.ai/api/v1";

	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"HTTP-Referer": "https://pi-prospector.local",
			"X-Title": "pi-prospector",
		},
		body: JSON.stringify({
			model,
			messages: systemPrompt
				? [{ role: "system", content: systemPrompt }, ...messages]
				: messages,
			max_tokens: 4000,
		}),
	});

	if (!response.ok) {
		throw new Error(`LLM call failed: ${response.status} ${response.statusText}`);
	}

	const data = await response.json() as OpenAICompatibleResponse;
	const content = data.choices[0]?.message?.content ?? "";

	return {
		content,
		usage: {
			inputTokens: data.usage?.prompt_tokens,
			outputTokens: data.usage?.completion_tokens,
		},
	};
}

export function registerAnalyzeCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-analyze", {
		description: "Run LLM analysis over unanalyzed sessions to generate proposals",
		handler: async (args: string, ctx: { ui: { notify: (msg: string, level: string) => void } }) => {
			const config = loadConfig();
			const parsedArgs = parseArgs(args ?? "");
			const modelSpec = parsedArgs.model ?? "poolside/laguna-m.1:free";

			const db = new Database(getDbPath());
			migrate(db);

			try {
				const unanalyzed = getUnanalyzedSessions(db, parsedArgs.limit);
				if (unanalyzed.length === 0) {
					const msg = "No unanalyzed sessions. Run /prospect-sync first.";
					ctx.ui.notify(msg, "info");
					console.log(msg);
					return;
				}

				const startMsg = `Analyzing ${unanalyzed.length} session(s) with ${modelSpec}...`;
				ctx.ui.notify(startMsg, "info");
				console.log(startMsg);

				const framework = new AnalyzerFramework(db);

				let totalProposals = 0;
				let errors = 0;

				for (const session of unanalyzed) {
					try {
						const result = await framework.run(turnPairCoreAnalyzer, session.id);
						console.log(`Session ${session.id}: ${result.nodesProduced} nodes, ${result.nodesSkipped} skipped`);
						totalProposals += result.nodesProduced;
					} catch (err) {
						errors++;
						const errMsg = `Error on session ${session.id}: ${err}`;
						ctx.ui.notify(errMsg, "warning");
						console.error(errMsg);
					}
				}

				const doneMsg = `Done. ${unanalyzed.length - errors} analyzed, ${totalProposals} proposals, ${errors} errors.`;
				ctx.ui.notify(doneMsg, "info");
				console.log(doneMsg);
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