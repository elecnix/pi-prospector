/**
 * Limits that apply to many metrics, written once.
 *
 * A metric lists the ones that affect it, so a reader of one entry meets the
 * limit in place and a wording change happens here only.
 */

export const LIMIT_USER_ROLE =
	"A user-role message may not have been typed by a person. Hosts file pasted text, text another agent wrote, task notifications and forked copies under the user role, so a figure that reads user messages mixes the person's words with those. The message-origin analyzer labels who wrote each message. A figure that does not filter on its label is an upper bound on what the person typed.";

export const LIMIT_HARNESS =
	"Pi, Claude Code, Codex, OpenCode and Cline record different things: they name tools differently, flag errors by their own rules, and file injected text under different roles. A share that moves when the mix of harnesses moves says nothing about behaviour, so split by harness before reading a trend.";

export const LIMIT_VERSIONS =
	"A plain run computes a node once, under one recipe. A series over several months mixes analyzer versions and models unless a revise run brought every node to the current recipe.";

export const LIMIT_PARALLEL =
	"Several sessions and agents run at once, so a total across sessions is agent time and not the person's time. Use a per-session median for anything about the person.";

export const LIMIT_CALL_ID =
	"A session indexed before sync stored the provider's call id (before 2026-08-20) holds calls without an id. Versions before the pairing fix could not match their results, so those sessions read as if no tool had failed.";
