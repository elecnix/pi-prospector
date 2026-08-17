#!/usr/bin/env bash
#
# One command for a day's session token report: index, analyse, render.
#
#   scripts/session-report.sh [YYYY-MM-DD|all] [extra --key value pairs...]
#
# Re-running is cheap. The sync only reads transcript lines it has not seen, the
# analyzers only compute units whose inputs changed, and rendering is a pure read
# of the graph that writes nothing back.
#
# Examples:
#   scripts/session-report.sh                          # today
#   scripts/session-report.sh 2026-08-14               # a specific day
#   scripts/session-report.sh 2026-08-14 --previews false
#   scripts/session-report.sh all --out /tmp/reports
set -euo pipefail

cd "$(dirname "$0")/.."

DAY="${1:-$(date +%F)}"
if [[ "$DAY" == --* ]]; then
	# No day given, only flags.
	DAY="$(date +%F)"
else
	shift || true
fi

DB="${PROSPECTOR_DB:-$HOME/.pi/agent/prospector.db}"

echo "▸ Indexing new transcript lines…"
npx tsx scripts/sync.ts | tail -n 5

# `--recent N` walks sessions by started_at DESC, so a session that began before
# the target day but ran into it is only reached when N is large enough. Count
# every session at least as new as the oldest one active that day.
if [[ "$DAY" == "all" ]]; then
	RECENT="$(sqlite3 "$DB" "SELECT COUNT(*) FROM sessions;" 2>/dev/null || echo 0)"
else
	LO="$(date -u -j -f "%Y-%m-%d" -v-1d "$DAY" "+%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -d "$DAY -1 day" "+%Y-%m-%dT%H:%M:%S.000Z")"
	HI="$(date -u -j -f "%Y-%m-%d" -v+2d "$DAY" "+%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || date -u -d "$DAY +2 days" "+%Y-%m-%dT%H:%M:%S.000Z")"
	RECENT="$(sqlite3 "$DB" "
	  SELECT COUNT(*) FROM sessions
	  WHERE started_at IS NOT NULL
	    AND started_at >= COALESCE((
	      SELECT MIN(s.started_at) FROM sessions s
	      JOIN messages m ON m.session_id = s.id
	      WHERE m.timestamp >= '$LO' AND m.timestamp < '$HI'
	        AND s.started_at IS NOT NULL
	    ), '9999');" 2>/dev/null || echo 0)"
fi

if [[ "${RECENT:-0}" -gt 0 ]]; then
	# Brace every expansion that abuts a non-ASCII character: macOS ships bash 3.2,
	# which reads the following multi-byte glyph as part of the variable name.
	echo "▸ Analysing the ${RECENT} session(s) covering ${DAY}…"
	# Two explicit passes: a bare analyze would also run the expensive built-ins.
	pi -ne -e ./src/index.ts --prospect "analyze --analyzer token-units --recent ${RECENT}" | tail -n 4
	pi -ne -e ./src/index.ts --prospect "analyze --analyzer request-classes --recent ${RECENT}" | tail -n 4
else
	echo "▸ No indexed sessions touch ${DAY} — rendering an empty report."
fi

echo "▸ Rendering…"
pi -ne -e ./src/index.ts --prospect "output token-units --day ${DAY} $*"
