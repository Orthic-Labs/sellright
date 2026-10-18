#!/bin/sh
# SellRight host CLI. Installed to /usr/local/bin/sellright by install.sh.
# Operates on the Compose appliance at $SELLRIGHT_HOME (default /opt/sellright).
set -eu

SELLRIGHT_HOME="${SELLRIGHT_HOME:-/opt/sellright}"
COSIGN_VERSION="${COSIGN_VERSION:-2.4.1}"

compose() {
  docker compose --env-file "${SELLRIGHT_HOME}/.env" -f "${SELLRIGHT_HOME}/compose.yaml" "$@"
}

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_home() {
  [ -f "${SELLRIGHT_HOME}/.env" ] || die "no install found at ${SELLRIGHT_HOME} (run install.sh first, or set SELLRIGHT_HOME)"
}

# Reads one KEY=value out of deploy/.env WITHOUT sourcing/executing it as
# shell — sourcing broke on any value containing a space (e.g.
# BOOTSTRAP_STORE_NAME="Drill Store" parses as an assignment followed by a
# bareword command) and, more importantly, would execute arbitrary shell
# metacharacters in any value. Values may be bare or double-quoted.
env_get() {
  [ -f "${SELLRIGHT_HOME}/.env" ] || return 0
  sed -n "s/^$1=//p" "${SELLRIGHT_HOME}/.env" | tail -n 1 | sed -e 's/^"//' -e 's/"$//'
}

cmd_status() {
  require_home
  compose ps
}

cmd_logs() {
  require_home
  compose logs -f --tail=200 "$@"
}

cmd_backup() (
  require_home
  umask 077
  backup_root="${SELLRIGHT_HOME}/backups"
  out_dir=""
  complete=0
  status=0
  # Subshell-local traps leave update's rollback bookkeeping trap intact.
  trap 'status=$?; if [ "$complete" -eq 0 ] && [ -n "$out_dir" ]; then rm -rf -- "$out_dir"; fi; exit "$status"' 0
  trap 'exit 1' HUP INT TERM
  if [ -e "$backup_root" ] || [ -L "$backup_root" ]; then
    [ ! -L "$backup_root" ] && [ -d "$backup_root" ] || die "backup parent must be a real directory: $backup_root"
    [ "$(stat -c %u -- "$backup_root")" = "$(id -u)" ] || die "backup parent must be owned by current user: $backup_root"
    chmod 700 "$backup_root"
  else
    mkdir -m 700 "$backup_root"
  fi
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out_dir=$(mktemp -d "${backup_root}/${stamp}.XXXXXX")
  # Backup runs before the registry gate. Execute tar in the existing API
  # container, never a fresh container from a mutable configured image tag.
  backup_api_container=$(compose ps -q api) || die "could not resolve existing API container for backup"
  case "$backup_api_container" in ''|*[!a-f0-9]*) die "existing API container required for backup" ;; esac
  [ "${#backup_api_container}" -eq 64 ] || die "invalid existing API container identity"
  backup_api_image=$(docker inspect --format '{{.Image}}' "$backup_api_container") || die "could not resolve existing API image for backup"
  case "$backup_api_image" in ''|*[!a-z0-9:]*) die "invalid existing API image identity" ;; esac
  printf '%s\n' "$backup_api_image" | grep -Eq '^sha256:[a-f0-9]{64}$' || die "invalid existing API image identity"
  log "Backing up database..."
  compose exec -T postgres pg_dump -U sellright -d sellright -Fc > "${out_dir}/database.dump" || die "database backup failed"
  log "Backing up assets and downloads volumes from existing API..."
  docker exec "$backup_api_container" tar czf - -C /app/var assets > "${out_dir}/assets.tar.gz" || die "existing API assets backup failed"
  docker exec "$backup_api_container" tar czf - -C /app/var downloads > "${out_dir}/downloads.tar.gz" || die "existing API downloads backup failed"
  api_ref="$backup_api_image"
  database_sha=$(sha256sum "${out_dir}/database.dump")
  assets_sha=$(sha256sum "${out_dir}/assets.tar.gz")
  downloads_sha=$(sha256sum "${out_dir}/downloads.tar.gz")
  {
    printf '{\n'
    printf '  "createdAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "appVersion": "%s",\n' "$(env_get SELLRIGHT_IMAGE_TAG)"
    printf '  "apiImageId": "%s",\n' "${api_ref:-unknown}"
    printf '  "parts": {\n'
    printf '    "database.dump": "sha256:%s",\n' "${database_sha%% *}"
    printf '    "assets.tar.gz": "sha256:%s",\n' "${assets_sha%% *}"
    printf '    "downloads.tar.gz": "sha256:%s"\n' "${downloads_sha%% *}"
    printf '  }\n'
    printf '}\n'
  } > "${out_dir}/manifest.json"
  complete=1
  log "Backup set written to ${out_dir}"
  if [ "${1:-}" = "--offsite" ]; then
    cmd_backup_offsite "$out_dir"
  fi
)

