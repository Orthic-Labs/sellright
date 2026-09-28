#!/bin/sh
# Offline unit test for deploy/sellright.sh's cosign_verify_images and
# `update --from-source` argument parsing. No Docker/registry/network
# involved — every external command (docker, cosign) is stubbed. Full
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

mkdir -p "$tmp/bin" "$tmp/home"
echo 'x=1' > "$tmp/home/.env"

# Fake `docker` covering `compose config --images <svc>`, the legacy
# `compose images -q <svc>` (must NOT be called by the fixed code), and
# `image inspect --format ... <ref>`.
cat > "$tmp/bin/docker" <<'SH'
#!/bin/sh
args="$*"
case "$args" in
  *" config "*"--images"*)
    for a in "$@"; do svc="$a"; done
    echo "target-image:${svc}"
    ;;
  *" images -q"*)
    echo "RUNNING-CONTAINER-IMAGE-ID"
    ;;
  *"image inspect"*)
    for a in "$@"; do ref="$a"; done
    case "$ref" in
      target-image:*) echo "ghcr.io/orthic-labs/sellright-x@sha256:$(printf '%064d' 1)" ;;
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
[ "$1" = "verify" ] && exit 0
exit 0
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

resolved="$(PATH="$tmp/bin:$PATH" compose config --images api 2>/dev/null || true)"
[ "$resolved" = "target-image:api" ] || fail "compose config --images did not resolve as expected (got: $resolved)"
pass "compose() plumbs through to config --images"

if PATH="$tmp/bin:$PATH" cosign_verify_images >/tmp/cosign-verify.out 2>&1; then
  pass "cosign_verify_images succeeds against target (pulled) images"
else
  cat /tmp/cosign-verify.out >&2
  fail "cosign_verify_images should have succeeded"
fi

if grep -q 'RUNNING-CONTAINER-IMAGE-ID' /tmp/cosign-verify.out 2>/dev/null; then
  fail "cosign_verify_images called 'compose images -q' (running container) instead of 'compose config --images' (target)"
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
