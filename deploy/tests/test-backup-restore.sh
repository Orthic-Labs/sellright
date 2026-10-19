#!/bin/sh
# Host-file regressions only; real PostgreSQL/tar/crypto round trips run in CI's recovery drill.
set -eu
unset CDPATH
SCRIPT="$(cd -- "$(dirname -- "$0")/.." && pwd)/sellright.sh"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' 0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$*"; }
mkdir -p "$tmp/bin" "$tmp/home" "$tmp/plain" "$tmp/capture" "$tmp/source/deploy"
printf 'services: {}\n' > "$tmp/source/deploy/compose.build.yaml"
chmod 700 "$tmp/plain"
printf 'SELLRIGHT_IMAGE_TAG=test\n' > "$tmp/home/.env"
printf '{"masterKey":"fixture-key","kitId":"fixture-kit"}\n' > "$tmp/kit.json"
export SELLRIGHT_HOME="$tmp/home" SELLRIGHT_SOURCE="$tmp/source" TEST_ROOT="$tmp" TMPDIR="$tmp/plain"
export PATH="$tmp/bin:$PATH"

cat > "$tmp/bin/date" <<'STUB'
#!/bin/sh
case "$*" in *%Y%m%dT%H%M%SZ*) printf '20261016T000000Z\n' ;; *) /bin/date "$@" ;; esac
STUB
cat > "$tmp/bin/docker" <<'STUB'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$TEST_ROOT/docker.log"
for arg in "$@"; do
  case "$arg" in
    -v) case "$*" in *' psql '*) : ;; *) echo 'host bind mount forbidden' >&2; exit 91 ;; esac ;;
    --volume|--volume=*) echo 'host bind mount forbidden' >&2; exit 91 ;;
  esac
done
# Public backup resolves its existing container before private output setup.
# This metadata read creates no backup/plaintext and needs no output-mode guard.
case "$*" in
  *' ps -q api')
    [ "${TEST_FAIL:-}" != no-api ] || exit 34
    printf '%064d\n' 7
    exit 0 ;;
esac
# Inspect permissions while files exist, before success/failure cleanup runs.
find "$SELLRIGHT_HOME/backups" "$TMPDIR" -type d ! -perm 700 -print > "$TEST_ROOT/bad-modes"
find "$SELLRIGHT_HOME/backups" "$TMPDIR" -type f ! -perm 600 -print >> "$TEST_ROOT/bad-modes"
[ ! -s "$TEST_ROOT/bad-modes" ] || { cat "$TEST_ROOT/bad-modes" >&2; exit 92; }
# Record the actual content override, not a tag inferred from config.
for arg in "$@"; do
  case "$arg" in
    */verified-api.yaml|*/previous-api.yaml)
      image=$(sed -n 's/^    image: //p' "$arg")
      printf '%s %s\n' "$image" "$*" >> "$TEST_ROOT/executed-images" ;;
  esac