# Encrypt-then-MAC (authenticated encryption from plain `openssl enc` +
# `openssl dgst -hmac`, portable to any OpenSSL 1.1+ without depending on
# `enc`'s newer, version-dependent AEAD tag support). Two keys are derived
# from the recovery kit via HMAC-SHA256 with distinct labels — never reuse
# the same key for encryption and authentication.
derive_key() {
  # $1 = label ("enc" or "mac"), $2 = masterKey, $3 = kitId
  printf '%s' "sellright-backup-${1}:${3}" | openssl dgst -sha256 -hmac "$2" | awk '{print $NF}'
}

encrypt_authenticated() {
  # encrypt_authenticated <in> <out.enc> <encKeyHex> <macKeyHex>
  in_file="$1"; out_file="$2"; enc_key="$3"; mac_key="$4"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass "pass:${enc_key}" -in "$in_file" -out "$out_file"
  openssl dgst -sha256 -hmac "$mac_key" "$out_file" | awk '{print $NF}' > "${out_file}.hmac"
}

decrypt_authenticated() {
  # decrypt_authenticated <in.enc> <out> <encKeyHex> <macKeyHex>
  in_file="$1"; out_file="$2"; enc_key="$3"; mac_key="$4"
  [ -f "${in_file}.hmac" ] || die "missing integrity tag ${in_file}.hmac — refusing to decrypt an unauthenticated file"
  expected=$(cat "${in_file}.hmac")
  actual=$(openssl dgst -sha256 -hmac "$mac_key" "$in_file" | awk '{print $NF}')
  [ "$expected" = "$actual" ] || die "integrity check failed for $(basename "$in_file") — tampered or corrupted backup, refusing to decrypt"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -salt \
    -pass "pass:${enc_key}" -in "$in_file" -out "$out_file"
}

cmd_backup_offsite() (
  umask 077
  out_dir="$1"
  remote="$(env_get SELLRIGHT_OFFSITE_REMOTE)"
  if [ -z "$remote" ]; then
    log "SELLRIGHT_OFFSITE_REMOTE not set in ${SELLRIGHT_HOME}/.env; skipping off-site copy."
    return 0
  fi
  command -v rclone >/dev/null 2>&1 || die "rclone not installed; cannot push off-site backup"
  master_key="$(env_get SELLRIGHT_MASTER_KEY)"
  kit_id="$(env_get RECOVERY_KIT_ID)"
  enc_key=$(derive_key enc "$master_key" "$kit_id")
  mac_key=$(derive_key mac "$master_key" "$kit_id")
  enc_dir=$(mktemp -d)
  trap 'rm -rf -- "$enc_dir"' 0
  trap 'exit 1' HUP INT TERM
  for f in database.dump assets.tar.gz downloads.tar.gz manifest.json; do
    encrypt_authenticated "${out_dir}/${f}" "${enc_dir}/${f}.enc" "$enc_key" "$mac_key"
  done
  rclone copy "$enc_dir" "${remote}/$(basename "$out_dir")/"
  log "Off-site (encrypted + authenticated) backup pushed to ${remote}/$(basename "$out_dir")/"
)

cmd_recovery_kit() {
  require_home
  [ -f "${SELLRIGHT_HOME}/recovery-kit.json" ] || die "no recovery kit found at ${SELLRIGHT_HOME}/recovery-kit.json"
  cat "${SELLRIGHT_HOME}/recovery-kit.json"
}

