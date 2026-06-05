#!/usr/bin/env bash
#
# guard-no-graphql-tag.sh
#
# Fails the build if any handwritten source file imports `graphql-tag`. The
# point: prevent regressions after the codegen `documentMode: 'documentNode'`
# migration. Once the runtime parser is gone, every new file should use the
# generated SDK / typed documents — a `graphql-tag` import means someone is
# pulling the parser back into the bundle.
#
# Allowlist: paths or globs in `.graphql-tag-allowlist` at the store root are
# exempt. Use sparingly, comment why, and review periodically.
#
# Always-ignored paths (no allowlist entry needed):
#   - src/generated/**     (codegen output — gets cleaned up by the migration)
#   - **/*.graphql         (.graphql files don't import anything anyway)
#
# Wired into the build chain via `pnpm guard:no-graphql-tag` — see
# package.json scripts.
#
# Exit codes:
#   0  no offending imports
#   1  one or more offenders; their paths are printed
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST_FILE="$STORE_ROOT/.graphql-tag-allowlist"
SEARCH_DIR="$STORE_ROOT/src"

if [ ! -d "$SEARCH_DIR" ]; then
    echo "guard-no-graphql-tag: $SEARCH_DIR not found, skipping"
    exit 0
fi

# Pattern matches both quote styles and both default and named imports:
#   import gql from 'graphql-tag'
#   import gql from "graphql-tag"
#   import { gql } from 'graphql-tag'
#   import gql, { ... } from 'graphql-tag'
PATTERN="from ['\"]graphql-tag['\"]"

cd "$STORE_ROOT"

# grep across src, scoped to TS/TSX/JS/JSX, excluding generated/.
# `|| true` so grep's exit-1 on no-match doesn't trip set -e.
RAW_HITS="$(
    grep -rlE "$PATTERN" src \
        --include='*.ts' \
        --include='*.tsx' \
        --include='*.js' \
        --include='*.jsx' \
        --include='*.mts' \
        --include='*.mjs' \
        --exclude-dir='generated' \
    || true
)"

if [ -z "$RAW_HITS" ]; then
    echo "✅ guard-no-graphql-tag: clean"
    exit 0
fi

# Apply allowlist: drop paths that match any allowlist entry.
# Allowlist supports literal paths and shell globs (matched via bash extglob).
ALLOWLIST_ENTRIES=()
if [ -f "$ALLOWLIST_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        trimmed="$(echo "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        [ -z "$trimmed" ] && continue
        case "$trimmed" in \#*) continue ;; esac
        ALLOWLIST_ENTRIES+=("$trimmed")
    done < "$ALLOWLIST_FILE"
fi

shopt -s extglob globstar nullglob

is_allowlisted() {
    local path="$1"
    local pattern
    for pattern in "${ALLOWLIST_ENTRIES[@]:-}"; do
        # Literal match
        if [ "$path" = "$pattern" ]; then
            return 0
        fi
        # Glob match (Bash globbing)
        # shellcheck disable=SC2053
        if [[ "$path" == $pattern ]]; then
            return 0
        fi
    done
    return 1
}

OFFENDERS=()
while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    if is_allowlisted "$hit"; then
        continue
    fi
    OFFENDERS+=("$hit")
done <<< "$RAW_HITS"

if [ "${#OFFENDERS[@]}" -gt 0 ]; then
    echo ""
    echo "❌ guard-no-graphql-tag: forbidden 'graphql-tag' imports detected"
    echo ""
    for f in "${OFFENDERS[@]}"; do
        echo "   $f"
    done
    echo ""
    echo "Either:"
    echo "  1. Remove the import and use the generated SDK / typed documents"
    echo "     from src/generated/graphql-shop.ts (preferred)."
    echo "  2. If the file legitimately needs runtime gql (e.g. dynamic query"
    echo "     interpolation), add its path to .graphql-tag-allowlist with a"
    echo "     comment justifying the exemption."
    echo ""
    exit 1
fi

echo "✅ guard-no-graphql-tag: clean"
exit 0