done
case "$*" in
  *' config --format json')
    printf '{"name":"fixture","services":{"api":{"image":"local-api:mutable"},"admin":{"image":"local-admin:mutable"},"storefront":{"image":"local-store:mutable"}}}\n' ;;
  'image inspect --format {{.Id}} '*)
    [ "${TEST_FAIL:-}" != missing-image ] || exit 47
    # A later tag change cannot change an already captured ID.
    touch "$TEST_ROOT/tag-moved"
    printf 'sha256:%064d\n' 9 ;;
  'image inspect --format {{json .RepoDigests}} '*)
    ref=${*##* }; printf '["%s@sha256:%064d"]\n' "${ref%:*}" 9 ;;
  *' ps --all --quiet api')
    [ "${TEST_FAIL:-}" != census ] || exit 44
    if [ "${TEST_TARGET:-existing}" != fresh ]; then printf '%064d\n' 7; fi
    if [ "${TEST_TARGET:-}" = multiple ]; then printf '%064d\n' 5; fi
    [ ! -f "$TEST_ROOT/helper-created" ] || printf '%064d\n' 6 ;;
  inspect*'{{.Image}}|{{.State.Running}}|'*)
    running=true
    [ "${TEST_TARGET:-}" != stopped ] || running=false
    printf 'sha256:%064d|%s|fixture|api|False\n' 8 "$running" ;;
  inspect*'{{.Id}}'*sellright-restore-*) printf '%064d\n' 6 ;;
  *' run --pull never -d --no-deps --name sellright-restore-'*) touch "$TEST_ROOT/helper-created" ;;
  *'node /tmp/restore.js assert-empty')
    [ "${TEST_NONEMPTY:-}" != storage ] && [ "${TEST_NONEMPTY:-}" != state ] || exit 45 ;;
  *'SELECT'*'pg_namespace'*)
    [ "${TEST_NONEMPTY:-}" != unknown-db ] || exit 46
    if [ "${TEST_NONEMPTY:-}" = database ]; then printf 'f\n'; else printf 't\n'; fi ;;
  inspect*'{{.Image}}'*) printf 'sha256:%064d\n' 8 ;;
  *' pg_dump '*)
    printf 'database-fixture\n'
    [ "${TEST_FAIL:-}" != dump ] || exit 31 ;;
  *' tar czf - -C /app/var assets')
    printf 'assets-fixture\n'
    [ "${TEST_FAIL:-}" != assets ] || exit 32 ;;
  *' tar czf - -C /app/var downloads') printf 'downloads-fixture\n' ;;
  *' images -q api') printf 'fixture-image\n' ;;
  *'sh -c umask 077; cat > /tmp/restore.js') cat > "$TEST_ROOT/capture/helper.js" ;;
  *'node /tmp/restore.js receive '*)
    args=$*; part=${args##*receive }; cat > "$TEST_ROOT/capture/$part" ;;
  *'node /tmp/restore.js stage')
    case "${TEST_FAIL:-}" in stage-*) exit 35 ;; esac ;;
  *' pg_restore --list')
    cat > /dev/null; [ "${TEST_FAIL:-}" != list ] || exit 36 ;;
  *' pg_restore '*)
    cat > "$TEST_ROOT/capture/database"
    [ "${TEST_FAIL:-}" != restore ] || exit 33 ;;
  *'node /tmp/restore.js snapshot')
    [ "${TEST_FAIL:-}" != snapshot ] || exit 37
    cp "$TEST_ROOT/live-files" "$TEST_ROOT/previous-files" ;;
  *'node /tmp/restore.js promote')
    printf partial > "$TEST_ROOT/live-files"
    case "${TEST_FAIL:-}" in promote|rollback) exit 38 ;; esac
    printf restored > "$TEST_ROOT/live-files" ;;
  *'node /tmp/restore.js rollback')
    [ "${TEST_FAIL:-}" != rollback ] || exit 39
    cp "$TEST_ROOT/previous-files" "$TEST_ROOT/live-files" ;;
  *' stop api') printf stopped > "$TEST_ROOT/api" ;;
  *' up --pull never --no-build -d --no-deps --wait --wait-timeout 120 api')
    if [ "${TEST_FAIL:-}" = restart ] && [ ! -f "$TEST_ROOT/restart-failed" ]; then
      touch "$TEST_ROOT/restart-failed"; exit 40
    fi
    printf running > "$TEST_ROOT/api" ;;
  *'SELECT EXISTS('*"datname='sellright_prev_"*)
    if [ -f "$TEST_ROOT/previous-db" ]; then printf 't\n'; else printf 'f\n'; fi ;;
  *'SELECT EXISTS('*"datname='sellright'"*)
    if [ -f "$TEST_ROOT/live-db" ]; then printf 't\n'; else printf 'f\n'; fi ;;
  *'ALTER DATABASE sellright RENAME TO sellright_prev_'*) mv "$TEST_ROOT/live-db" "$TEST_ROOT/previous-db" ;;
  *'ALTER DATABASE sellright_restore_'*' RENAME TO sellright;'*)
    [ "${TEST_FAIL:-}" != rename ] || exit 41
    printf restored > "$TEST_ROOT/live-db" ;;
  *'ALTER DATABASE sellright RENAME TO sellright_failed_'*) mv "$TEST_ROOT/live-db" "$TEST_ROOT/failed-db" ;;
  *'ALTER DATABASE sellright_prev_'*' RENAME TO sellright;'*) mv "$TEST_ROOT/previous-db" "$TEST_ROOT/live-db" ;;
  *' rm -f -s api') printf absent > "$TEST_ROOT/api" ;;
  'rm -f sellright-restore-'*) touch "$TEST_ROOT/helper-removed"; rm -f "$TEST_ROOT/helper-created" ;;
  *) : ;;