# Runs in a disposable API container. No archive path is ever handed to tar:
# the decoder accepts only regular files/directories beneath the expected root.
restore_helper_source() {
  cat <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const base = '/tmp/sellright-restore';
const parts = ['database.dump', 'assets.tar.gz', 'downloads.tar.gz'];
// Resolve through existing production dependency owners, not an undeclared
// top-level package: API -> exceljs -> archiver -> tar-stream (lockfile pinned).
const { createRequire } = require('node:module');
const appRequire = createRequire('/app/package.json');
const excelRequire = createRequire(appRequire.resolve('exceljs'));
const archiveRequire = createRequire(excelRequire.resolve('archiver'));
const tar = archiveRequire('tar-stream');
function safeName(name, root) {
  if (/[\0-\x1f\x7f\\]/.test(name) || name.startsWith('/')) throw Error('unsafe archive path');
  const bits = name.replace(/\/$/, '').split('/');
  if (bits[0] !== root || bits.some(s => !s || s === '.' || s === '..')) throw Error('archive path outside expected root');
  return bits.slice(1).join('/');
}
async function extract(root) {
  const dest = `${base}/next/${root}`;
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const decoder = tar.extract(), seen = new Set(), directories = [];
  let entries = 0;
  decoder.on('entry', (header, entry, next) => {
    (async () => {
      if (header.type !== 'file' && header.type !== 'directory') throw Error('archive links/special files forbidden');
      const relative = safeName(header.name, root), target = path.join(dest, relative);
      if (seen.has(relative) || (!relative && header.type !== 'directory')) throw Error('duplicate/invalid archive entry');
      seen.add(relative); entries++;
      if (header.type === 'directory') {
        if (header.size) throw Error('directory payload forbidden');
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        directories.push([target, (header.mode & 0o777) | 0o700]);
        entry.resume();
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        // Keep staging readable by this same unprivileged helper. No archive
        // ownership, setuid bits or special filesystem objects are restored.
        await pipeline(entry, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
        fs.chmodSync(target, (header.mode & 0o777) | 0o600);
      }
    })().then(() => next(), e => decoder.destroy(e));
  });
  await pipeline(fs.createReadStream(`${base}/${root}.tar.gz`), zlib.createGunzip(), decoder);
  if (!entries) throw Error('empty archive');
  for (const [directory, mode] of directories) fs.chmodSync(directory, mode);
}
function copyContents(from, to) {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(from)) fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
}
async function main() {
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const [op, part] = process.argv.slice(2);
  if (op === 'receive') {
    if (![...parts, 'manifest.json'].includes(part)) throw Error('invalid part');
    await pipeline(process.stdin, fs.createWriteStream(`${base}/${part}`, { flags: 'wx', mode: 0o600 }));
  } else if (op === 'stage') {
    if (fs.existsSync(`${base}/manifest.json`)) {
      const manifest = JSON.parse(fs.readFileSync(`${base}/manifest.json`, 'utf8'));
      for (const part of parts) {
        const expected = manifest.parts?.[part];
        if (typeof expected !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expected)) throw Error('missing/invalid manifest hash: ' + part);
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(`${base}/${part}`)) hash.update(chunk);
        if ('sha256:' + hash.digest('hex') !== expected) throw Error('manifest hash mismatch: ' + part);
      }
    }
    await extract('assets'); await extract('downloads');
  } else if (op === 'snapshot') {
    for (const root of ['assets', 'downloads']) copyContents(`/app/var/${root}`, `${base}/previous/${root}`);
    fs.writeFileSync(`${base}/snapshot-complete`, 'yes');
  } else if (op === 'promote' || op === 'rollback') {
    if (!fs.existsSync(`${base}/snapshot-complete`)) throw Error('missing rollback snapshot');
    for (const root of ['assets', 'downloads']) {
      const live = `/app/var/${root}`;
      for (const name of fs.readdirSync(live)) fs.rmSync(path.join(live, name), { recursive: true, force: true });
      copyContents(`${base}/${op === 'promote' ? 'next' : 'previous'}/${root}`, live);
    }
  } else throw Error('invalid operation');
}
main().catch(e => { console.error('Restore staging:', e.message); process.exitCode = 1; });
JS
}

# Rollback checks the catalog, rather than trusting a successful client return:
# a connection loss can happen after PostgreSQL commits a database rename.
restore_rollback() {
  log "Restore failed; stopping API and recovering original database and files..."
  compose stop api || return 1
  previous_exists=$(compose exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U sellright -d postgres -c "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='${prev_db}');") || return 1
  live_exists=$(compose exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U sellright -d postgres -c "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='sellright');") || return 1
  case "$previous_exists:$live_exists" in t:t|t:f|f:t) : ;; *) return 1 ;; esac
  if [ "$previous_exists" = t ]; then
    if [ "$live_exists" = t ]; then
      compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE sellright ALLOW_CONNECTIONS false;" || return 1
      compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='sellright';" || return 1
      compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE sellright RENAME TO ${failed_db};" || return 1
    fi
    compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE ${prev_db} RENAME TO sellright;" || return 1
  fi
  if [ "$files_changed" -eq 1 ]; then
    docker exec "$restore_container" node /tmp/restore.js rollback || return 1
  fi
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE sellright ALLOW_CONNECTIONS true;" || return 1
  compose up -d --wait --wait-timeout 120 api || { compose stop api; return 1; }
  log "Original database, assets and downloads recovered; API healthy."
}

