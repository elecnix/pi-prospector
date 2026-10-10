/**
 * Component tests: the two FTS5 indexes survive a second `migrate()`.
 *
 * Every command opens the database through `migrate()`, so a real database is
 * migrated once per command, not once per lifetime. An index that `migrate()`
 * drops and recreates is therefore emptied on every command while its content
 * table keeps its rows. Search then finds nothing older than the current
 * command, and deleting a row the index never saw — gc deleting a proposal —
 * fails with "database disk image is malformed".
 *
 * Real SQLite (temp file), hand-written synthetic rows, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, insertProposalRow } from "./helpers.js";
import { migrate } from "../../src/db/schema.js";
import { searchCorpus } from "../../src/db/search-queries.js";

type Db = Awaited<ReturnType<typeof tempDb>>["db"];

async function seed(db: Db): Promise<void> {
	await insertSession(db, "fts-s1");
	await insertMessages(db, "fts-s1", [{ role: "user", text: "the lexicon keeps missing French frustration terms" }]);
	await insertProposalRow(db, { id: "fts-p1", sessionId: "fts-s1", title: "Add French terms to the lexicon" });
}

/** FTS5's full check: the index against itself and against its content table. */
async function assertIndexMatchesContent(db: Db): Promise<void> {
	for (const t of ["messages_fts", "proposals_fts"]) {
		await db.prepare(`INSERT INTO ${t}(${t}, rank) VALUES('integrity-check', 1)`).run();
	}
}

describe("FTS indexes across repeated migrations", () => {
	it("search still finds earlier rows after a second migrate", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db);
			await migrate(db); // the next command opening the same database
			const res = await searchCorpus(db, "lexicon");
			assert.equal(res.message_matches, 1, "the message indexed before the second migrate is still found");
			assert.equal(res.proposal_matches, 1, "the proposal indexed before the second migrate is still found");
			await assertIndexMatchesContent(db);
		} finally {
			await close();
		}
	});

	it("deleting a proposal after a second migrate succeeds", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db);
			await migrate(db);
			await db.prepare("DELETE FROM proposals WHERE id = ?").run("fts-p1");
			await db.prepare("UPDATE proposals SET title = title WHERE 0").run();
			await assertIndexMatchesContent(db);
			assert.equal((await searchCorpus(db, "lexicon")).proposal_matches, 0);
		} finally {
			await close();
		}
	});

	it("migrate repairs an index an earlier version left empty", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db);
			// The state an earlier migrate() left behind: content rows, empty index.
			for (const t of ["messages_fts", "proposals_fts"]) {
				await db.prepare(`INSERT INTO ${t}(${t}) VALUES('delete-all')`).run();
			}
			assert.equal((await searchCorpus(db, "lexicon")).proposal_matches, 0, "precondition: the index is empty");

			await migrate(db);
			await assertIndexMatchesContent(db);
			const res = await searchCorpus(db, "lexicon");
			assert.equal(res.message_matches, 1);
			assert.equal(res.proposal_matches, 1);
			await db.prepare("DELETE FROM proposals WHERE id = ?").run("fts-p1");
		} finally {
			await close();
		}
	});
});
