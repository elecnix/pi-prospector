/**
 * Unit tests for repo-identity. Pure functions, no database, no mocks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repoIdentityOf } from "../../src/analyze/analyzers/repo-identity/detect.js";
import { DEFAULT_REPO_IDENTITY_CONFIG } from "../../src/analyze/analyzers/repo-identity/config.js";

describe("repoIdentityOf", () => {
	it("reads the repository and worktree from the bare-repo-plus-worktrees layout", () => {
		assert.deepEqual(repoIdentityOf("/Users/ana/Source/Widgets/feat-x"), {
			repo_key: "widgets",
			placement: "repo",
			checkout: "feat-x",
			root: "source",
		});
	});

	it("gives worktrees of one repository the same key", () => {
		const a = repoIdentityOf("/Users/ana/Source/widgets/main");
		const b = repoIdentityOf("/Users/ana/Source/Widgets/fix-y/src/lib");
		assert.equal(a.repo_key, b.repo_key);
	});

	it("reads a plain clone, with no checkout", () => {
		assert.deepEqual(repoIdentityOf("/home/ana/code/widgets.git"), {
			repo_key: "widgets",
			placement: "repo",
			checkout: null,
			root: "code",
		});
	});

	it("reads a Windows path", () => {
		assert.equal(repoIdentityOf("C:\\Users\\ana\\code\\widgets\\main").repo_key, "widgets");
	});

	it("gives a root directory itself no key", () => {
		assert.equal(repoIdentityOf("/Users/ana/Source").repo_key, null);
		assert.equal(repoIdentityOf("/Users/ana/Source/").placement, "unplaced");
	});

	it("says why a directory has no key", () => {
		assert.equal(repoIdentityOf("/private/tmp/scratch").placement, "temp");
		assert.equal(repoIdentityOf("/tmp").placement, "temp");
		assert.equal(repoIdentityOf("/Users/ana").placement, "unplaced");
		assert.equal(repoIdentityOf("").placement, "unknown");
	});

	it("recognises a temp directory configured and recorded with Windows separators", () => {
		const config = { ...DEFAULT_REPO_IDENTITY_CONFIG, tempPrefixes: ["C:\\Users\\ana\\AppData\\Local\\Temp"] };
		assert.equal(repoIdentityOf("C:\\Users\\ana\\AppData\\Local\\Temp\\x", config).placement, "temp");
		assert.equal(repoIdentityOf("C:\\Users\\ana\\AppData\\Local\\Tempo", config).placement, "unplaced");
	});

	it("does not mistake a longer name for a temp prefix", () => {
		assert.equal(repoIdentityOf("/tmpfiles/x").placement, "unplaced");
	});

	it("does not read a repository's own src directory as a root", () => {
		assert.equal(repoIdentityOf("/opt/myapp/src/lib").repo_key, null);
		assert.equal(repoIdentityOf("/home/ana/work/myapp/src/lib").repo_key, "myapp", "the leftmost root wins");
	});

	it("honours a configured root", () => {
		const config = { ...DEFAULT_REPO_IDENTITY_CONFIG, repoRoots: ["clones"] };
		assert.equal(repoIdentityOf("/data/clones/widgets/main", config).repo_key, "widgets");
		assert.equal(repoIdentityOf("/Users/ana/Source/widgets", config).repo_key, null);
	});
});
