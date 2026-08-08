#!/usr/bin/env bash
# Assertions for this step. Run by the course build, and by anyone who clones this.
#
#   ./verify.sh
#
# A step that cannot answer these is broken, and a broken step is a lecture that
# teaches something that does not work.
#
# Every number below is pure computation over 500 fixed rows, so it is identical
# on every machine and on every run. That is deliberate: a figure that moves
# between runs cannot be spoken in narration, because the next capture would
# contradict it.

set -uo pipefail

DB="${DB:-./finch-verify-$$.json}"
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

echo "step 2 — a file of fixed-size pages"
echo

OUT=$(node main.ts 2>&1)         || { echo "$OUT"; exit 1; }
CURVE=$(node tools/curve.ts 2>&1) || { echo "$CURVE"; exit 1; }

check "json bytes written"     "7,368,161" "$(field 'json bytes written' "$OUT")"
check "page bytes written"     "2,048,000" "$(field 'page bytes written' "$OUT")"
check "pages on disk"          "500"       "$(field 'pages on disk' "$OUT")"

# One page in, one page out. Step 1 read the whole file for this.
echo
check "row 400 found"          "user-400"  "$(field 'row 400 found' "$OUT")"
check "bytes read for it"      "4,096"     "$(field 'bytes read for it' "$OUT")"

# And what it cost. A 4 KiB page holding 61 bytes is a bad use of a page, and
# saying so here is the reason section 2 exists.
echo
check "bytes used per page"    "61"        "$(field 'bytes used per page' "$OUT")"
check "occupancy"              "1.5%"      "$(field occupancy "$OUT")"

# The shape, not the ratio. At 100 rows the pages are WORSE, because most of
# every page is empty. One grows with the square of the rows and one does not.
echo
check "at 100 rows"            "0.7x"      "$(awk '$1==100 {print $NF}' <<<"$CURVE")"
check "at 200 rows"            "1.4x"      "$(awk '$1==200 {print $NF}' <<<"$CURVE")"
check "at 500 rows"            "3.6x"      "$(awk '$1==500 {print $NF}' <<<"$CURVE")"

echo
[ "$FAILED" -eq 0 ] && echo "all checks passed" || echo "SOME CHECKS FAILED"
exit "$FAILED"
