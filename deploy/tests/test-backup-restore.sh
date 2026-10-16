#!/bin/sh
# Host-file regressions only; real PostgreSQL/tar/crypto round trips run in CI's recovery drill.
set -eu
unset CDPATH
SCRIPT="$(cd -- "$(dirname -- "$0")/.." && pwd)/sellright.sh"
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' 0
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$*"; }
mkdir -p "$tmp/bin" "$tmp/home" "$tmp/plain" "$tmp/capture"
chmod 700 "$tmp/plain"
printf 'SELLRIGHT_IMAGE_TAG=test\n' > "$tmp/home/.env"
printf '{"masterKey":"fixture-key","kitId":"fixture-kit"}\n' > "$tmp/kit.json"
export SELLRIGHT_HOME="$tmp/home" TEST_ROOT="$tmp" TMPDIR="$tmp/plain"
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
  case "$arg" in -v|--volume|--volume=*) echo 'host bind mount forbidden' >&2; exit 91 ;; esac
done
# Inspect permissions while files exist, before success/failure cleanup runs.
find "$SELLRIGHT_HOME/backups" "$TMPDIR" -type d ! -perm 700 -print > "$TEST_ROOT/bad-modes"
find "$SELLRIGHT_HOME/backups" "$TMPDIR" -type f ! -perm 600 -print >> "$TEST_ROOT/bad-modes"
[ ! -s "$TEST_ROOT/bad-modes" ] || { cat "$TEST_ROOT/bad-modes" >&2; exit 92; }
case "$*" in
  *' pg_dump '*)
    printf 'database-fixture\n'
    [ "${TEST_FAIL:-}" != dump ] || exit 31 ;;
  *' tar czf - -C /app/var assets')
    printf 'assets-fixture\n'
    [ "${TEST_FAIL:-}" != assets ] || exit 32 ;;
  *' tar czf - -C /app/var downloads') printf 'downloads-fixture\n' ;;
  *' images -q api') printf 'fixture-image\n' ;;
  *' pg_restore '*)
    cat > "$TEST_ROOT/capture/database"
    [ "${TEST_FAIL:-}" != restore ] || exit 33 ;;
  *'tar xzf - -C /app/var/assets '*) cat > "$TEST_ROOT/capture/assets" ;;
  *'tar xzf - -C /app/var/downloads '*) cat > "$TEST_ROOT/capture/downloads" ;;
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
for step in dump assets; do
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

mkdir "$tmp/encrypted"
for part in database.dump assets.tar.gz downloads.tar.gz; do
  printf '%s\n' "$part-restored" > "$tmp/encrypted/$part.enc"
  printf 'fixture-tag\n' > "$tmp/encrypted/$part.enc.hmac"
done
# Restore's safety backup should stay local in this fixture.
printf 'SELLRIGHT_OFFSITE_REMOTE=\n' >> "$SELLRIGHT_HOME/.env"
(umask 000; sh "$SCRIPT" restore --kit "$tmp/kit.json" --set "$tmp/encrypted" --yes) > "$tmp/restore.log" 2>&1 || { cat "$tmp/restore.log" >&2; fail restore; }
[ "$(cat "$tmp/capture/database")" = database.dump-restored ] || fail 'database stdin'
[ "$(cat "$tmp/capture/assets")" = assets.tar.gz-restored ] || fail 'assets stdin'
[ "$(cat "$tmp/capture/downloads")" = downloads.tar.gz-restored ] || fail 'downloads stdin'
[ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ] || fail 'decrypted staging survived success'
if TEST_FAIL=restore sh "$SCRIPT" restore --kit "$tmp/kit.json" --set "$tmp/encrypted" --yes > "$tmp/failed-restore.log" 2>&1; then fail 'restore failure accepted'; fi
[ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ] || fail 'decrypted staging survived restore failure'
printf 'invalid-tag\n' > "$tmp/encrypted/assets.tar.gz.enc.hmac"
if sh "$SCRIPT" restore --kit "$tmp/kit.json" --set "$tmp/encrypted" --yes > "$tmp/failed-decrypt.log" 2>&1; then fail 'bad integrity tag accepted'; fi
[ -z "$(find "$TMPDIR" -mindepth 1 -print -quit)" ] || fail 'decrypted staging survived integrity failure'
[ -f "$tmp/encrypted/database.dump.enc" ] || fail 'caller backup removed'
pass 'restore streams private plaintext & removes staging on success, restore failure & integrity failure'
