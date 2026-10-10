#!/usr/bin/env bash
# Run `npm test` and report its wall time and CPU time, so a pull request that
# changes test speed can be compared with the run before it.
#
# Bash's `time` reads the CPU time of every process the suite started and
# waited for: node's test runner, one process per test file, and the sqlite
# worker threads inside them. The report goes to the job summary and to a
# `::notice` line, which `gh run view --log` shows.
set -uo pipefail

TIMEFORMAT='%R %U %S'
status=0
{ time npm test > test.tap 2>&1; } 2> time.txt || status=$?
cat test.tap

read -r wall user sys < time.txt
cpu=$(awk -v u="$user" -v s="$sys" 'BEGIN { printf "%.1f", u + s }')
# Node 22 prints TAP when stdout is a file, and Node 24 prints the spec
# reporter's format. Both formats are parsed here.
tests=$(awk '/^(#|ℹ) tests /{print $3}' test.tap)
line="wall=${wall}s cpu=${cpu}s user=${user}s sys=${sys}s tests=${tests} cores=$(nproc) node=$(node --version)"
echo "::notice title=npm test timing::${line}"

{
	echo "### npm test timing"
	echo
	echo "| wall | CPU (user + sys) | tests | cores | node |"
	echo "| ---: | ---: | ---: | ---: | --- |"
	echo "| ${wall} s | ${cpu} s | ${tests} | $(nproc) | $(node --version) |"
	echo
	echo "Slowest top-level suites:"
	echo
	echo '| ms | suite |'
	echo '| ---: | --- |'
	awk '/^(not )?ok [0-9]+ - /{ sub(/^(not )?ok [0-9]+ - /, ""); name = $0 }
	     /^  duration_ms:/{ printf "%d\t%s\n", $2, name }
	     /^(✔|✖) .* \([0-9.]+ms\)$/{
	         ms = $NF; gsub(/[()ms]/, "", ms)
	         name = $0; sub(/^(✔|✖) /, "", name); sub(/ \([0-9.]+ms\)$/, "", name)
	         printf "%d\t%s\n", ms, name
	     }' test.tap |
		sort -rn | head -15 | awk -F'\t' '{ printf "| %s | %s |\n", $1, $2 }'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

exit "$status"
