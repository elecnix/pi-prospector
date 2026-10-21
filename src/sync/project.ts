/**
 * The project a session belongs to, from the working directory it ran in.
 *
 * Pi and Claude Code group their sessions in a directory per project, and the
 * project comes from that directory's name. Codex, OpenCode and Cline do not:
 * each session records the directory it ran in, and that is the only record of
 * where it happened. The last path segment is the project for a plain
 * directory; a path under a `Source`-style checkout keeps the repository and
 * the worktree, the same shape the token report derives.
 */
export function projectFromCwd(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	if (parts.length === 0) return "workspace";
	const srcIdx = parts.lastIndexOf("Source");
	if (srcIdx >= 0 && parts.length > srcIdx + 1) {
		const repo = parts[srcIdx + 1]!;
		const worktree = parts[srcIdx + 2];
		return worktree && worktree !== "main" ? `${repo}/${worktree}` : repo;
	}
	return parts[parts.length - 1]!;
}
