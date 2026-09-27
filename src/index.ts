import type { ExtensionAPI } from "./pi-stubs.js";
import { registerProspector } from "./commands/registry.js";
import { registerHeadlessFlag } from "./commands/headless.js";

/**
 * pi-prospector's entry point, loaded on every `pi` start.
 *
 * It imports the registration surface only: the command table, the `prospect`
 * tool's metadata, and the `--prospect` flag. Every command implementation sits
 * behind a dynamic import in that table, so a startup transpiles a handful of
 * files instead of the whole extension (#292).
 */
export default function (pi: ExtensionAPI): void {
	registerProspector(pi);
	registerHeadlessFlag(pi);
}