cmd_restore() (
  umask 077
  restore_dir=""; restore_container=""; restore_lock=0; temp_created=0
  live_stopped=0; files_changed=0; retain=0
  # Called only by the EXIT trap; ShellCheck cannot track that invocation.
  # shellcheck disable=SC2329
  restore_cleanup() {
    status=$?
    trap - 0 HUP INT TERM
    if [ "$live_stopped" -eq 1 ]; then
      if ! restore_rollback; then
        retain=1
        compose stop api || true
        log "ERROR: rollback failed; API left stopped. Retained helper '${restore_container}', databases '${prev_db}', '${failed_db}', '${restore_db}' and safety backup for manual recovery."
      fi
    fi
    if [ "$retain" -eq 0 ]; then
      if [ -n "$restore_container" ]; then docker rm -f "$restore_container" >/dev/null || true; fi
      if [ "$temp_created" -eq 1 ]; then compose exec -T postgres dropdb --if-exists -U sellright "$restore_db" || true; fi
    fi
    if [ -n "$restore_dir" ]; then rm -rf -- "$restore_dir"; fi
    if [ "$restore_lock" -eq 1 ]; then rmdir "${SELLRIGHT_HOME}/.restore-lock" || true; fi
    exit "$status"
  }
  trap 'restore_cleanup' 0
  trap 'exit 1' HUP INT TERM
  kit=""; set_file=""; yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --kit) [ $# -ge 2 ] || die "missing --kit value"; kit="$2"; shift 2 ;;
      --set) [ $# -ge 2 ] || die "missing --set value"; set_file="$2"; shift 2 ;;
      --yes) yes=1; shift ;;
      *) die "unknown restore option: $1" ;;
    esac
  done
  [ -f "$kit" ] && [ -d "$set_file" ] && [ ! -L "$set_file" ] || die "usage: sellright restore --kit <recovery-kit.json> --set <backup-dir> [--yes]"
  require_home
  mkdir -m 700 "${SELLRIGHT_HOME}/.restore-lock" || die "restore lock exists; another restore may be running"
  restore_lock=1
  restore_dir=$(mktemp -d)
  restore_id=$(basename "$restore_dir" | LC_ALL=C tr -cd '[:alnum:]' | LC_ALL=C tr '[:upper:]' '[:lower:]')
  restore_container="sellright-restore-${restore_id}"
  restore_db="sellright_restore_${restore_id}"
  prev_db="sellright_prev_${restore_id}"
  failed_db="sellright_failed_${restore_id}"
  work_dir="$set_file"
  if [ -e "${set_file}/database.dump.enc" ] || [ -L "${set_file}/database.dump.enc" ]; then
    log "Backup set is encrypted; verifying integrity and decrypting with the recovery kit..."
    kit_key=$(sed -n 's/.*"masterKey": *"\([^"]*\)".*/\1/p' "$kit")
    kit_id=$(sed -n 's/.*"kitId": *"\([^"]*\)".*/\1/p' "$kit")
    [ -n "$kit_key" ] && [ -n "$kit_id" ] || die "could not read masterKey/kitId from $kit"
    enc_key=$(derive_key enc "$kit_key" "$kit_id")
    mac_key=$(derive_key mac "$kit_key" "$kit_id")
    work_dir="$restore_dir"
    for part in database.dump assets.tar.gz downloads.tar.gz manifest.json; do
      input="${set_file}/${part}.enc"
      if [ "$part" = manifest.json ] && [ ! -e "$input" ] && [ ! -L "$input" ]; then continue; fi
      [ -f "$input" ] && [ ! -L "$input" ] && [ -f "$input.hmac" ] && [ ! -L "$input.hmac" ] || die "missing/unsafe encrypted part: $part"
      decrypt_authenticated "$input" "${work_dir}/${part}" "$enc_key" "$mac_key"
    done
  fi
  for part in database.dump assets.tar.gz downloads.tar.gz; do
    [ -f "${work_dir}/${part}" ] && [ ! -L "${work_dir}/${part}" ] || die "backup set is missing/unsafe ${part}"
  done
  [ ! -L "${work_dir}/manifest.json" ] || die "unsafe manifest symlink"
  if [ -e "${work_dir}/manifest.json" ]; then [ -f "${work_dir}/manifest.json" ] || die "invalid manifest"; fi
  if [ "$yes" -ne 1 ]; then
    [ -t 0 ] || die "refusing to promote a restore without confirmation in a non-interactive session; pass --yes"
    printf 'This REPLACES live database, assets and downloads. Type "yes" to continue: ' >&2
    read -r confirm
    [ "$confirm" = yes ] || die "aborted (confirmation not given)"
  fi
  # Freeze caller-owned plain files before any validation/DB use; all later
  # consumers see the same bytes, including the manifest-verified dump.
  if [ "$work_dir" != "$restore_dir" ]; then
    for part in database.dump assets.tar.gz downloads.tar.gz manifest.json; do
      [ -f "${work_dir}/${part}" ] || continue
      cp -- "${work_dir}/${part}" "${restore_dir}/${part}"
    done
    work_dir="$restore_dir"
  fi
  # Override appliance command; this container never starts API/migrations.
  compose run -d --no-deps --name "$restore_container" api node -e 'setInterval(() => {}, 3600000)' >/dev/null
  restore_helper_source | docker exec -i "$restore_container" sh -c 'umask 077; cat > /tmp/restore.js'
  for part in database.dump assets.tar.gz downloads.tar.gz manifest.json; do
    [ -f "${work_dir}/${part}" ] || continue
    docker exec -i "$restore_container" node /tmp/restore.js receive "$part" < "${work_dir}/${part}"
  done
  docker exec "$restore_container" node /tmp/restore.js stage
  compose exec -T postgres pg_restore --list < "${work_dir}/database.dump" >/dev/null
  compose exec -T postgres createdb -U sellright "$restore_db"
  temp_created=1
  compose exec -T postgres pg_restore -U sellright -d "$restore_db" --exit-on-error --single-transaction --no-owner --no-privileges < "${work_dir}/database.dump"
  log "All backup parts validated and staged; taking pre-restore safety backup..."
  cmd_backup >&2
  live_stopped=1
  compose stop api
  docker exec "$restore_container" node /tmp/restore.js snapshot
  # Block new connections before terminating existing clients and renaming.
  for db in sellright "$restore_db"; do
    compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE ${db} ALLOW_CONNECTIONS false;"
  done
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('sellright','${restore_db}');"
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE sellright RENAME TO ${prev_db};"
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE ${restore_db} RENAME TO sellright;"
  files_changed=1
  docker exec "$restore_container" node /tmp/restore.js promote
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U sellright -d postgres -c "ALTER DATABASE sellright ALLOW_CONNECTIONS true;"
  compose up -d --wait --wait-timeout 120 api
  live_stopped=0
  log "Restore promoted; API healthy. Previous database preserved as '${prev_db}'."
)

