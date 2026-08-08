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

cleanup() { rm -f "$DB"; }
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

echo "step 1 — a JSON file, and what it costs"
echo

OUT=$(node main.ts 2>&1) || { echo "$OUT"; exit 1; }

check "rows stored"            "500"       "$(field 'rows stored' "$OUT")"
check "bytes on disk"          "29,677"    "$(field 'bytes on disk' "$OUT")"
check "bytes written"          "7,368,161" "$(field 'bytes written' "$OUT")"
check "write amplification"    "248.3x"    "$(field amplification "$OUT")"
check "rows examined"          "500 of 500" "$(field 'rows examined' "$OUT")"

# The crash. It exits non-zero on purpose, so the run is not the check — what is
# left on the disk afterwards is.
#
# "rows recoverable" has to be MEASURED, by actually trying to read the file back.
# The first version of this line compared the string "0 of 500" against itself,
# which passes whatever the crash leaves behind and proves nothing at all.
echo
node main.ts crash >/dev/null 2>&1
LEFT=$(wc -c <"$DB" | tr -d ' ')

RECOVERED=$(node -e '
  const fs = require("node:fs");
  try {
    const rows = JSON.parse(fs.readFileSync(process.env.DB, "utf8"));
    console.log(`${Array.isArray(rows) ? rows.length : 0} of 500`);
  } catch {
    console.log("0 of 500");
  }
')
VALID=$(node -e '
  const fs = require("node:fs");
  try {
    JSON.parse(fs.readFileSync(process.env.DB, "utf8"));
    console.log("yes");
  } catch {
    console.log("no");
  }
')

check "bytes left by the crash" "14838"     "$LEFT"
check "is it valid JSON"        "no"        "$VALID"
check "rows recoverable"        "0 of 500"  "$RECOVERED"

echo
[ "$FAILED" -eq 0 ] && echo "all checks passed" || echo "SOME CHECKS FAILED"
exit "$FAILED"
