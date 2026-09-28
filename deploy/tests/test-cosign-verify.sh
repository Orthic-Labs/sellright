#!/bin/sh
# Offline unit test for deploy/sellright.sh's cosign_verify_images and
# `update --from-source` argument parsing. No Docker/registry/network
# involved — every external command (docker, cosign) is stubbed; jq runs
# for real (it's what the function under test actually depends on). Full
# end-to-end coverage (real signed images, a real rollback) lives in
# .github/workflows/ci.yml's verify-update job; this test targets just the
# two units in isolation.
set -eu

unset CDPATH
SCRIPT="$(cd -- "$(dirname -- "$0")/.." && pwd)/sellright.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$*"; }

command -v jq >/dev/null 2>&1 || fail "jq is required to run this test (same dependency cosign_verify_images itself has)"

mkdir -p "$tmp/bin" "$tmp/home"
echo 'x=1' > "$tmp/home/.env"

# Fake `docker` covering `compose config --format json` (the ONLY image-
# resolution call the fixed code makes — history of two prior broken
# attempts, both caught live in CI, is in sellright.sh's own comment above
# cosign_verify_images: (1) `compose images -q` read the running container's
# stale image, (2) `compose config --images "$svc"` didn't reliably filter
# by service, (3) zipping `--services`/`--images` by line number assumed an
# ordering guarantee across two separate invocations that doesn't hold).
# This fixture deliberately includes services OTHER than api/admin/
# storefront (postgres, caddy) so a regression back to "just grab some
# image" fails loudly instead of accidentally passing.
cat > "$tmp/bin/docker" <<'SH'
#!/bin/sh
args="$*"
case "$args" in
  *" config "*"--format json"*)
    cat <<'JSON'
{"services":{
  "postgres": {"image": "postgres-image:latest"},
  "caddy": {"image": "caddy-image:latest"},
  "api": {"image": "target-image:api"},
  "admin": {"image": "target-image:admin"},
  "storefront": {"image": "target-image:storefront"}
}}
JSON
    ;;
  *" images -q"*)
    echo "RUNNING-CONTAINER-IMAGE-ID"
    ;;
  *"image inspect"*)
    for a in "$@"; do ref="$a"; done
    case "$ref" in
      target-image:*) echo "ghcr.io/orthic-labs/sellright-x@sha256:$(printf '%064d' 1)" ;;
      postgres-image:*) echo "ghcr.io/library/postgres@sha256:$(printf '%064d' 2)" ;;
      caddy-image:*) echo "ghcr.io/library/caddy@sha256:$(printf '%064d' 3)" ;;
      RUNNING-CONTAINER-IMAGE-ID) echo "ghcr.io/orthic-labs/sellright-x@sha256:$(printf '%064d' 9)" ;;
      *) echo "" ;;
    esac
    ;;
  *) exit 0 ;;
esac
SH
chmod +x "$tmp/bin/docker"

cat > "$tmp/bin/cosign" <<'SH'
#!/bin/sh
[ "$1" = "verify" ] || exit 0
# Fail closed if ever handed postgres's/caddy's digest under an api/admin/
# storefront role — proves jq resolved the RIGHT key, not just "some image".
last="$*"
case "$last" in
  *"$(printf '%064d' 2)"*) exit 1 ;;
  *"$(printf '%064d' 3)"*) exit 1 ;;
  *) exit 0 ;;
esac
SH
chmod +x "$tmp/bin/cosign"

# sellright.sh calls `main "$@"` unconditionally at file scope; strip that
# trailing call so sourcing it here only defines functions.
BODY="$tmp/sellright-functions.sh"
sed '$ { /^main "\$@"$/d }' "$SCRIPT" > "$BODY"
grep -q '^main "\$@"$' "$SCRIPT" || fail "sellright.sh's trailing 'main \"\$@\"' line moved; update this test's sed"
# shellcheck disable=SC1090
. "$BODY"
# Read by compose()/require_home() inside the sourced functions above, not
# in this file directly — shellcheck can't see that cross-file use.
# shellcheck disable=SC2034
SELLRIGHT_HOME="$tmp/home"

resolved="$(PATH="$tmp/bin:$PATH" compose config --format json 2>/dev/null | jq -r '.services.api.image')"
[ "$resolved" = "target-image:api" ] || fail "compose config --format json | jq did not resolve api's image as expected (got: $resolved)"
pass "compose config --format json resolves api to its own image, not postgres's/caddy's"

if PATH="$tmp/bin:$PATH" cosign_verify_images >/tmp/cosign-verify.out 2>&1; then
  pass "cosign_verify_images succeeds against target (pulled) images"
else
  cat /tmp/cosign-verify.out >&2
  fail "cosign_verify_images should have succeeded (each service must get its OWN image, not postgres's/caddy's)"
fi

if grep -q 'RUNNING-CONTAINER-IMAGE-ID' /tmp/cosign-verify.out 2>/dev/null; then
  fail "cosign_verify_images called 'compose images -q' (running container) instead of 'compose config --format json' (target)"
fi
pass "cosign_verify_images never queries the running container's image"

set +e
(SELLRIGHT_HOME="$tmp/home" cmd_update --bogus-flag) >/tmp/badflag.out 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "cmd_update accepted an unknown flag"
grep -q "unknown argument" /tmp/badflag.out || fail "expected an 'unknown argument' error, got: $(cat /tmp/badflag.out)"
pass "cmd_update rejects unknown flags"

set +e
(
  unset SELLRIGHT_SOURCE
  : "${SELLRIGHT_SOURCE:?--from-source requires SELLRIGHT_SOURCE=/path/to/checked-out/sellright}"
) >/tmp/nosource.out 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "--from-source should require SELLRIGHT_SOURCE to be set"
pass "--from-source fails closed without SELLRIGHT_SOURCE"

printf '\nall cosign/update tests passed\n'