cmd_setup_link() {
  require_home
  # dist/scripts/setup-link.js prints ONLY the raw token on stdout (its own
  # progress/errors go to stderr, which passes through uncaptured here). It
  # exits non-zero — with an explanatory stderr line — once an installation
  # admin already exists; there is deliberately no way to re-claim an
  # installed instance through this path (use reset-admin instead).
  token=$(compose exec -T api node dist/scripts/setup-link.js) \
    || die "setup-link failed (see above). If this installation was already claimed, use: sellright reset-admin <email>"
  [ -n "$token" ] || die "setup-link produced no token"
  domain="$(env_get SELLRIGHT_DOMAIN)"
  case "$domain" in
    :*|'')
      log "Claim link (valid 7 days, single use). SELLRIGHT_DOMAIN isn't set to a real hostname yet, so this uses localhost — swap in your server's address if you're browsing remotely:"
      log "  http://localhost${domain}/setup?token=${token}"
      ;;
    *)
      log "Claim link (valid 7 days, single use):"
      log "  https://${domain}/setup?token=${token}"
      ;;
  esac
}

cmd_reset_admin() {
  require_home
  email="${1:-}"
  [ -n "$email" ] || die "usage: sellright reset-admin <email>"
  password="$(gen_secret_local 24)"
  compose exec -T -e ADMIN_PASSWORD="$password" api node dist/scripts/seed-admin.js "$email"
  log "Admin password reset for ${email}: ${password}"
  log "(shown once — this terminal only; not logged or stored anywhere else)"
}

gen_secret_local() {
  openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

cmd_maintenance() {
  require_home
  action="${1:-}"
  case "$action" in
    on|off|status) ;;
    *) die "usage: sellright maintenance <on|off|status>" ;;
  esac
  compose exec -T api node dist/scripts/maintenance-cli.js "$action"
}

cmd_functional_check() {
  require_home
  compose exec -T api node dist/scripts/functional-check.js
}

