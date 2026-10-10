-- Anonymous usage reports (#290). The Worker checks every value before it
-- writes; these constraints repeat the ranges so a bug there can't store junk.

CREATE TABLE usage_daily (
	day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	install_id TEXT NOT NULL CHECK (length(install_id) = 36),
	version TEXT NOT NULL CHECK (length(version) <= 14),
	analyzer TEXT NOT NULL CHECK (length(analyzer) BETWEEN 1 AND 48),
	harness TEXT NOT NULL CHECK (harness IN ('pi', 'claude')),
	runs INTEGER NOT NULL CHECK (runs BETWEEN 0 AND 10000000),
	runs_failed INTEGER NOT NULL CHECK (runs_failed BETWEEN 0 AND 10000000),
	sessions INTEGER NOT NULL CHECK (sessions BETWEEN 0 AND 10000000),
	nodes INTEGER NOT NULL CHECK (nodes BETWEEN 0 AND 10000000),
	duration_sec INTEGER NOT NULL CHECK (duration_sec BETWEEN 0 AND 10000000),
	proposals INTEGER NOT NULL CHECK (proposals BETWEEN 0 AND 10000000),
	friction INTEGER NOT NULL CHECK (friction BETWEEN 0 AND 10000000),
	correction INTEGER NOT NULL CHECK (correction BETWEEN 0 AND 10000000),
	waste INTEGER NOT NULL CHECK (waste BETWEEN 0 AND 10000000),
	suggestion INTEGER NOT NULL CHECK (suggestion BETWEEN 0 AND 10000000),
	reinforcement INTEGER NOT NULL CHECK (reinforcement BETWEEN 0 AND 10000000),
	accepted INTEGER NOT NULL CHECK (accepted BETWEEN 0 AND 10000000),
	rejected INTEGER NOT NULL CHECK (rejected BETWEEN 0 AND 10000000),
	accepted_modified INTEGER NOT NULL CHECK (accepted_modified BETWEEN 0 AND 10000000),
	PRIMARY KEY (day, install_id, analyzer, harness)
);

-- Rows written per UTC day, for the Worker's daily cap.
CREATE TABLE daily_writes (
	day TEXT PRIMARY KEY,
	rows INTEGER NOT NULL
);
