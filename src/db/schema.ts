import Database from "better-sqlite3";

export function migrate(db: Database.Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			project TEXT NOT NULL DEFAULT '',
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
			parent_id TEXT,
			timestamp TEXT,
			role TEXT NOT NULL,
			content_text TEXT,
			content_thinking TEXT,
			tool_calls TEXT,
			tool_results TEXT,
			content_hash TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		CREATE TABLE IF NOT EXISTS proposals (
			id TEXT PRIMARY KEY,
			created_at TEXT NOT NULL,
			session_id TEXT NOT NULL,
			target TEXT NOT NULL,
			severity TEXT NOT NULL,
			summary TEXT NOT NULL,
			detail TEXT,
			evidence TEXT,
			status TEXT NOT NULL DEFAULT 'new',
			dedup_hash TEXT,
			FOREIGN KEY (session_id) REFERENCES sessions(id)
		);

		CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
		CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role);
		CREATE INDEX IF NOT EXISTS idx_proposals_session ON proposals(session_id);
		CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
		CREATE INDEX IF NOT EXISTS idx_proposals_dedup ON proposals(dedup_hash);
		CREATE INDEX IF NOT EXISTS idx_sessions_file ON sessions(file_path);

		DROP TABLE IF EXISTS messages_fts;
		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
			content_text,
			content_thinking,
			content='messages',
			content_rowid='rowid'
		);

		DROP TRIGGER IF EXISTS messages_ai;
		CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
			INSERT INTO messages_fts(rowid, content_text, content_thinking)
			VALUES (NEW.rowid, NEW.content_text, NEW.content_thinking);
		END;

		DROP TRIGGER IF EXISTS messages_ad;
		CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
			INSERT INTO messages_fts(messages_fts, rowid, content_text, content_thinking)
			VALUES ('delete', OLD.rowid, OLD.content_text, OLD.content_thinking);
		END;
	`);
}