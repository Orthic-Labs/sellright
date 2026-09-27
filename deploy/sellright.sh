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

cmd_backup_offsite() {
  out_dir="$1"
  remote="$(env_get SELLRIGHT_OFFSITE_REMOTE)"
  if [ -z "$remote" ]; then
    log "SELLRIGHT_OFFSITE_REMOTE not set in ${SELLRIGHT_HOME}/.env; skipping off-site copy."
    return 0
  fi
  command -v rclone >/dev/null 2>&1 || die "rclone not installed; cannot push off-site backup"
  key="$(env_get SELLRIGHT_MASTER_KEY)"
  kit_id="$(env_get RECOVERY_KIT_ID)"
  enc_dir=$(mktemp -d)
  for f in database.dump assets.tar.gz downloads.tar.gz manifest.json; do
    openssl enc -aes-256-cbc -pbkdf2 -salt \
      -pass "pass:${key}:${kit_id}" \
      -in "${out_dir}/${f}" -out "${enc_dir}/${f}.enc"
  done
  rclone copy "$enc_dir" "${remote}/$(basename "$out_dir")/"
  rm -rf "$enc_dir"
  log "Off-site (encrypted) backup pushed to ${remote}/$(basename "$out_dir")/"
}

cmd_recovery_kit() {
  require_home
  [ -f "${SELLRIGHT_HOME}/recovery-kit.json" ] || die "no recovery kit found at ${SELLRIGHT_HOME}/recovery-kit.json"
  cat "${SELLRIGHT_HOME}/recovery-kit.json"
}

cmd_restore() {
  kit=""
  set_file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --kit) kit="$2"; shift 2 ;;
      --set) set_file="$2"; shift 2 ;;
      *) die "unknown restore option: $1" ;;
    esac
  done
  [ -n "$kit" ] || die "usage: sellright restore --kit <recovery-kit.json> --set <backup-dir-or-tarball>"
  [ -n "$set_file" ] || die "usage: sellright restore --kit <recovery-kit.json> --set <backup-dir-or-tarball>"
  [ -f "$kit" ] || die "recovery kit not found: $kit"
  [ -e "$set_file" ] || die "backup set not found: $set_file"
  require_home

  work_dir="$set_file"
  if [ -f "${set_file}/database.dump.enc" ]; then
    log "Backup set is encrypted; decrypting with the recovery kit's master key..."
    kit_key=$(sed -n 's/.*"masterKey": *"\([^"]*\)".*/\1/p' "$kit")
    kit_id=$(sed -n 's/.*"kitId": *"\([^"]*\)".*/\1/p' "$kit")
    [ -n "$kit_key" ] && [ -n "$kit_id" ] || die "could not read masterKey/kitId from $kit"
    work_dir=$(mktemp -d)
    for f in "${set_file}"/*.enc; do
      base=$(basename "$f" .enc)
      openssl enc -d -aes-256-cbc -pbkdf2 -salt \
        -pass "pass:${kit_key}:${kit_id}" \
        -in "$f" -out "${work_dir}/${base}"
    done
  fi

  log "Restoring database from ${work_dir}/database.dump into disposable database 'sellright_restore'..."
  compose exec -T postgres dropdb --if-exists -U sellright sellright_restore
  compose exec -T postgres createdb -U sellright sellright_restore
  compose exec -T postgres pg_restore -U sellright -d sellright_restore --no-owner --no-privileges < "${work_dir}/database.dump"
  [ "$work_dir" = "$set_file" ] || rm -rf "$work_dir"
  log "Restored into disposable database 'sellright_restore'. Run docs/runbooks/recovery.md's cutover steps to promote it."
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
  restore --kit <f> --set <dir>
                      Restore a backup set into a disposable database
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