esac
STUB
# Crypto is isolated here to observe plaintext lifetimes; real HMAC/tamper tests stay in recovery drill.
cat > "$tmp/bin/openssl" <<'STUB'
#!/bin/sh
set -eu
case "$1" in
  dgst) cat >/dev/null; printf 'SHA2-256= fixture-tag\n' ;;
  enc)
    in=''; out=''
    while [ $# -gt 0 ]; do
      case "$1" in -in) in="$2"; shift 2 ;; -out) out="$2"; shift 2 ;; *) shift ;; esac
    done
    cat "$in" > "$out" ;;
  *) exit 99 ;;
esac
STUB
cat > "$tmp/bin/cosign" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_ROOT/cosign.log"
[ "${TEST_FAIL:-}" != signature ]
STUB
cat > "$tmp/bin/rclone" <<'STUB'
#!/bin/sh
exit 34
STUB
chmod +x "$tmp/bin/"*

# A pre-existing predictable child must never be reused, followed or overwritten.
mkdir "$tmp/target" "$SELLRIGHT_HOME/backups"
printf 'untouched\n' > "$tmp/target/sentinel"
ln -s "$tmp/target" "$SELLRIGHT_HOME/backups/20261016T000000Z"
chmod 777 "$SELLRIGHT_HOME/backups"
(umask 000; sh "$SCRIPT" backup) > "$tmp/backup.log" 2>&1 || { cat "$tmp/backup.log" >&2; fail backup; }
(umask 000; sh "$SCRIPT" backup) >> "$tmp/backup.log" 2>&1 || fail 'same-second second backup'
[ "$(find "$SELLRIGHT_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 2 ] || fail 'unique backup directories'
[ "$(cat "$tmp/target/sentinel")" = untouched ] || fail 'symlink target changed'
[ "$(find "$tmp/target" -type f | wc -l)" -eq 1 ] || fail 'symlink target received files'
[ "$(stat -c %a "$SELLRIGHT_HOME/backups")" = 700 ] || fail 'private backup parent'
find "$SELLRIGHT_HOME/backups" -type f ! -perm 600 -print > "$tmp/bad-files"
[ ! -s "$tmp/bad-files" ] || fail 'private completed backup files'
pass 'permissive umask & same-second backups preserve private unique sets & symlink target'

# Reject unsafe parent paths before any archive output.
mv "$SELLRIGHT_HOME/backups" "$SELLRIGHT_HOME/saved-backups"
ln -s "$tmp/target" "$SELLRIGHT_HOME/backups"
if sh "$SCRIPT" backup > "$tmp/rejected.log" 2>&1; then fail 'symlink backup parent accepted'; fi
rm "$SELLRIGHT_HOME/backups"
printf 'not-a-directory\n' > "$SELLRIGHT_HOME/backups"
if sh "$SCRIPT" backup >> "$tmp/rejected.log" 2>&1; then fail 'file backup parent accepted'; fi
rm "$SELLRIGHT_HOME/backups"
mv "$SELLRIGHT_HOME/saved-backups" "$SELLRIGHT_HOME/backups"
# Inject a foreign uid at the ownership boundary without requiring privileged chown.
cat > "$tmp/bin/stat" <<'STUB'
#!/bin/sh
if [ "${TEST_FOREIGN_OWNER:-}" = 1 ] && [ "$1" = -c ] && [ "$2" = %u ]; then
  printf 'foreign-owner\n'