# Capture existing container image IDs, including locally built images with no
# RepoDigests. A complete content-addressed rollback plan is required pre-build.
capture_digests() (
  for svc in api admin storefront; do
    container=$(compose ps -q "$svc") || return 1
    case "$container" in ''|*[!a-f0-9]*) log "missing existing ${svc} container for rollback"; return 1 ;; esac
    [ "${#container}" -eq 64 ] || return 1
    image=$(docker inspect --format '{{.Image}}' "$container") || return 1
    case "$image" in ''|*[!a-z0-9:]*) return 1 ;; esac
    printf '%s\n' "$image" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
    printf '%s %s\n' "$svc" "$image" || return 1
  done
)

# Recreate only existing services from captured immutable image IDs. compose()
# retains the target project/host overrides; rollback never pulls or builds.

restart_digests() {
  digests_file="$1"
  [ -s "$digests_file" ] || { log "no previous digests recorded; cannot roll back automatically"; return 1; }
  override_file=$(mktemp)
  {
    printf 'services:\n'
    while read -r svc digest; do
      [ -n "$svc" ] || continue
      printf '  %s:\n    image: %s\n' "$svc" "$digest"
    done < "$digests_file"
  } > "$override_file"
  log "rollback plan:"
  cat "$digests_file" >&2
  # Through compose() (not a bare `docker compose ...`) so this honors any
  # project-name/host override compose() carries — in production both resolve
  # to the same `name: sellright` project either way, but a test harness that
  # patches compose() to add `-p <isolated-project>` (see the CI drill in
  # .github/workflows/ci.yml's verify-update job) must not have the rollback
  # path silently fall back to the default project and operate on the wrong
  # containers.
  rollback_status=0
  compose -f "$override_file" up --pull never --no-build -d --no-deps api admin storefront || rollback_status=$?
  rm -f "$override_file"
  return "$rollback_status"
}

update_compose() {
  if [ -n "${verified_override:-}" ]; then
    compose -f "$verified_override" "$@"
  else
    compose "$@"
  fi
}

cmd_update() {
  require_home
  from_source=0
  for arg in "$@"; do
    case "$arg" in
      --from-source) from_source=1 ;;
      *) die "unknown argument to 'update': $arg" ;;
    esac
  done

  digests_file=$(mktemp)
  verified_override=""
  trap 'rm -f "$digests_file"; [ -z "$verified_override" ] || rm -f "$verified_override"' EXIT

  log "1/7 entering maintenance mode..."
  cmd_maintenance on

  log "2/7 taking a backup..."
  cmd_backup

  log "recording current image digests (for rollback)..."
  capture_digests > "$digests_file" || die "could not capture all existing application images; refusing to update without rollback"

  if [ "$from_source" -eq 1 ]; then
    # Owner-operated private forks: no registry to pull signed images from,
    # so this path builds api/admin/storefront LOCALLY from the checked-out
    # repo at SELLRIGHT_SOURCE (compose.build.yaml, the same override file
    # local dev and CI's verify-appliance job already use) and skips the
    # cosign gate entirely — there is nothing to verify a signature against
    # for an image that was never published. This is intentionally a
    # separate, explicit flag: plain `sellright update` (no flag) must always
    # stay on the cosign-verified registry path; a host is never silently
    # downgraded to unverified images.
    : "${SELLRIGHT_SOURCE:?--from-source requires SELLRIGHT_SOURCE=/path/to/checked-out/sellright}"
    [ -f "${SELLRIGHT_SOURCE}/deploy/compose.build.yaml" ] || die "SELLRIGHT_SOURCE (${SELLRIGHT_SOURCE}) has no deploy/compose.build.yaml — not a sellright checkout?"
    log "3/7 building images from source (${SELLRIGHT_SOURCE}), no registry pull, no cosign verify..."
    # Compose resolves all relative build contexts from its project directory,
    # otherwise the installed first -f file would anchor them at SELLRIGHT_HOME.
    if ! compose --project-directory "${SELLRIGHT_SOURCE}/deploy" -f "${SELLRIGHT_SOURCE}/deploy/compose.build.yaml" build; then
      log "source build failed; leaving maintenance on, no changes made"
      exit 1
    fi
  else
    log "3/7 pulling + verifying signed images..."
    if ! compose pull; then
      log "pull failed; leaving maintenance on, no changes made"
      exit 1
    fi
    verified_override=$(mktemp)
    cosign_verify_images "$verified_override" || { log "cosign verification failed; leaving maintenance on, no changes made"; exit 1; }
  fi

  log "4/7 migrating..."
  # shellcheck disable=SC2016 # single-quoted deliberately: $DATABASE_URL_MIGRATE
  # must expand inside the container's sh, not here on the host.
  if ! update_compose run --pull never --rm --no-deps api sh -c 'DATABASE_URL="$DATABASE_URL_MIGRATE" node dist/scripts/migrate.js'; then
    log "migration failed; leaving maintenance on. No backup restore was performed — restore this backup set manually only if you determine the migration left the schema inconsistent: see sellright backup output above"
    exit 1
  fi

  log "5/7 starting updated services..."
  update_compose up --pull never --no-build -d api admin storefront

  log "6/7 running functional checks..."
  if ! cmd_functional_check; then
    log "functional checks FAILED after update. Rolling back to the previous images BEFORE reopening (maintenance stays on). No backup restore performed."
    restart_digests "$digests_file"
    log "rollback complete. Re-running functional checks against the restored images..."
    if cmd_functional_check; then
      log "previous images restored and healthy. Maintenance remains ON — clear it manually once you've investigated: sellright maintenance off"
    else
      log "CRITICAL: functional checks still failing after rollback. Maintenance remains ON. Manual intervention required — see docs/runbooks/migrations.md."
    fi
    exit 1
  fi

  log "7/7 leaving maintenance mode..."
  cmd_maintenance off
  log "update complete."
}

