/**
 * Reading a dependency node's content.
 *
 * The framework hands dependency rows back with `content_json` as a string; a caller
 * that passes an already-parsed object is tolerated so tests and future callers can
 * build rows by hand. Shared by the two analyzers that read other analyzers' nodes,
 * because a second copy of this drifted the moment one of them handled a null
 * differently.
 */
export function contentOf(node: { content_json: string | null } | undefined | null): unknown {
	if (!node || node.content_json == null) return null;
	if (typeof node.content_json !== "string") return node.content_json;
	try {
		return JSON.parse(node.content_json);
	} catch {
		return null;
	}
}
