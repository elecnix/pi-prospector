import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSyncCommand } from "./commands/sync.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerProposalsCommand } from "./commands/proposals.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerProspectTool } from "./commands/tool.js";

export default function (pi: ExtensionAPI) {
	registerSyncCommand(pi);
	registerStatsCommand(pi);
	registerProposalsCommand(pi);
	registerAnalyzeCommand(pi);
	registerProspectTool(pi);
}