# Fail-closed: `sellright update` must never run an image it couldn't verify.
# Installs cosign itself (same download install.sh's install_cosign performs)
# rather than skipping — a host missing cosign is a setup gap to fix, not a
# reason to relax the update path's own signature gate.
ensure_cosign() {
  command -v cosign >/dev/null 2>&1 && return 0
  log "cosign not found; installing cosign ${COSIGN_VERSION}..."
  arch=$(uname -m)
  case "$arch" in
    x86_64) cosign_arch=amd64 ;;
    aarch64) cosign_arch=arm64 ;;
    *) die "unsupported architecture for cosign: $arch" ;;
  esac
  if ! curl -fsSL -o /usr/local/bin/cosign \
      "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${cosign_arch}"; then
    die "failed to download cosign — cannot verify image signatures, refusing to update"
  fi
  chmod +x /usr/local/bin/cosign
  command -v cosign >/dev/null 2>&1 || die "cosign install did not produce a usable binary"
}

# Keyless-signature check for the three images `compose pull` just fetched —
# i.e. the images `compose up -d` is about to SWITCH TO, not whatever is
# currently running. Fail-closed: missing cosign, an unresolvable image ref,
# or any failed verification all abort the update (non-zero return) —
# cmd_update treats that as "leave maintenance on, make no changes", never as
# "proceed anyway". This is the same identity/issuer install.sh's own
# verify_and_pull checks, re-applied here so `sellright update` never trusts
# a pull it hasn't independently verified itself.
#
# Bug history — read before touching image resolution here again:
#   1. `compose images -q "$svc"` resolves the image of the service's
#      CURRENTLY RUNNING container, not the tag `compose pull` just
#      repointed to (containers aren't recreated until later in cmd_update,
#      at "5/7 starting updated services"). An attacker or a broken registry
#      could serve an unsigned/wrong image at the pulled tag and the OLD,
#      already-verified image would get verified again while the new one
#      still gets switched to.
#   2. `compose config --images "$svc"` (a same-CI-run replacement attempt)
#      does NOT reliably filter to just that service — observed in CI
#      returning the FULL unfiltered image list regardless of the service
#      arg, so `| head -n 1` silently verified an unrelated service's image.
#   3. Zipping `compose config --services` with `compose config --images` by
#      LINE NUMBER (a second same-CI-run attempt) assumed the two separate
#      invocations enumerate services in the same order. They don't have to,
#      and in CI they didn't — this produced a different wrong image per run
#      (caddy, then postgres, both reported as "api").
# Fix: `compose config --format json` renders the FULLY RESOLVED config as
# one document; jq indexes `.services.<name>.image` directly by key — no
# filtering flag, no cross-invocation ordering assumption, no ambiguity.
# Select only a digest for the configured repository (including Docker Hub's
# familiar-name aliases). Never trust RepoDigests[0] when an image has aliases.
pulled_image_digest() {
  repo_digests=$(docker image inspect --format '{{json .RepoDigests}}' "$1") || return 1
  printf '%s' "$repo_digests" | jq -er --arg ref "$1" '
    def repository:
      split("@")[0] | sub(":[^/:]+$"; "") |
      if startswith("index.docker.io/") then sub("^index.docker.io/"; "docker.io/")
      elif (contains("/") | not) then "docker.io/library/" + .
      elif (split("/")[0] | contains(".") or contains(":") or . == "localhost") then .
      else "docker.io/" + . end |
      if startswith("docker.io/") and (split("/") | length) == 2
      then sub("^docker.io/"; "docker.io/library/") else . end;
    if type != "array" then error("missing repository digests")
    elif any(.[]; type != "string") then error("invalid repository digests")
    else map(select(test("^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$") and (contains("\n") | not)) |
      select(repository == ($ref | repository)) |
      select(($ref | contains("@") | not) or (split("@")[1] == ($ref | split("@")[1])))) |
      unique | if length == 1 then .[0] else error("missing or ambiguous configured repository digest") end
    end'
}

