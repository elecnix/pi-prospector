/**
 * Loaded before every test file (`--import`). Keeps the suite hermetic against
 * the developer's machine: the rule-restatement check reads harness instruction
 * files from the home directory, so without this a test's outcome would depend
 * on whether `~/.pi/agent/AGENTS.md` happens to exist. Tests that exercise the
 * check point this at a temp directory of their own.
 */
process.env["PROSPECTOR_INSTRUCTIONS_HOME"] = "/nonexistent/prospector-test-home";
