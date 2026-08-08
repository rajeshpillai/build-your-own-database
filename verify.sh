#!/usr/bin/env bash
# Everything this engine claims, checked.
#
#   ./verify.sh
#
# Two parts. The unit checks in tests/run.ts cover each piece on its own, and the
# assertions below drive the finished thing from the outside — the same way
# somebody who cloned this would.

set -uo pipefail

FAILED=0
TMP_DIR="${TMP_DIR:-.}"
export TMP_DIR

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

echo "finch — the finished engine"
echo

UNIT=$(node tests/run.ts 2>&1) || { echo "$UNIT"; exit 1; }
check "unit checks" "passed" "$(grep -q 'checks passed' <<<"$UNIT" && echo passed)"
printf '        %s\n' "$(tail -1 <<<"$UNIT")"

echo
COSTS=$(node main.ts costs 2>&1) || { echo "$COSTS"; exit 1; }
check "step 1, bytes on disk"   "29,677"    "$(field 'bytes on disk' "$COSTS")"
check "step 1, bytes written"   "7,368,161" "$(field 'bytes written' "$COSTS")"
check "step 1, amplification"   "248.3x"    "$(field amplification "$COSTS")"

echo
MAP=$(node tools/pagemap.ts 2>&1) || { echo "$MAP"; exit 1; }
check "rows on one page"        "93"        "$(field rows "$MAP")"
check "page size"               "4096"      "$(field 'page size' "$MAP")"

echo
SHAPE=$(ROWS=60000 node tools/treeshape.ts 2>&1) || { echo "$SHAPE"; exit 1; }
check "60,000 rows, height"     "3"         "$(field height "$SHAPE")"
check "pages per lookup"        "3"         "$(field 'lookup reads' "$SHAPE")"
check "pages per scan"          "1,486"     "$(field 'scan reads' "$SHAPE")"

echo
DEMO=$(node main.ts demo 2>&1) || { echo "$DEMO"; exit 1; }
check "a scan examines them all" "yes" \
  "$(grep -q '1 row, 5,000 examined' <<<"$DEMO" && echo yes)"
check "an index does not"        "yes" \
  "$(grep -q 'index lookup users_age' <<<"$DEMO" && echo yes)"
check "a checkpoint empties log" "yes" \
  "$(grep -q 'pages in the file     112' <<<"$DEMO" && echo yes)"

echo
[ "$FAILED" -eq 0 ] && echo "all checks passed" || echo "SOME CHECKS FAILED"
exit "$FAILED"
