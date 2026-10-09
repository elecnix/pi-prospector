#!/usr/bin/env bash
# Time `npm test` with src/db/async-db.ts from main ("before") and from this
# branch ("after"), alternating on one runner, so runner-to-runner variance
# drops out of the comparison. A first run warms tsx's transform cache and
# is discarded. Temporary: remove before merging.
set -uo pipefail

rounds=${ROUNDS:-3}
file=src/db/async-db.ts
cp "$file" /tmp/after.ts
git show origin/main:"$file" > /tmp/before.ts

TIMEFORMAT='%R %U %S'
run() { # variant round
	cp "/tmp/$1.ts" "$file"
	local status=0
	{ time npm test > /dev/null 2>&1; } 2> /tmp/time.txt || status=$?
	read -r wall user sys < /tmp/time.txt
	echo "$1 $2 $wall $user $sys $status" | tee -a results.txt
}

run after warmup > /dev/null
: > results.txt
for i in $(seq "$rounds"); do
	run before "$i"
	run after "$i"
done
cp /tmp/after.ts "$file"

{
	echo "### A/B timing of \`npm test\` on one runner ($(node --version), $(nproc) cores)"
	echo
	echo "| variant | round | wall (s) | CPU (s) | exit |"
	echo "| --- | ---: | ---: | ---: | ---: |"
	awk '{ printf "| %s | %s | %.1f | %.1f | %s |\n", $1, $2, $3, $4 + $5, $6 }' results.txt
	echo
	for v in before after; do
		n=$(awk -v v="$v" '$1 == v' results.txt | wc -l)
		mid=$(( (n + 1) / 2 ))
		wall=$(awk -v v="$v" '$1 == v { print $3 }' results.txt | sort -n | sed -n "${mid}p")
		cpu=$(awk -v v="$v" '$1 == v { print $4 + $5 }' results.txt | sort -n | sed -n "${mid}p")
		echo "${v} median: wall ${wall} s, CPU ${cpu} s"
		echo
	done
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if awk '$6 != 0 { bad = 1 } END { exit !bad }' results.txt; then
	echo "a timed run failed" >&2
	exit 1
fi