else
  /usr/bin/stat "$@"
fi
STUB
chmod +x "$tmp/bin/stat"
if TEST_FOREIGN_OWNER=1 sh "$SCRIPT" backup >> "$tmp/rejected.log" 2>&1; then fail 'foreign-owned parent accepted'; fi
pass 'symlink, non-directory & foreign-owned backup parents rejected'

before=$(find "$SELLRIGHT_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)
for step in no-api dump assets; do
  if TEST_FAIL="$step" sh "$SCRIPT" backup > "$tmp/failed-backup.log" 2>&1; then fail "injected $step failure accepted"; fi
  [ "$(find "$SELLRIGHT_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq "$before" ] || fail 'incomplete backup survived'
done
# Offsite failure must retain complete local backup, while removing its own temp staging.
printf 'SELLRIGHT_OFFSITE_REMOTE=fixture:remote\n' >> "$SELLRIGHT_HOME/.env"
if sh "$SCRIPT" backup --offsite > "$tmp/offsite.log" 2>&1; then fail 'offsite failure accepted'; fi
[ "$(find "$SELLRIGHT_HOME/backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq "$((before + 1))" ] || fail 'completed local backup removed'
[ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ] || fail 'offsite staging survived failure'
pass 'failed backups clean only incomplete sets; offsite failure retains completed local set'
# The update command already owns an EXIT trap; nested backup must not replace it.
sed '$ { /^main "\$@"$/d }' "$SCRIPT" > "$tmp/functions.sh"
cat > "$tmp/nested.sh" <<'STUB'
#!/bin/sh
set -eu
# shellcheck disable=SC1090
. "$1"
trap 'printf preserved > "$TEST_ROOT/outer-trap"' 0
cmd_backup
STUB
sh "$tmp/nested.sh" "$tmp/functions.sh" > "$tmp/trap.log" 2>&1 || fail 'nested backup'
[ "$(cat "$tmp/outer-trap")" = preserved ] || fail 'caller EXIT trap replaced'

mkdir "$tmp/encrypted" "$tmp/legacy"
for part in database.dump assets.tar.gz downloads.tar.gz; do
  printf '%s\n' "$part-restored" > "$tmp/encrypted/$part.enc"
  printf 'fixture-tag\n' > "$tmp/encrypted/$part.enc.hmac"
  cp "$tmp/encrypted/$part.enc" "$tmp/legacy/$part"
done
# Restore's safety backup stays local in this fixture.
printf 'SELLRIGHT_OFFSITE_REMOTE=\n' >> "$SELLRIGHT_HOME/.env"
reset_restore() {
  rm -f "$tmp/previous-db" "$tmp/failed-db" "$tmp/restart-failed" "$tmp/helper-removed" "$tmp/helper-created"
  : > "$tmp/executed-images"
  rm -f "$tmp/tag-moved"
  printf original > "$tmp/live-db"
  printf original > "$tmp/live-files"
  printf running > "$tmp/api"
  : > "$tmp/docker.log"
}
assert_original() {
  [ "$(cat "$tmp/live-db")" = original ] || fail 'original DB not recovered'
  [ "$(cat "$tmp/live-files")" = original ] || fail 'original files not recovered'
  [ "$(cat "$tmp/api")" = running ] || fail 'coherent original API not restarted'
}
for set_name in encrypted legacy; do
  reset_restore
  (umask 000; sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/$set_name" --yes) > "$tmp/restore.log" 2>&1 || { cat "$tmp/restore.log" >&2; fail "$set_name restore"; }
  [ "$(cat "$tmp/capture/database")" = database.dump-restored ] || fail 'database stdin'
  [ "$(cat "$tmp/live-db")" = restored ] && [ "$(cat "$tmp/live-files")" = restored ] || fail 'incoherent promotion'
  [ "$(cat "$tmp/api")" = running ] || fail 'promoted API unhealthy'
  [ -f "$tmp/helper-removed" ] || fail 'helper survived success'
  [ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ] || fail 'plaintext staging survived success'
  stage_line=$(sed -n '/node \/tmp\/restore.js stage/=' "$tmp/docker.log")
  stop_line=$(sed -n '/ stop api/=' "$tmp/docker.log" | head -n 1)
  [ "$stage_line" -lt "$stop_line" ] || fail 'live stop before archive preflight'
done
pass 'plain & authenticated restore stage before promotion, wait for health & clean private staging'
for step in stage-assets stage-downloads stage-hash stage-extract list restore; do
  reset_restore
  if TEST_FAIL="$step" sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/encrypted" --yes > "$tmp/failed-restore.log" 2>&1; then fail "injected $step accepted"; fi
  assert_original
  if sed -n '/ stop api/p; / RENAME TO /p; / pg_dump /p; /restore.js promote/p' "$tmp/docker.log" | sed -n '1p' | { read -r line; [ -n "$line" ]; }; then fail 'live mutation before full preflight'; fi
  [ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ] || fail 'plaintext staging survived preflight failure'
done
pass 'archive/hash/extraction/DB preflight failures leave live state untouched'
for step in snapshot rename promote restart; do
  reset_restore
  if TEST_FAIL="$step" sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/encrypted" --yes > "$tmp/failed-restore.log" 2>&1; then fail "injected $step accepted"; fi
  assert_original
  [ -f "$tmp/helper-removed" ] || fail 'helper survived recovered failure'
done
reset_restore
if TEST_FAIL=rollback sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/encrypted" --yes > "$tmp/failed-restore.log" 2>&1; then fail 'rollback failure accepted'; fi
[ "$(cat "$tmp/api")" = stopped ] || fail 'API reopened after rollback failure'
[ ! -f "$tmp/helper-removed" ] || fail 'recovery snapshots removed after rollback failure'
grep 'rollback failed.*Retained helper' "$tmp/failed-restore.log" >/dev/null || fail 'missing recovery guidance'
pass 'snapshot, rename, file promotion & health failures recover coherently; rollback failure fails closed with retained snapshots'
reset_restore
printf 'invalid-tag\n' > "$tmp/encrypted/assets.tar.gz.enc.hmac"
if sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/encrypted" --yes > "$tmp/failed-decrypt.log" 2>&1; then fail 'bad integrity tag accepted'; fi
assert_original
[ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ] || fail 'decrypted staging survived integrity failure'
[ -f "$tmp/encrypted/database.dump.enc" ] || fail 'caller backup removed'
pass 'bad authentication tag preserves caller set & live state, cleans plaintext'

reset_restore
if TEST_FAIL=signature sh "$SCRIPT" restore --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/signature.log" 2>&1; then fail 'unsigned restore accepted'; fi
! grep ' run --pull never ' "$tmp/docker.log" >/dev/null || fail 'helper launched before signature verification'
assert_original
pass 'registry verification failure precedes helper execution'

for step in dump assets; do
  reset_restore
  if TEST_FAIL="$step" sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/required-backup.log" 2>&1; then fail "existing target skipped failed $step safety backup"; fi
  assert_original
  ! grep -E ' RENAME TO |restore.js promote| stop api' "$tmp/docker.log" >/dev/null || fail 'live mutation after failed safety backup'
done
pass 'existing target cannot promote after failed safety backup'


printf 'fixture-tag\n' > "$tmp/encrypted/assets.tar.gz.enc.hmac"
for set_name in legacy encrypted; do
  reset_restore
  : > "$tmp/cosign.log"
  TEST_TARGET=fresh sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/$set_name" --yes > "$tmp/fresh.log" 2>&1 || { cat "$tmp/fresh.log" >&2; fail "fresh $set_name restore"; }
  [ ! -s "$tmp/cosign.log" ] || fail 'explicit local mode called cosign'
  [ -f "$tmp/tag-moved" ] || fail 'local image not resolved before launch'

  [ "$(cat "$tmp/live-db")" = restored ] && [ "$(cat "$tmp/live-files")" = restored ] || fail 'fresh promotion failed'
  ! grep ' pg_dump ' "$tmp/docker.log" >/dev/null || fail 'empty target safety backup attempted'
  grep 'target proven empty' "$tmp/fresh.log" >/dev/null || fail 'empty proof absent'
  new_image=$(printf 'sha256:%064d' 9)
  [ "$(sed -n '1s/ .*//p' "$tmp/executed-images")" = "$new_image" ] || fail 'helper did not use frozen local image'
  grep "^$new_image .* up --pull never --no-build " "$tmp/executed-images" >/dev/null || fail 'promotion did not use frozen local image'
  ! grep -E '(^pull | build( |$))' "$tmp/docker.log" >/dev/null || fail 'source restore pulled/built'
done
pass 'fresh plain/encrypted targets use exact prebuilt image for helper and promotion without safety backup'

for state in database storage state unknown-db; do
  reset_restore
  if TEST_TARGET=fresh TEST_NONEMPTY="$state" sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/not-empty.log" 2>&1; then fail "missing API accepted $state"; fi
  [ "$(cat "$tmp/live-db")" = original ] && [ "$(cat "$tmp/live-files")" = original ] || fail 'nonempty target changed'
  ! grep -E ' RENAME TO |restore.js promote| stop api' "$tmp/docker.log" >/dev/null || fail 'nonempty target promoted/stopped'
done
for target in stopped multiple; do
  reset_restore
  if TEST_TARGET="$target" sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/stopped.log" 2>&1; then fail 'stopped API treated as empty'; fi
  ! grep ' run --pull never ' "$tmp/docker.log" >/dev/null || fail 'helper started for stopped/ambiguous API'
done
for step in census missing-image; do
  reset_restore
  if TEST_FAIL="$step" sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/unknown.log" 2>&1; then fail "unknown $step accepted"; fi
  ! grep ' run --pull never ' "$tmp/docker.log" >/dev/null || fail 'helper launched on unknown admission'
done
pass 'nonempty or unknown targets and stopped existing API cannot skip backup'

reset_restore
if TEST_TARGET=fresh TEST_FAIL=promote sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/fresh-failure.log" 2>&1; then fail 'fresh promotion failure accepted'; fi
[ "$(cat "$tmp/live-db")" = original ] && [ "$(cat "$tmp/live-files")" = original ] || fail 'fresh rollback lost empty snapshot'
[ "$(cat "$tmp/api")" = absent ] || fail 'fresh rollback booted API'
! grep ' up --pull never ' "$tmp/docker.log" >/dev/null || fail 'fresh rollback started API'

reset_restore
if TEST_FAIL=restart sh "$SCRIPT" restore --from-source --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/old-image.log" 2>&1; then fail 'failed health accepted'; fi
assert_original
old_image=$(printf 'sha256:%064d' 8)
grep "^$old_image .* up --pull never --no-build " "$tmp/executed-images" >/dev/null || fail 'rollback used drifted configured tag'
pass 'failure recovers original frozen image/data; fresh failure leaves API absent'

reset_restore
TEST_TARGET=fresh sh "$SCRIPT" restore --kit "$tmp/kit.json" --set "$tmp/legacy" --yes > "$tmp/registry.log" 2>&1 || { cat "$tmp/registry.log" >&2; fail 'verified registry restore'; }
# pulled_image_digest retains familiar repository spelling from the daemon.
registry_image=$(printf 'local-api@sha256:%064d' 9)
grep "^$registry_image .* run --pull never " "$tmp/executed-images" >/dev/null || fail 'helper did not use verified digest'
grep "^$registry_image .* up --pull never --no-build " "$tmp/executed-images" >/dev/null || fail 'promotion did not use verified digest'
pass 'registry helper & promotion execute verified digest rather than floating tag'
