/**
 * Component test for role-agnostic ingestion of custom-typed session entries
 * (issue #272). Syncs a hand-written synthetic fixture containing a
 * `type:"custom"` private note, a `display:false` `custom_message`
 * notification, an opaque custom entry with no text field, and a
 * `model_change` record; then asserts the ingested rows have their text in
 * `content_text` (and the customType provenance on the role for custom
 * entries) and that the full-text index matches the note's wording.
 *
 * Real SQLite (temp file), synthetic JSONL, mock-free, offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { searchCorpus } from "../../src/db/search-queries.js";
import { tempDb } from "./helpers.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");
const SESSION_ID = "cccc0001-bbbb-cccc-dddd-eeeeeeeeeeee";

async function customRows(db: AsyncDatabase) {
	const rows = (await db
		.prepare("SELECT id, role, content_text FROM messages WHERE session_id = ? AND id IN ('c1bbb001','cm1bbb001','c1bbb002','mc1bbb001') ORDER BY id")
		.all(SESSION_ID)) as Array<{ id: string; role: string; content_text: string | null }>;
	return new Map(rows.map((r) => [r.id, r] as const));
}

describe("sync ingests custom-typed entries (issue #272)", () => {
	it("indexes custom and custom_message bodies into content_text", async () => {
		const { db, close } = await tempDb();
		try {
			const result = await runSync(db, [new PiFileSource(FIXTURES)]);
			assert.ok(result.messagesInserted >= 6, `expected the fixture's 6 entries, got ${result.messagesInserted}`);

			const rows = await customRows(db);
			const note = rows.get("c1bbb001");
			assert.ok(note, "private-note row is indexed");
			assert.equal(note.role, "custom/private-note");
			assert.ok(note.content_text?.includes("unregistered-name-marker"), "the note's text is ingested");

			const notify = rows.get("cm1bbb001");
			assert.ok(notify, "custom_message row is indexed");
			assert.equal(notify.role, "custom_message");
			assert.ok(notify.content_text?.includes("unknown-tool-name-probe"), "display:false body is ingested");

			const opaque = rows.get("c1bbb002");
			assert.ok(opaque, "opaque custom entry still becomes a row");
			assert.equal(opaque.content_text, null);

			const modelChange = rows.get("mc1bbb001");
			assert.ok(modelChange, "model_change row still becomes a row");
			assert.equal(modelChange.content_text, null);
		} finally {
			await close();
		}
	});

	it("finds the ingested custom entries through corpus search", async () => {
		const { db, close } = await tempDb();
		try {
			await runSync(db, [new PiFileSource(FIXTURES)]);

			const note = await searchCorpus(db, "\"unregistered-name-marker\"", { kind: "messages" });
			assert.ok(note.hits.some((h) => h.message_id === "c1bbb001"), "private-note text is searchable");

			const notify = await searchCorpus(db, "\"unknown-tool-name-probe\"", { kind: "messages" });
			assert.ok(notify.hits.some((h) => h.message_id === "cm1bbb001"), "custom_message body is searchable");
		} finally {
			await close();
		}
	});
});