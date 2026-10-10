/**
 * Loaded before every test file (`--import`). Keeps the suite hermetic against
 * the developer's machine:
 *
 *   - the rule-restatement check reads harness instruction files from the home
 *     directory, so without this a test's outcome would depend on whether
 *     `~/.pi/agent/AGENTS.md` happens to exist;
 *   - a command test that sets only one of the two session directories would
 *     otherwise discover the other from its default under the home directory
 *     and ingest the developer's real transcripts. CI has no session history,
 *     so only a developer machine shows it, as a slow suite.
 *
 * Tests that exercise these paths point them at temp directories of their own.
 */
process.env["PROSPECTOR_INSTRUCTIONS_HOME"] = "/nonexistent/prospector-test-home";
// An empty value counts as unset: config reads it with `??`, so "" would be
// used as a path relative to the working directory.
process.env["PROSPECTOR_SESSIONS_DIR"] ||= "/nonexistent/prospector-test-sessions";
process.env["PROSPECTOR_CLAUDE_SESSIONS_DIR"] ||= "/nonexistent/prospector-test-claude-sessions";
// Usage reports (#290): no test may read or write the developer's consent file
// or send a report. Tests of the telemetry code clear these for themselves.
process.env["PROSPECTOR_TELEMETRY_DISABLED"] = "1";
process.env["PROSPECTOR_TELEMETRY_FILE"] = "/nonexistent/prospector-test-telemetry.json";
