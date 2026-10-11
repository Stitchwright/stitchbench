#!/usr/bin/env bash
# Builds the clean public copies of stitchbench, stitchhub and stitchsite, plus the private notes and data
# repositories, from the private clones. Nothing is pushed: everything lands in $OUT for checking (check.sh), and
# COMMIT=1 makes each output folder a git repository with one first commit.
#
#   ./export.sh                      # from origin/main (origin/master for stitchsite) of the clones in /home/user
#   BENCH_REF=before-public ./export.sh   # try it on a branch
#   COMMIT=1 AUTHOR_NAME=... AUTHOR_EMAIL=...@users.noreply.github.com ./export.sh
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
SRC="${SRC:-/home/user}"
OUT="${OUT:-$KIT/out}"
BENCH_REF="${BENCH_REF:-origin/main}"
HUB_REF="${HUB_REF:-origin/main}"
SITE_REF="${SITE_REF:-origin/master}"
export ORG="${ORG:-SiteSentrix}"
export HOLDER="${HOLDER:-SiteSentrix}"
export CONTACT="${CONTACT:-bwattendorfdev@gmail.com}"
export YEAR="${YEAR:-2026}"

T="$KIT/templates"
rm -rf "$OUT"
mkdir -p "$OUT/public" "$OUT/notes" "$OUT/data"

# Fill {{ORG}}, {{HOLDER}}, {{CONTACT}}, {{YEAR}}, {{LICENSE_NAME}} from the environment (perl: no escaping trouble
# with "&" or "/" in a value).
fill() { LICENSE_NAME="${LICENSE_NAME:-}" perl -pe 's/\{\{(ORG|HOLDER|CONTACT|YEAR|LICENSE_NAME)\}\}/$ENV{$1}/g' "$1"; }

snapshot() { # repo ref: the tracked files at ref, nothing else (no .git, no untracked or ignored files)
  echo "== $1 at $2 ($(git -C "$SRC/$1" rev-parse --short "$2"))"
  mkdir -p "$OUT/public/$1"
  git -C "$SRC/$1" archive "$2" | tar -x -C "$OUT/public/$1"
}

to_notes() { # repo path...: move paths out of the public copy into notes/<repo>/<where>
  local repo=$1 dest=$2
  shift 2
  for p in "$@"; do
    if [ -e "$OUT/public/$repo/$p" ]; then
      mkdir -p "$OUT/notes/$repo/$dest"
      mv "$OUT/public/$repo/$p" "$OUT/notes/$repo/$dest/"
    else
      echo "  (no $p in $repo)"
    fi
  done
}

add_common() { # repo license-name
  LICENSE_NAME="$2" fill "$T/common/SECURITY.md" >"$OUT/public/$1/SECURITY.md"
  LICENSE_NAME="$2" fill "$T/common/CONTRIBUTING.md" >"$OUT/public/$1/CONTRIBUTING.md"
  fill "$T/common/TRADEMARKS.md" >"$OUT/public/$1/TRADEMARKS.md"
}

set_license_field() { # package.json SPDX: adds or replaces "license", keeps the file's 2-space layout
  node -e '
    const fs = require("fs"); const [f, id] = process.argv.slice(1);
    const p = JSON.parse(fs.readFileSync(f, "utf8"));
    const out = {}; for (const [k, v] of Object.entries(p)) { out[k] = v; if (k === "version" && !("license" in p)) out.license = id; }
    if ("license" in p) out.license = id;
    if (!("license" in out)) out.license = id;
    fs.writeFileSync(f, JSON.stringify(out, null, 2) + "\n");
  ' "$1" "$2"
}

relink() { # repo: links to the old personal account's repositories point at the organization
  { grep -rlIZ --exclude-dir=node_modules -e "github.com/bwattendorf/" "$OUT/public/$1" 2>/dev/null || true; } |
    xargs -0 -r perl -pi -e 's{github\.com/bwattendorf/(stitchhub|stitchbench|stitchsite)}{"github.com/$ENV{ORG}/" . {stitchhub => "StitchHub", stitchbench => "StitchBench", stitchsite => "StitchSite"}->{$1}}ge'
}

# ---------- stitchbench (StitchBench and StitchShop) ----------
snapshot stitchbench "$BENCH_REF"
B="$OUT/public/stitchbench"
to_notes stitchbench . docs/HANDOFF.md docs/HUB_DAY.md docs/LAUNCH_CHECKLIST.md docs/CODE_SIGNING.md docs/test-modes.md \
  docs/plans docs/research docs/legal docs/round3
