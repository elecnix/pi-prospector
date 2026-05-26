#!/usr/bin/env bash
set -euo pipefail

# Integration test for pi-prospector extension commands
# Runs each slash command via `pi -p` and checks output

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.."")"
SCREENSHOT_DIR="$SCRIPT_DIR/screenshots"
mkdir -p "$SCREENSHOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass=0
fail=0
total=0

run_command() {
	local name="$1"
	local cmd="$2"
	local expected_pattern="$3"
	local timeout_sec="${4:-30}"

	total=$((total + 1))
	echo -n "  Testing $name ... "

	# Run pi with a timeout. The extension command outputs via console.log,
	# but pi then tries to get an LLM response (which may fail/timeout in CI).
	# We capture whatever output we get within the timeout.
	output_file=$(mktemp)
	exit_code=0
	timeout "$timeout_sec" pi --no-session -p "$cmd" > "$output_file" 2>&1 || exit_code=$?

	output=$(cat "$output_file")
	rm -f "$output_file"

	# Save screenshot
	echo "$output" > "$SCREENSHOT_DIR/${name// /_}.txt"

	# Check if expected pattern appears in output
	if echo "$output" | grep -qE "$expected_pattern"; then
		echo -e "${GREEN}PASS${NC}"
		pass=$((pass + 1))
	else
		echo -e "${RED}FAIL${NC}"
		echo "    Expected pattern: $expected_pattern"
		echo "    Got: $(echo "$output" | head -5)"
		fail=$((fail + 1))
	fi
}

echo "═══════════════════════════════════════════"
echo "  pi-prospector integration tests"
echo "═══════════════════════════════════════════"
echo ""

# Test 1: /prospect-stats (empty DB)
run_command "stats_empty" "/prospect-stats" "Sessions indexed" 15

# Test 2: /prospect-proposals (empty DB)
run_command "proposals_empty" "/prospect-proposals" "No proposals found" 15

echo ""
echo "═══════════════════════════════════════════"
echo -e "  Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC} (out of $total)"
echo "═══════════════════════════════════════════"
echo ""

if [ "$fail" -gt 0 ]; then
	exit 1
fi