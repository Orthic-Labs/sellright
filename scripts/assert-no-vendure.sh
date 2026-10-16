#!/usr/bin/env bash
# Repo-wide guard: SellRight is the native REST product (see
# docs/agent-rules.md and packages/api/src/app.ts's own doc comment — "typed
# REST … No GraphQL"). This script fails the build if GraphQL/Vendure-API
# coupling creeps back into the surfaces that must stay native:
#
#   - packages/api/src        (excluding src/import/** — the Vendure IMPORTER
#                               legitimately talks to a source Vendure
#                               instance; that's its whole job)
#   - packages/storefront-client (the new typed REST client — MUST never
#                               reference Vendure or GraphQL)
#   - packages/storefront/src  (marked allow-failing below until the
#                               storefront is migrated onto storefront-client
#                               — see CONSTRAINTS in the storefront-client PR)
#
# Two kinds of hit:
#   1. Real coupling signals — `graphql`, a `` gql` `` tagged template,
#      `@vendure` package imports, `__typename` field access — are ALWAYS a
#      hard fail, everywhere in scope. There's no legitimate reason for any
#      of these outside the importer.
#   2. The bare word "vendure" (case-insensitive) is mostly historical/
#      migration prose in packages/api/src — e.g. `auth/password.ts`
#      documents bcrypt continuity for accounts migrated FROM Vendure,
#      `admin/reconcile-export.ts` is a deliberate SellRight→Vendure rollback
#      exporter. Those are legitimate and pre-date this script, so they're
#      named in VENDURE_WORD_ALLOWLIST below (auditable, not a blanket
#      exclusion — a NEW file mentioning "vendure" still fails loud). The
#      client/storefront scopes have no file-level allowlist. Reviewed migration
#      carriers/provenance have exact path + parsed-token exceptions in the Node scanner.
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0

# --- kind 1: hard-fail signals, everywhere in scope, no exceptions ---------
HARD_PATTERNS='graphql|gql`|@vendure|__typename'

# --- kind 2: bare "vendure" word, pre-existing-file allowlist for the API --
# Only packages/api/src has a historical file-level allowlist.
read -r -d '' VENDURE_WORD_ALLOWLIST <<'LIST' || true
packages/api/src/env.ts
packages/api/src/payments/refunds.ts
packages/api/src/orders/order-edit-service.ts
packages/api/src/email/mailer.test.ts
packages/api/src/routes/admin-affiliate.public.db.test.ts
packages/api/src/routes/customer-tokens.ts
packages/api/src/payments/tenant-resolution.db.test.ts
packages/api/src/sheerid/service.ts
packages/api/src/routes/checkout.ts
packages/api/src/routes/catalog-variant-metadata.db.test.ts
packages/api/src/routes/contact.ts
packages/api/src/auth/session.ts
packages/api/src/auth/password-vendure.test.ts
packages/api/src/routes/admin-affiliate.ts
packages/api/src/auth/password.ts
packages/api/src/admin/reconcile-export.ts
packages/api/src/licensing/account-bootstrap.ts
packages/api/src/manifest/catalog.ts
packages/api/src/manifest/catalog.db.test.ts
packages/api/src/manifest/publish.ts
LIST

is_allowlisted() {
  local f="$1"
  grep -qxF "$f" <<<"$VENDURE_WORD_ALLOWLIST"
}

check_scope() {
  local scope="$1" allow_word_list="$2" label="$3"
  [ -d "$scope" ] || return 0

  # kind 1 — hard signals, always fail.
  local hits
  hits=$(grep -rnEI "$HARD_PATTERNS" "$scope" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
    2>/dev/null | grep -v '/node_modules/' || true)
  if [ "$scope" = "packages/api/src" ]; then
    hits=$(grep -v '^packages/api/src/import/' <<<"$hits" || true)
  fi
  if [ -n "$hits" ]; then
    echo "assert-no-vendure: [$label] GraphQL/Vendure coupling signal found:"
    echo "$hits"
    FAIL=1
  fi

  # kind 1b — syntax-aware: a tagged template whose tag is gql/graphql however the tag expression is wrapped,
  # e.g. (gql)`…`, (0, gql)`…`, (gql as T)`…`, gql!`…`, ns.gql`…`. The grep above only sees a literal gql`.
  local ast_args=("$scope")
  if [ "$scope" = "packages/api/src" ]; then ast_args=(--skip packages/api/src/import "$scope"); fi
  local ast_hits
  local ast_rc=0
  ast_hits=$(node scripts/assert-no-gql-tags.mjs "${ast_args[@]}") || ast_rc=$?
  # A non-zero exit WITHOUT hit lines on stdout is the scanner itself failing (crash, missing module, bad path —
  # node exits 1 on an uncaught error just like a real hit), which must never read as a pass.
  if [ "$ast_rc" -ne 0 ] && [ -z "$ast_hits" ]; then
    echo "assert-no-vendure: [$label] AST scanner failed (exit $ast_rc) — guard cannot vouch for this scope"
    FAIL=1
  fi
  if [ -n "$ast_hits" ]; then
    echo "assert-no-vendure: [$label] GraphQL tagged template found:"
    echo "$ast_hits"
    FAIL=1
  fi

  # kind 2 — bare word, historical API files or exact compatibility syntax only.
  local word_hits
  word_hits=$(grep -rlniE 'vendure' "$scope" \
    --include='*.ts' --include='*.tsx' --include='*.js' --include='*.mjs' \
    2>/dev/null | grep -v '/node_modules/' || true)
  if [ "$scope" = "packages/api/src" ]; then
    word_hits=$(grep -v '^packages/api/src/import/' <<<"$word_hits" || true)
  fi
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$allow_word_list" = "yes" ] && is_allowlisted "$f"; then
      continue
    fi
    local compatibility_hits compatibility_rc=0
    compatibility_hits=$(node scripts/assert-no-gql-tags.mjs --words "$f") || compatibility_rc=$?
    if [ "$compatibility_rc" -eq 0 ] && [ -z "$compatibility_hits" ]; then
      continue
    fi
    if [ "$compatibility_rc" -ne 0 ] && [ -z "$compatibility_hits" ]; then
      echo "assert-no-vendure: [$label] compatibility scanner failed (exit $compatibility_rc) for $f"
      FAIL=1
      continue
    fi
    echo "assert-no-vendure: [$label] unexpected 'vendure' mention in $f"
    echo "$compatibility_hits"
    FAIL=1
  done <<<"$word_hits"
}

check_scope "packages/api/src" "yes" "api"
check_scope "packages/storefront-client" "no" "storefront-client"

# packages/storefront now imports its typed client from
# @sellright/storefront-client (src/sellright/client.ts is a thin Qwik
# adapter over that package's compat surface; the old storefront-embedded
# client.ts + schema.gen.ts duplicates and the whole GraphQL/codegen
# toolchain were deleted in the sf-native integration) — HARD fail here too,
# same as api/storefront-client. Only exact compatibility syntax is excepted.
check_scope "packages/storefront/src" "no" "storefront"

if [ "$FAIL" -ne 0 ]; then
  echo "assert-no-vendure: FAILED (see above)"
  exit 1
fi
echo "assert-no-vendure: OK"
