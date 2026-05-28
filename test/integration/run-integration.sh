#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$REPO_DIR"

echo "═══════════════════════════════════════════"
echo "  pi-prospector integration tests (direct)"
echo "═══════════════════════════════════════════"
echo ""

node --import tsx "$SCRIPT_DIR/test-commands.ts"