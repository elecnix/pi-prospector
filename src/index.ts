import type { ExtensionAPI } from "./pi-stubs.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerStatsCommand } from "./commands/stats.js";
import { registerProposalsCommand } from "./commands/proposals.js";
import { registerAnalyzeCommand } from "./commands/analyze.js";
import { registerAnalyzersCommand } from "./commands/analyzers.js";
import { registerVerifyCommand } from "./commands/verify.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerShowCommand } from "./commands/show.js";
import { registerProspectTool } from "./commands/tool.js";
import { registerHeadlessFlag } from "./commands/headless.js";

export default function (pi: ExtensionAPI) {
	registerSyncCommand(pi);
	registerStatsCommand(pi);
	registerProposalsCommand(pi);
	registerAnalyzeCommand(pi);
	registerAnalyzersCommand(pi);
	registerVerifyCommand(pi);
	registerValidateCommand(pi);
	registerShowCommand(pi);
	registerProspectTool(pi);
	registerHeadlessFlag(pi);
}