to_notes stitchbench tools scripts/hub/scrape_suppliers.py
cp "$B/CLAUDE.md" "$OUT/notes/stitchbench/CLAUDE.md"
cp "$B/AGENTS.md" "$OUT/notes/stitchbench/AGENTS.md"
for f in factory_settings tension_specs library_docs hub_links; do
  mv "$B/prisma/seed-data/$f.json" "$OUT/data/$f.json"
done
rm -rf "$B/scripts/library/__pycache__"
fill "$T/stitchbench/CLAUDE.md" >"$B/CLAUDE.md"
cp "$T/stitchbench/AGENTS.md" "$B/AGENTS.md"
cp "$SRC/stitchhub/LICENSE" "$B/LICENSE" # the canonical AGPL-3.0 text
add_common stitchbench "GNU Affero General Public License, version 3"
fill "$T/stitchbench/README-license.md" >>"$B/README.md"
set_license_field "$B/package.json" AGPL-3.0-only
set_license_field "$B/desktop/package.json" AGPL-3.0-only
# The installer's publisher (Windows "Apps" list) is the company now. appId stays: changing it would make the next
# installer put in a second copy beside the old one instead of updating it.
perl -pi -e 's/"author": "[^"]*"/"author": "$ENV{HOLDER}"/' "$B/desktop/package.json"
relink stitchbench

# ---------- stitchhub ----------
snapshot stitchhub "$HUB_REF"
H="$OUT/public/stitchhub"
to_notes stitchhub . docs/round3.md
mkdir -p "$OUT/notes/stitchhub/legal"
cp "$H"/legal/*.md "$OUT/notes/stitchhub/legal/"
python3 -I "$KIT/tools/strip_notes.py" "$H"/legal/*.md
add_common stitchhub "GNU Affero General Public License, version 3"
relink stitchhub

# ---------- stitchsite (the website) ----------
snapshot stitchsite "$SITE_REF"
S="$OUT/public/stitchsite"
mkdir -p "$OUT/notes/stitchsite"
mv "$S/README.md" "$OUT/notes/stitchsite/README.md" # the internal one: deploying, placeholders, open decisions
fill "$T/stitchsite/README.md" >"$S/README.md"
fill "$T/stitchsite/LICENSE" >"$S/LICENSE"
perl -pi -e 's/^export const COMPANY_NAME = ".*";/export const COMPANY_NAME = "$ENV{HOLDER}";/' "$S/src/lib/site.ts"
fill "$T/common/TRADEMARKS.md" >"$S/TRADEMARKS.md"
relink stitchsite

# ---------- private: notes and data ----------
fill "$T/notes/README.md" >"$OUT/notes/README.md"
fill "$T/notes/CLAUDE.md" >"$OUT/notes/CLAUDE.md"
fill "$T/data/README.md" >"$OUT/data/README.md"

echo
"$KIT/check.sh" "$OUT"

if [ "${COMMIT:-}" = 1 ]; then
  : "${AUTHOR_NAME:?set AUTHOR_NAME}" "${AUTHOR_EMAIL:?set AUTHOR_EMAIL (the GitHub noreply address)}"
  for d in "$OUT"/public/* "$OUT/notes" "$OUT/data"; do
    name=$(basename "$d")
    case "$name" in
      notes) first="Notes: the work log, plans and drafts moved out of the code repositories" ;;
      data) first="Reference data: the manual-derived files moved out of the public code" ;;
      *) first="$name: first public commit" ;;
    esac
    git -C "$d" init -q -b main
    git -C "$d" add -A
    printf '%s\n\nThe files as they were on %s. The history before this is in the archived private repositories.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_0167AacwvMt2HVgVq7v7RJNV\n' \
      "$first" "$(date +%Y-%m-%d)" >"$OUT/.msg"
    GIT_AUTHOR_NAME="$AUTHOR_NAME" GIT_AUTHOR_EMAIL="$AUTHOR_EMAIL" GIT_COMMITTER_NAME="$AUTHOR_NAME" \
      GIT_COMMITTER_EMAIL="$AUTHOR_EMAIL" git -C "$d" commit -q -F "$OUT/.msg"
    echo "committed $(basename "$d"): $(git -C "$d" rev-parse --short HEAD), $(git -C "$d" ls-files | wc -l) files"
  done
fi
