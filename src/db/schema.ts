import Database from "better-sqlite3";

/**
 * Schema for pi-prospector.
 *
 * A single, clean migration creates everything in its final form — there is no
 * incremental ALTER/backfill machinery, because the database is disposable and
 * always rebuilt from session transcripts (`/prospect-sync`).
 *
 * Tables:
 *   sessions, messages, messages_fts   — the read-only session index
 *   proposals                          — materialised, user-reviewable proposals
 *   proposal_decisions                 — append-only human accept/reject + rationale
 *   remediations                       — one human action addressing many proposals
 *   analyzer_defs / _versions          — analyzer identity and code releases
 *   prompt_registry                    — content-addressed prompt store
 *   analyzer_configs                   — content-addressed config store
 *   analysis_runs                      — execution provenance (informational)
 *   analysis_nodes                     — append-only analysis artifacts
 *   analysis_edges                     — the typed relationship graph
 */
export function migrate(db: Database.Database): void {
	db.pragma("journal_mode = WAL");
	db.pragma("foreign_keys = ON");

	// Create tables in dependency order (messages depends on sessions, etc.)
	// Use IF NOT EXISTS for idempotency. Schema evolution handled below.
	db.exec(`
		-- ───────────────────────── session index ─────────────────────────

		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
			source TEXT NOT NULL DEFAULT 'pi',
			cwd TEXT NOT NULL DEFAULT '',
			parent_session TEXT,
			started_at TEXT,
			last_line INTEGER NOT NULL DEFAULT 0,
			last_modified REAL NOT NULL DEFAULT 0,
			analyzed_at TEXT,
			message_count INTEGER NOT NULL DEFAULT 0,
			branch_count INTEGER NOT NULL DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			source TEXT NOT NULL DEFAULT 'pi',
			parent_id TEXT,
			timestamp TEXT,
			role TEXT NOT NULL,
			content_text TEXT,
			content_thinking TEXT,
			tool_calls TEXT,
			tool_results TEXT,
			usage TEXT,
			content_hash TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		-- ───────────────────────── proposals (v2) ─────────────────────────

		CREATE TABLE IF NOT EXISTS proposals (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			session_id TEXT NOT NULL,
			source_node_id TEXT,
			analyzer_id TEXT,
			target_type TEXT NOT NULL,
			target_path TEXT,
			title TEXT NOT NULL,
			severity TEXT NOT NULL,
			summary TEXT NOT NULL,
			detail TEXT,
			evidence TEXT,
			confidence REAL,
			status TEXT NOT NULL DEFAULT 'open',
			input_key TEXT NOT NULL, -- content-addressed: H(source output_key | ordinal)
			-- replay validation (issue #6): the originating high-signal turn ids the
			-- proposal is replayed against, and the grounded result written back from a
			-- 'validation' analysis node. validation_status is one of
			-- unvalidated | supported | unsupported.
			source_message_ids TEXT, -- JSON array of user-message ids; NULL until set
			validated_score REAL, -- [0,1] fraction of replay turns whose friction the rule averts; NULL until validated
			validation_status TEXT NOT NULL DEFAULT 'unvalidated',
			validation_node_id TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		-- ──────────────────── human decisions (append-only) ────────────────────
		-- A decision is EXTERNAL human input (same category as messages), not
		-- derived data: it is not an analysis_node and is not part of a proposal's
		-- identity. It is keyed by the proposal's content-addressed input_key
		-- (NOT the row id) so it re-attaches to the regenerated proposal after a
		-- wipe + recompute — durable memory of how the human responded. Append-only:
		-- never UPDATE/DELETE a row; the latest by decided_at wins. This corpus is
		-- the input source for the future meta-analyzer that proposes improvements
		-- to raise proposal quality.
		CREATE TABLE IF NOT EXISTS proposal_decisions (
			id TEXT PRIMARY KEY,
			proposal_input_key TEXT NOT NULL,
			decision TEXT NOT NULL,        -- accepted | rejected | accepted_modified
			disposition TEXT,              -- planned | done | done_differently (nullable)
			rationale TEXT,               -- free-text human reasoning (nullable)
			actual_change TEXT,           -- commit sha / path / note of what was actually done (nullable)
			harness_ref TEXT,             -- marker of the active prompt/AGENTS.md at decision time (nullable)
			remediation_id TEXT,          -- shared remediations.id when accepted as part of a batch (nullable)
			decided_at TEXT NOT NULL
		);

		-- One remediation action addressing many proposals at once. Same durability
		-- family as proposal_decisions (external human input, never wiped on
		-- recompute): decision rows reference it via remediation_id, so a batch
		-- accept records the shared action once instead of N duplicated rationales.
		CREATE TABLE IF NOT EXISTS remediations (
			id TEXT PRIMARY KEY,
			description TEXT NOT NULL,     -- the remediation action, in the human's words
			actual_change TEXT,            -- commit sha / path / note of what was actually done (nullable)
			created_at TEXT NOT NULL
		);

		-- ──────────────────── analyzer identity & recipe ────────────────────

		CREATE TABLE IF NOT EXISTS analyzer_defs (
			id TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			anchor_span TEXT NOT NULL,
			dependencies TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS analyzer_versions (
			analyzer_id TEXT NOT NULL,
			version_id TEXT NOT NULL,
			implementation_kind TEXT NOT NULL,
			code_ref TEXT,
			created_at TEXT NOT NULL,
			PRIMARY KEY (analyzer_id, version_id),
			FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
		);

		CREATE TABLE IF NOT EXISTS prompt_registry (
			hash TEXT PRIMARY KEY,
			content TEXT NOT NULL,
			role TEXT,
			created_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS analyzer_configs (
			id TEXT PRIMARY KEY,
			analyzer_id TEXT NOT NULL,
			config_hash TEXT NOT NULL UNIQUE,
			config_json TEXT NOT NULL,
			label TEXT,
			created_at TEXT NOT NULL,
			FOREIGN KEY (analyzer_id) REFERENCES analyzer_defs(id)
		);

		-- ──────────────────── analysis graph (append-only) ────────────────────

		CREATE TABLE IF NOT EXISTS analysis_runs (
			id TEXT PRIMARY KEY,
			analyzer_id TEXT NOT NULL,
			analyzer_version_id TEXT NOT NULL,
			config_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			mode TEXT NOT NULL DEFAULT 'fill',
			status TEXT NOT NULL DEFAULT 'ok',
			prompt_bundle_hash TEXT NOT NULL DEFAULT '',
			model_spec TEXT,
			started_at TEXT NOT NULL,
			finished_at TEXT,
			nodes_produced INTEGER NOT NULL DEFAULT 0,
			nodes_skipped INTEGER NOT NULL DEFAULT 0,
			cost_usd REAL NOT NULL DEFAULT 0,
			tokens_used INTEGER NOT NULL DEFAULT 0,
			error_message TEXT
		);

		CREATE TABLE IF NOT EXISTS analysis_nodes (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			analyzer_id TEXT NOT NULL,
			analyzer_version_id TEXT NOT NULL,
			config_id TEXT NOT NULL,
			run_id TEXT,
			node_kind TEXT NOT NULL,
			content_json TEXT NOT NULL,
			source_set_hash TEXT NOT NULL,
			input_key TEXT NOT NULL UNIQUE,
			output_key TEXT NOT NULL DEFAULT '',
			config_fingerprint TEXT NOT NULL DEFAULT '',
			model_used TEXT,
			cost_usd REAL,
			tokens_used INTEGER,
			duration_ms INTEGER,
			created_at TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		CREATE TABLE IF NOT EXISTS analysis_edges (
			id TEXT PRIMARY KEY,
			from_node_id TEXT NOT NULL,
			to_ref_kind TEXT NOT NULL,
			to_ref_id TEXT NOT NULL,
			edge_kind TEXT NOT NULL,
			ordinal INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY (from_node_id) REFERENCES analysis_nodes(id)
		);
	`);

	// Full-text virtual table (must be recreated to sync with messages table changes)
	db.exec(`
		DROP TABLE IF EXISTS messages_fts;
		CREATE VIRTUAL TABLE messages_fts USING fts5(
			content_text,
			content_thinking,
			content='messages',
			content_rowid='rowid'
		);

		DROP TRIGGER IF EXISTS messages_ai;
		CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO messages_fts(rowid, content_text, content_thinking)
			VALUES (NEW.rowid, NEW.content_text, NEW.content_thinking);
		END;

		DROP TRIGGER IF EXISTS messages_ad;
		CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking)
			VALUES ('delete', OLD.rowid, OLD.content_text, OLD.content_thinking);
		END;
	`);

	// Schema evolution: add missing columns for older databases.
	// Separate from table creation because indexes may reference columns.
	// Also clean up any partial migration artifacts.
	cleanupPartialMigrations(db);
	addMissingColumns(db);

	// Create indexes after schema evolution (they may reference new columns)
	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
		CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
		CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
		CREATE INDEX IF NOT EXISTS idx_sessions_file ON sessions(file_path);
		CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source);

		CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
		CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
		CREATE INDEX IF NOT EXISTS idx_proposals_dedup ON proposals(input_key);

		CREATE INDEX IF NOT EXISTS idx_decisions_input_key ON proposal_decisions(proposal_input_key);
		CREATE INDEX IF NOT EXISTS idx_decisions_remediation ON proposal_decisions(remediation_id);

		-- Group nodes into logical units (analyzer + source set) for the
		-- version-alternative timeline, and look up by recipe identity.
		CREATE INDEX IF NOT EXISTS idx_nodes_unit ON analysis_nodes(analyzer_id, source_set_hash);
		CREATE INDEX IF NOT EXISTS idx_nodes_output ON analysis_nodes(output_key);
		CREATE INDEX IF NOT EXISTS idx_nodes_session ON analysis_nodes(session_id);
		CREATE INDEX IF NOT EXISTS idx_nodes_analyzer ON analysis_nodes(analyzer_id);

		CREATE INDEX IF NOT EXISTS idx_edges_from ON analysis_edges(from_node_id);
		CREATE INDEX IF NOT EXISTS idx_edges_to ON analysis_edges(to_ref_id, edge_kind);
		CREATE INDEX IF NOT EXISTS idx_edges_kind ON analysis_edges(edge_kind);
	`);
}

/**
 * Clean up partial migration artifacts that may exist from interrupted migrations.
 */
function cleanupPartialMigrations(db: Database.Database): void {
	// Drop proposals_old if it exists (leftover from failed v1→v2 migration)
	db.exec("DROP TABLE IF EXISTS proposals_old");

	// Drop the old indexes that referenced old column names
	db.exec("DROP INDEX IF EXISTS idx_nodes_input_hash");
	db.exec("DROP INDEX IF EXISTS idx_nodes_config");
}

/**
 * Add missing columns to existing tables. This handles schema evolution for
 * databases created before these columns were added. We check if the column
 * exists before adding it, since SQLite doesn't support IF NOT EXISTS on ALTER.
 */
function addMissingColumns(db: Database.Database): void {
	const hasColumn = (table: string, column: string): boolean => {
		const rows = db
			.prepare(`PRAGMA table_info(${table})`)
			.all() as Array<{ name: string; type: string }>;
		return rows.some((r) => r.name === column);
	};

	// sessions: add source column if missing
	if (!hasColumn("sessions", "source")) {
		db.exec("ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'pi'");
		db.exec("UPDATE sessions SET source = 'pi' WHERE source IS NULL");
	}

	// messages: add source column if missing
	if (!hasColumn("messages", "source")) {
		db.exec("ALTER TABLE messages ADD COLUMN source TEXT DEFAULT 'pi'");
		db.exec("UPDATE messages SET source = 'pi' WHERE source IS NULL");
	}

	// proposals v2: check if it has v1 schema (has "target" instead of "title")
	// and migrate to v2
	if (!hasColumn("proposals", "title") && hasColumn("proposals", "target")) {
		migrateProposalsToV2(db);
	}

	// analysis_nodes: rename input_hash to input_key, add output_key and config_fingerprint
	if (!hasColumn("analysis_nodes", "input_key")) {
		if (hasColumn("analysis_nodes", "input_hash")) {
			db.exec("ALTER TABLE analysis_nodes RENAME COLUMN input_hash TO input_key");
		}
	}
	if (!hasColumn("analysis_nodes", "output_key")) {
		db.exec("ALTER TABLE analysis_nodes ADD COLUMN output_key TEXT DEFAULT ''");
		db.exec("UPDATE analysis_nodes SET output_key = '' WHERE output_key IS NULL");
	}
	if (!hasColumn("analysis_nodes", "config_fingerprint")) {
		db.exec("ALTER TABLE analysis_nodes ADD COLUMN config_fingerprint TEXT DEFAULT ''");
		db.exec("UPDATE analysis_nodes SET config_fingerprint = '' WHERE config_fingerprint IS NULL");
	}

	// analysis_runs: add missing columns
	if (!hasColumn("analysis_runs", "mode")) {
		db.exec("ALTER TABLE analysis_runs ADD COLUMN mode TEXT DEFAULT 'fill'");
		db.exec("UPDATE analysis_runs SET mode = 'fill' WHERE mode IS NULL");
	}
	if (!hasColumn("analysis_runs", "nodes_produced")) {
		db.exec("ALTER TABLE analysis_runs ADD COLUMN nodes_produced INTEGER DEFAULT 0");
		db.exec("UPDATE analysis_runs SET nodes_produced = 0 WHERE nodes_produced IS NULL");
	}
	if (!hasColumn("analysis_runs", "nodes_skipped")) {
		db.exec("ALTER TABLE analysis_runs ADD COLUMN nodes_skipped INTEGER DEFAULT 0");
		db.exec("UPDATE analysis_runs SET nodes_skipped = 0 WHERE nodes_skipped IS NULL");
	}

	// proposal_decisions: link decisions to a shared remediation (databases
	// created before the remediations table existed)
	if (!hasColumn("proposal_decisions", "remediation_id")) {
		db.exec("ALTER TABLE proposal_decisions ADD COLUMN remediation_id TEXT");
	}

	// analysis_edges: add missing id and ordinal columns
	if (!hasColumn("analysis_edges", "id")) {
		db.exec("ALTER TABLE analysis_edges ADD COLUMN id TEXT");
	}
	if (!hasColumn("analysis_edges", "ordinal")) {
		db.exec("ALTER TABLE analysis_edges ADD COLUMN ordinal INTEGER DEFAULT 0");
		db.exec("UPDATE analysis_edges SET ordinal = 0 WHERE ordinal IS NULL");
	}
}

/**
 * Migrate proposals table from v1 to v2 by recreating with correct schema.
 * V1 had: id, created_at, session_id, target, severity, summary, detail, evidence, status, dedup_hash, source_node_id
 * V2 has: id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, target_path, title, severity, summary, detail, evidence, confidence, status, input_key, source_message_ids, validated_score, validation_status, validation_node_id
 */
function migrateProposalsToV2(db: Database.Database): void {
	// Rename existing proposals to proposals_old (backup)
	db.exec("ALTER TABLE proposals RENAME TO proposals_old");
	// Create new table with correct schema
	db.exec(`CREATE TABLE proposals (
		id TEXT PRIMARY KEY,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		session_id TEXT NOT NULL,
		source_node_id TEXT,
		analyzer_id TEXT,
		target_type TEXT NOT NULL,
		target_path TEXT,
		title TEXT NOT NULL,
		severity TEXT NOT NULL,
		summary TEXT NOT NULL,
		detail TEXT,
		evidence TEXT,
		confidence REAL,
		status TEXT NOT NULL DEFAULT 'open',
		input_key TEXT NOT NULL,
		source_message_ids TEXT,
		validated_score REAL,
		validation_status TEXT NOT NULL DEFAULT 'unvalidated',
		validation_node_id TEXT,
		FOREIGN KEY (session_id) REFERENCES sessions(id)
	)`);
	// Copy data with column mapping
	db.exec(`INSERT INTO proposals SELECT
		id, created_at, created_at AS updated_at, session_id, source_node_id, NULL AS analyzer_id,
		target AS target_type, NULL AS target_path, summary AS title, severity, summary, detail, evidence, confidence,
		status, dedup_hash AS input_key, NULL AS source_message_ids, NULL AS validated_score,
		'unvalidated' AS validation_status, NULL AS validation_node_id
		FROM proposals_old`);
	db.exec("DROP TABLE proposals_old");
}