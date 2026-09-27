/**
 * Load a module once, on first use.
 *
 * pi loads every extension through jiti, which resolves and transpiles each
 * imported file at runtime, so a module that a command imports when it runs
 * costs nothing until then (#292). Caching the promise keeps that once-only
 * guarantee ours rather than the host's — the extension loader creates jiti
 * with `moduleCache: false` — and makes concurrent callers share one load.
 *
 * A failed load is not cached: an error reading a command's module must not
 * disable that command for the rest of the session.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined;
	return () => {
		pending ??= load().catch((error: unknown) => {
			pending = undefined;
			throw error;
		});
		return pending;
	};
}
