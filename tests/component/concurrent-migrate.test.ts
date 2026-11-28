/**
 * Component tests: several processes open one database at the same moment.
 *
 * Every command opens the database through `migrate()`, and the friction report
 * runs six analyses at once, so several connections migrate one file together.
 * The migration drops and recreates its views and triggers on every open. Run
 * statement by statement, another connection can recreate an object between one
 * connection's DROP and its CREATE, and that connection then fails with
 * "view live_nodes already exists". The migration holds the write lock for its
 * whole length, so the migrations of two connections never interleave.
 *
 * Real SQLite (temp files), one worker-backed connection per opener, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { makeTempRoot } from "./helpers.js";

const OPENERS = 6;
const ROUNDS = 5;

/** Open `count` connections on `file` and migrate them all at once. */
async function migrateTogether(file: string, count: number): Promise<PromiseSettledResult<void>[]> {
	const dbs: AsyncDatabase[] = Array.from({ length: count }, () => openAsyncDatabase(file));
	try {
		return await Promise.allSettled(dbs.map((db) => migrate(db)));
	} finally {
		await Promise.all(dbs.map((db) => db.close()));
	}
}

function failures(results: PromiseSettledResult<void>[]): string[] {
	return results.flatMap((r) => (r.status === "rejected" ? [String((r.reason as Error).message)] : []));
}

describe("concurrent migrations of one database", () => {
	it("every opener of a new database migrates it without error", async () => {
		const { root, cleanup } = makeTempRoot("prospect-migrate-race-");
		try {
			for (let round = 0; round < ROUNDS; round++) {
				const file = path.join(root, `new-${round}.db`);
				assert.deepEqual(failures(await migrateTogether(file, OPENERS)), [], `round ${round}`);
			}
		} finally {
			cleanup();
		}
	});

	it("every opener of an existing database migrates it without error", async () => {
		const { root, cleanup } = makeTempRoot("prospect-migrate-race-");
		try {
			const file = path.join(root, "existing.db");
			const first = openAsyncDatabase(file);
			await migrate(first);
			await first.close();
			for (let round = 0; round < ROUNDS; round++) {
				assert.deepEqual(failures(await migrateTogether(file, OPENERS)), [], `round ${round}`);
			}
			const db = openAsyncDatabase(file);
			try {
				const views = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all()) as Array<{ name: string }>;
				assert.deepEqual(views.map((v) => v.name), ["current_nodes", "live_nodes"]);
			} finally {
				await db.close();
			}
		} finally {
			cleanup();
		}
	});
});
