#!/bin/sh
# SellRight host CLI. Installed to /usr/local/bin/sellright by install.sh.
# Operates on the Compose appliance at $SELLRIGHT_HOME (default /opt/sellright).
set -eu

SELLRIGHT_HOME="${SELLRIGHT_HOME:-/opt/sellright}"

compose() {
  docker compose --env-file "${SELLRIGHT_HOME}/.env" -f "${SELLRIGHT_HOME}/compose.yaml" "$@"
}

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_home() {
  [ -f "${SELLRIGHT_HOME}/.env" ] || die "no install found at ${SELLRIGHT_HOME} (run install.sh first, or set SELLRIGHT_HOME)"
}

env_get() {
  # shellcheck disable=SC1090,SC1091
  ( . "${SELLRIGHT_HOME}/.env" && eval "printf '%s' \"\${$1:-}\"" )
}

cmd_status() {
  require_home
  compose ps
}

cmd_logs() {
  require_home
  compose logs -f --tail=200 "$@"
}

cmd_backup() {
  require_home
  mkdir -p "${SELLRIGHT_HOME}/backups"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out_dir="${SELLRIGHT_HOME}/backups/${stamp}"
  mkdir -p "$out_dir"
  # The api container writes into this bind mount as its non-root `node`
  # user, whose uid won't generally match whoever owns $SELLRIGHT_HOME on the
  # host (root, via install.sh). 0777 only on this one transient per-backup
  # staging directory, not on $SELLRIGHT_HOME itself.
  chmod 777 "$out_dir"
  log "Backing up database..."
  compose exec -T postgres pg_dump -U sellright -d sellright -Fc > "${out_dir}/database.dump"
  log "Backing up assets and downloads volumes..."
  compose run --rm -v "${out_dir}:/backup" -T api \
    sh -c 'tar czf /backup/assets.tar.gz -C /app/var assets && tar czf /backup/downloads.tar.gz -C /app/var downloads'
  api_ref="${COMPOSE_API_IMAGE:-$(compose images -q api)}"
  {
    printf '{\n'
    printf '  "createdAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "appVersion": "%s",\n' "$(env_get SELLRIGHT_IMAGE_TAG)"
    printf '  "apiImageId": "%s",\n' "${api_ref:-unknown}"
    printf '  "parts": {\n'
    printf '    "database.dump": "sha256:%s",\n' "$(sha256sum "${out_dir}/database.dump" | cut -d' ' -f1)"
    printf '    "assets.tar.gz": "sha256:%s",\n' "$(sha256sum "${out_dir}/assets.tar.gz" | cut -d' ' -f1)"
    printf '    "downloads.tar.gz": "sha256:%s"\n' "$(sha256sum "${out_dir}/downloads.tar.gz" | cut -d' ' -f1)"
    printf '  }\n'
    printf '}\n'
  } > "${out_dir}/manifest.json"
  log "Backup set written to ${out_dir}"
  if [ "${1:-}" = "--offsite" ]; then
    cmd_backup_offsite "$out_dir"
  fi
}

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

cmd_backup_offsite() {
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
  for f in database.dump assets.tar.gz downloads.tar.gz manifest.json; do
    encrypt_authenticated "${out_dir}/${f}" "${enc_dir}/${f}.enc" "$enc_key" "$mac_key"
  done
  rclone copy "$enc_dir" "${remote}/$(basename "$out_dir")/"
  rm -rf "$enc_dir"
  log "Off-site (encrypted + authenticated) backup pushed to ${remote}/$(basename "$out_dir")/"
}

cmd_recovery_kit() {
  require_home
  [ -f "${SELLRIGHT_HOME}/recovery-kit.json" ] || die "no recovery kit found at ${SELLRIGHT_HOME}/recovery-kit.json"
  cat "${SELLRIGHT_HOME}/recovery-kit.json"
}

