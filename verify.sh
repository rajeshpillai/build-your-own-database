#!/usr/bin/env bash
# Assertions for this step. Run by the course build, and by anyone who clones this.
#
#   ./verify.sh
#
# A step that cannot answer these is broken, and a broken step is a lecture that
# teaches something that does not work.
#
# Every number below is pure computation over a fixed workload, so it is
# identical on every machine and on every run. That is deliberate: a figure that
# moves between runs cannot be spoken in narration, because the next capture
# would contradict it. Nothing here is timed for the same reason.

set -uo pipefail

DB="${DB:-./finch-verify-$$.pages}"
export DB
FAILED=0

cleanup() { rm -f "$DB" "$DB.pages"; }
trap cleanup EXIT

# check <label> <expected> <actual>
#
# The 28-character label column is not cosmetic. This output is replayed in the
# deck's terminal pane, which holds about 56 characters and CLIPS rather than
# wraps — a longer line loses its right-hand column silently, and the log still
# says every check passed. build.py enforces the width; this format stays inside.
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf '  ok    %-28s %s\n' "$label" "$actual"
  else
    printf '  FAIL  %-28s\n        expected: %s\n        actual:   %s\n' \
      "$label" "$expected" "$actual"
    FAILED=1
  fi
}

field() { sed -n "s/^$1 *//p" <<<"$2" | head -1; }

echo "step 3 — a pager, and its cache"
echo

OUT=$(node main.ts 2>&1) || { echo "$OUT"; exit 1; }

check "pages on disk"          "500"    "$(field 'pages on disk' "$OUT")"
check "cache capacity"         "64"     "$(field 'cache capacity' "$OUT")"

# The workload a cache is for: three pages, read a thousand times.
echo
check "hot reads"              "1,000"  "$(field 'hot pages, reads' "$OUT")"
check "hot hits"               "997"    "$(field 'hot pages, hits' "$OUT")"
check "hot disk reads"         "3"      "$(field 'hot pages, disk' "$OUT")"
check "hot bytes off disk"     "12,288" "$(field 'hot pages, bytes' "$OUT")"

# And the workload it is wrong for. Not "less effective" — zero hits, twice.
echo
check "scan reads"             "1,000"  "$(field 'scan, reads' "$OUT")"
check "scan hits"              "0"      "$(field 'scan, hits' "$OUT")"
check "scan disk reads"        "1,000"  "$(field 'scan, disk' "$OUT")"
check "scan evictions"         "936"    "$(field 'scan, evictions' "$OUT")"

# The previous step's comparison still holds.
echo
CURVE=$(node tools/curve.ts 2>&1) || { echo "$CURVE"; exit 1; }
check "at 100 rows"            "0.7x"   "$(awk '$1==100 {print $NF}' <<<"$CURVE")"
check "at 500 rows"            "3.6x"   "$(awk '$1==500 {print $NF}' <<<"$CURVE")"

echo
[ "$FAILED" -eq 0 ] && echo "all checks passed" || echo "SOME CHECKS FAILED"
exit "$FAILED"