# $1 is a private temporary override consumed by BOTH migration & recreation.
# Resolve config once, then pull & verify its refs individually: a later tag or
# .env change cannot change executable application content.
cosign_verify_images() (
  ensure_cosign || return 1
  command -v jq >/dev/null 2>&1 || { log "jq not found — required to resolve target image refs; refusing to update"; return 1; }
  [ "$#" -eq 1 ] && [ -n "$1" ] || { log "verified image override path required"; return 1; }
  output_file=$1
  config_json=$(compose config --format json 2>/dev/null) || { log "could not read compose config; refusing to update"; return 1; }
  printf 'services:\n' > "$output_file" || return 1
  for svc in api admin storefront; do
    ref=$(printf '%s' "$config_json" | jq -er --arg svc "$svc" '.services[$svc] | select(.build == null and .pull_policy != "build") | .image | select(type == "string" and length > 0)') || { log "could not resolve target image for ${svc}; refusing to update"; return 1; }
    case "$ref" in -*) log "invalid image reference for ${svc}"; return 1 ;; esac
    docker pull "$ref" || { log "pull failed for ${svc}; refusing to update"; return 1; }
    digest=$(pulled_image_digest "$ref" 2>/dev/null) || { log "could not resolve pulled digest for ${svc}; refusing to update"; return 1; }
    case "$digest" in ''|*[!A-Za-z0-9._:/@-]*) log "invalid pulled digest for ${svc}"; return 1 ;; esac
    printf '%s\n' "$digest" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$' || { log "invalid pulled digest for ${svc}; refusing to update"; return 1; }
    if ! cosign verify \
        --certificate-identity-regexp '^https://github.com/Orthic-Labs/sellright/' \
        --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
        "$digest" >/dev/null 2>&1; then
      log "cosign verify FAILED for ${svc} (${digest}); refusing to update"
      return 1
    fi
    printf '  %s:\n    image: %s\n' "$svc" "$digest" >> "$output_file" || return 1
  done
)

usage() {
  cat <<'EOF'
Usage: sellright <command> [args]

Commands:
  status              Show container status
  logs [service]      Tail logs (all services, or one)
  backup [--offsite]  Take a database + assets + downloads backup set
  recovery-kit        Print the recovery kit (master key + backup location)
  restore --kit <f> --set <dir> [--yes]
                      Restore + PROMOTE database, assets, and downloads from
                      a backup set (encrypted or plain). Destructive: takes a
                      pre-restore safety backup first and prompts for
                      confirmation unless --yes is given.
  setup-link          Print how to claim/reset the installation admin
  reset-admin <email> Reset the admin account directly
  maintenance <on|off|status>
                      Toggle or check maintenance mode directly
  functional-check    Run the post-update health checks directly
  update [--from-source]
                      Maintenance on -> backup -> pull+verify -> migrate ->
                      start -> functional checks -> maintenance off.
                      Rolls back to the previous images automatically if a
                      functional check fails before reopening.
                      --from-source builds api/admin/storefront locally from
                      SELLRIGHT_SOURCE (a checked-out repo, via
                      compose.build.yaml) instead of pulling+cosign-verifying
                      registry images — for owners running private forks with
                      no image registry. Same maintenance/backup/migrate/
                      functional-check/rollback flow either way.
EOF
}

main() {
  cmd="${1:-}"
  [ -n "$cmd" ] || { usage; exit 1; }
  shift
  case "$cmd" in
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    backup) cmd_backup "$@" ;;
    recovery-kit) cmd_recovery_kit "$@" ;;
    restore) cmd_restore "$@" ;;
    setup-link) cmd_setup_link "$@" ;;
    reset-admin) cmd_reset_admin "$@" ;;
    maintenance) cmd_maintenance "$@" ;;
    functional-check) cmd_functional_check "$@" ;;
    update) cmd_update "$@" ;;
    -h|--help|help) usage ;;
    *) log "unknown command: $cmd"; usage; exit 1 ;;
  esac
}

main "$@"
