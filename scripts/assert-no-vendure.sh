#!/usr/bin/env bash
# assert-no-vendure.sh — hard CI gate: SellRight's storefront and API are
# fully native. No Vendure identifiers, storage keys, comments, asset paths,
# or leftover GraphQL/codegen plumbing may exist in the scanned trees.
#
# Scans (fails the build if ANY match is found):
#   - packages/storefront            (entire tree, source + config + assets)
#   - packages/api/src               (excluding src/import/** — the one-time
#                                      Vendure/Woo data importer, which is
#                                      explicitly allowed to reference the
#                                      source system it imports FROM)
#
# Forbidden patterns (case-insensitive where noted):
#   /vendure/i   - the word "vendure" anywhere (identifiers, comments, paths)
#   graphql      - GraphQL is retired in favor of the native OpenAPI client
#   gql`         - a graphql-tag template literal
#   @vendure     - a Vendure package import specifier
#   __typename   - GraphQL discriminated-union introspection field
#
# Usage: bash scripts/assert-no-vendure.sh
set -euo pipefail

cd "$(dirname "$0")/.."

FAIL=0

# Directories to scan, each paired with an optional exclude glob (relative to
# repo root, passed to grep --exclude-dir / find pruning).
scan() {
	local label="$1" dir="$2" exclude_dir="${3:-}"
	local pattern='vendure|graphql|gql`|@vendure|__typename'

	[ -d "$dir" ] || return 0

	local grep_args=(-r -n -I -i -E "$pattern" "$dir" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.turbo --exclude-dir=coverage)
	if [ -n "$exclude_dir" ]; then
		grep_args+=(--exclude-dir="$(basename "$exclude_dir")")
	fi

	local matches
	matches=$(grep "${grep_args[@]}" 2>/dev/null || true)

	if [ -n "$exclude_dir" ]; then
		# grep --exclude-dir only matches by basename anywhere in the tree, which
		# is what we want here since import/ only exists once under api/src.
		:
	fi

	if [ -n "$matches" ]; then
		echo "== $label: forbidden pattern found =="
		echo "$matches"
		echo
		FAIL=1
	fi
}

scan "packages/storefront" "packages/storefront"
scan "packages/api/src (excluding src/import/**)" "packages/api/src" "packages/api/src/import"

# Also forbid the literal filename/dep footprint of the retired GraphQL
# toolchain anywhere those two trees might reintroduce it.
LEFTOVER_FILES=$(find packages/storefront packages/api/src -type f \( -iname '*.graphql' -o -iname '*codegen*' \) -not -path '*/node_modules/*' -not -path '*/import/*' 2>/dev/null || true)
if [ -n "$LEFTOVER_FILES" ]; then
	echo "== leftover GraphQL/codegen files =="
	echo "$LEFTOVER_FILES"
	echo
	FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
	echo "assert-no-vendure: FAILED — remove the Vendure/GraphQL references above." >&2
	exit 1
fi

echo "assert-no-vendure: OK — packages/storefront and packages/api/src (excl. import/) are clean."
