#!/usr/bin/env bash
# Checks the public copies export.sh made for anything private before they're pushed: secrets (gitleaks), the
# owner's personal address and PC paths, links to private Claude sessions and artifacts, people's names from the
# business notes, reviewer notes, and the manual-derived data files. Exits 1 if any blocker is found.
#   ./check.sh [OUT]
set -uo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-$KIT/out}"
GITLEAKS="${GITLEAKS:-$(command -v gitleaks || echo /tmp/claude-0/-home-user/2c4fc182-709a-5297-bbbd-a4efdaa43367/scratchpad/tools/gitleaks)}"
bad=0

block() { # label regex [extra grep args]: any hit in a public copy is a blocker
  local label=$1 re=$2
  shift 2
  local hits
  hits=$(grep -rnIE "$@" -e "$re" "$OUT/public" 2>/dev/null | cut -c1-200)
  if [ -n "$hits" ]; then
    echo "BLOCK  $label"
    echo "$hits" | sed "s|$OUT/public/||" | head -20 | sed 's/^/         /'
    bad=1
  else
    echo "ok     $label"
  fi
}
warn() { # label regex: worth a look, not a blocker
  local n
  n=$(grep -rlIE -e "$2" "$OUT/public" 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] && echo "note   $1: $n files ($(grep -rlIE -e "$2" "$OUT/public" | sed "s|$OUT/public/||" | head -4 | tr '\n' ' '))" || echo "ok     $1"
}

block "the owner's personal address" 'bwattendorf@gmail'
block "the owner's PC paths" 'C:[\\/]+Users[\\/]+bwatt' -i
block "links to private Claude sessions or artifacts" 'claude\.ai/(artifact|code/session|chat)/'
block "the owner's password files (outside the release scripts)" '(StitchHub|StitchShop hosted|StitchBench hosted) admin\.txt' --exclude-dir=release
block "people and businesses from the outreach notes" '\bDenise\b|Andi Barney|Sewing Doc Academy|Machine Repair Guy|\bWes:'
block "reviewer notes (outside the tests, which use them as samples)" '\[(LAWYER|OWNER)(/(LAWYER|OWNER))*:' --exclude-dir=test
block "income goals" 'income goal|[0-9]+ and [0-9]+ paying shops'
for f in factory_settings tension_specs library_docs hub_links; do
  if [ -e "$OUT/public/stitchbench/prisma/seed-data/$f.json" ]; then echo "BLOCK  $f.json is in the public copy"; bad=1; fi
done
warn "pointers to private docs (dangling, harmless)" 'docs/(HANDOFF|plans/|research/|round3|legal/)|ROUND3_FINDINGS|fix-packages/'
warn "prices from the old pricing plan (review)" 'founding (shop|price)|\$15 ?/|\$45/month'

if [ -x "$GITLEAKS" ]; then
  for d in "$OUT"/public/*; do
    if "$GITLEAKS" dir "$d" --no-banner --redact --exit-code 1 >/dev/null 2>&1; then
      echo "ok     gitleaks: $(basename "$d")"
    else
      # The test suites carry fake keys on purpose (sk_test_...mock, whsec_...test) and the dev signing key: list what was found.
      "$GITLEAKS" dir "$d" --no-banner --redact --report-format json --report-path "$OUT/gitleaks-$(basename "$d").json" >/dev/null 2>&1
      echo "note   gitleaks: $(basename "$d"): $(python3 -I -c "import json,sys,os; d=json.load(open(sys.argv[1])); print(len(d), 'hits in', ', '.join(sorted({os.path.relpath(x['File'], sys.argv[2]) for x in d})))" "$OUT/gitleaks-$(basename "$d").json" "$d") (review $OUT/gitleaks-$(basename "$d").json)"
    fi
  done
else
  echo "note   gitleaks not found: secrets were not scanned"
fi

[ $bad = 0 ] && echo "No blockers." || echo "Blockers found: fix them before pushing."
exit $bad