cmd_restore() {
  kit=""
  set_file=""
  yes=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --kit) kit="$2"; shift 2 ;;
      --set) set_file="$2"; shift 2 ;;
      --yes) yes=1; shift ;;
      *) die "unknown restore option: $1" ;;
    esac
  done
  usage_msg="usage: sellright restore --kit <recovery-kit.json> --set <backup-dir> [--yes]"
  [ -n "$kit" ] || die "$usage_msg"
  [ -n "$set_file" ] || die "$usage_msg"
  [ -f "$kit" ] || die "recovery kit not found: $kit"
  [ -e "$set_file" ] || die "backup set not found: $set_file"
  require_home

  work_dir="$set_file"
  if [ -f "${set_file}/database.dump.enc" ]; then
    log "Backup set is encrypted; verifying integrity and decrypting with the recovery kit..."
    kit_key=$(sed -n 's/.*"masterKey": *"\([^"]*\)".*/\1/p' "$kit")
    kit_id=$(sed -n 's/.*"kitId": *"\([^"]*\)".*/\1/p' "$kit")
    [ -n "$kit_key" ] && [ -n "$kit_id" ] || die "could not read masterKey/kitId from $kit"
    enc_key=$(derive_key enc "$kit_key" "$kit_id")
    mac_key=$(derive_key mac "$kit_key" "$kit_id")
    work_dir=$(mktemp -d)
    for f in "${set_file}"/*.enc; do
      base=$(basename "$f" .enc)
      decrypt_authenticated "$f" "${work_dir}/${base}" "$enc_key" "$mac_key"
    done
    # mktemp -d is 0700 owner-only; the assets/downloads restore step below
    # bind-mounts this dir read-only into the api container's non-root `node`
    # user, who otherwise can't even traverse into it.
    chmod 755 "$work_dir"
    chmod a+r "${work_dir}"/*
  fi

  for part in database.dump assets.tar.gz downloads.tar.gz; do
    [ -f "${work_dir}/${part}" ] || die "backup set is missing ${part} — refusing a partial restore"
  done

  # This is destructive by design: it replaces the live database, assets, and
  # downloads. Requires an explicit --yes outside a real terminal (CI, scripts)
  # rather than silently assuming consent.
  if [ "$yes" -ne 1 ]; then
    if [ -t 0 ]; then
      printf 'This REPLACES the live database, assets, and downloads with the restored backup.\nA safety backup of the current live data is taken first, but this is still destructive.\nType "yes" to continue: ' >&2
      read -r confirm
      [ "$confirm" = "yes" ] || die "aborted (confirmation not given)"
    else
      die "refusing to promote a restore without confirmation in a non-interactive session; pass --yes"
    fi
  fi

  log "Taking a pre-restore safety backup of the current live stack..."
  cmd_backup >&2

  log "Restoring database from ${work_dir}/database.dump into disposable database 'sellright_restore'..."
  compose exec -T postgres dropdb --if-exists -U sellright sellright_restore
  compose exec -T postgres createdb -U sellright sellright_restore
  compose exec -T postgres pg_restore -U sellright -d sellright_restore --no-owner --no-privileges < "${work_dir}/database.dump"

  log "Promoting: stopping api, terminating live connections, swapping database..."
  compose stop api
  compose exec -T postgres psql -U sellright -d postgres -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('sellright','sellright_restore') AND pid <> pg_backend_pid();"
  prev_db="sellright_prev_$(date -u +%Y%m%dT%H%M%SZ)"
  compose exec -T postgres psql -U sellright -d postgres -c "ALTER DATABASE sellright RENAME TO ${prev_db};"
  compose exec -T postgres psql -U sellright -d postgres -c "ALTER DATABASE sellright_restore RENAME TO sellright;"

  log "Promoting: replacing live assets and downloads volumes..."
  compose run --rm -v "${work_dir}:/backup:ro" -T api sh -c '
    set -e
    rm -rf /app/var/assets/* /app/var/assets/.[!.]* 2>/dev/null || true
    tar xzf /backup/assets.tar.gz -C /app/var/assets --strip-components=1
    rm -rf /app/var/downloads/* /app/var/downloads/.[!.]* 2>/dev/null || true
    tar xzf /backup/downloads.tar.gz -C /app/var/downloads --strip-components=1
  '

  compose up -d api
  [ "$work_dir" = "$set_file" ] || rm -rf "$work_dir"
  log "Restore promoted. Previous database preserved as '${prev_db}' — drop it manually once verified:"
  log "  sellright status  # confirm api is healthy, then:"
  log "  docker compose ... exec postgres dropdb -U sellright ${prev_db}"
}

cmd_setup_link() {
  log "The /v1/setup/claim endpoint ships with WS-B. Until then, use:"
  log "  sellright reset-admin"
  log "to set a known admin email/password directly."
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

cmd_update() {
  die "update is not implemented yet (WS-E). Manually: sellright backup, then docker compose pull && up -d in ${SELLRIGHT_HOME}."
}

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
  update              (stub) update the appliance to the latest images
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
    update) cmd_update "$@" ;;
    -h|--help|help) usage ;;
    *) log "unknown command: $cmd"; usage; exit 1 ;;
  esac
}

main "$@"
