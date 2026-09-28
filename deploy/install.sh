#!/bin/sh
# SellRight one-click installer for the single-VPS Compose appliance.
#
# Usage: curl -fsSL <url>/install.sh | sh
#    or: sh install.sh
#
# Idempotent: safe to re-run. Never prints or echoes a generated secret.
set -eu

SELLRIGHT_HOME="${SELLRIGHT_HOME:-/opt/sellright}"
IMAGE_PREFIX="${SELLRIGHT_IMAGE_PREFIX:-ghcr.io/orthic-labs/sellright}"
IMAGE_TAG="${SELLRIGHT_IMAGE_TAG:-latest}"
REPO_RAW="${SELLRIGHT_REPO_RAW:-https://raw.githubusercontent.com/Orthic-Labs/sellright/main}"
COSIGN_VERSION="${COSIGN_VERSION:-2.4.1}"

log() { printf '%s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "install.sh must run as root (it writes /opt/sellright and installs Docker). Try: sudo sh install.sh"
  fi
}

check_os() {
  [ -r /etc/os-release ] || die "cannot detect OS: /etc/os-release missing"
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) : ;;
    *) die "unsupported OS '${ID:-unknown}': install.sh supports Ubuntu/Debian only today" ;;
  esac
}

check_resources() {
  mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
  mem_mb=$((mem_kb / 1024))
  if [ "$mem_mb" -lt 1800 ]; then
    die "at least 2 GiB RAM required, found ${mem_mb} MiB"
  fi
  avail_kb=$(df -Pk / | awk 'NR==2{print $4}')
  avail_gb=$((avail_kb / 1024 / 1024))
  if [ "$avail_gb" -lt 10 ]; then
    die "at least 10 GiB free disk required on /, found ${avail_gb} GiB"
  fi
}

check_ports() {
  for p in 80 443; do
    if command -v ss >/dev/null 2>&1; then
      if ss -Htln "sport = :${p}" 2>/dev/null | grep -q ":${p}"; then
        die "port ${p} is already in use; stop whatever is listening on it and re-run"
      fi
    fi
  done
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + Compose already present, skipping install"
    return 0
  fi
  log "Installing Docker Engine..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

install_cosign() {
  if command -v cosign >/dev/null 2>&1; then
    return 0
  fi
  log "Installing cosign ${COSIGN_VERSION}..."
  arch=$(uname -m)
  case "$arch" in
    x86_64) cosign_arch=amd64 ;;
    aarch64) cosign_arch=arm64 ;;
    *) die "unsupported architecture for cosign: $arch" ;;
  esac
  curl -fsSL -o /usr/local/bin/cosign \
    "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/cosign-linux-${cosign_arch}"
  chmod +x /usr/local/bin/cosign
}

# `sellright update`'s cosign_verify_images (deploy/sellright.sh) resolves
# each service's target image via `docker compose config --format json | jq`
# — not installed by base Ubuntu/Debian, and not covered by install_docker/
# install_cosign above. Without it, every future `sellright update` fails
# closed with "jq not found", which is safe but should never surprise an
# operator on a freshly installed host.
install_jq() {
  if command -v jq >/dev/null 2>&1; then
    return 0
  fi
  log "Installing jq..."
  apt-get update -qq && apt-get install -y -qq jq
}

# Random URL-safe secret. $1 = byte length.
gen_secret() {
  openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
}

write_env() {
  env_file="${SELLRIGHT_HOME}/.env"
  if [ -f "$env_file" ]; then
    log "Existing ${env_file} found; leaving secrets untouched (idempotent re-run)."
    return 0
  fi
  log "Generating machine secrets (never displayed)..."
  umask 077
  {
    printf 'SELLRIGHT_IMAGE_PREFIX=%s\n' "$IMAGE_PREFIX"
    printf 'SELLRIGHT_IMAGE_TAG=%s\n' "$IMAGE_TAG"
    printf 'POSTGRES_PASSWORD=%s\n' "$(gen_secret 32)"
    printf 'POSTGRES_APP_PASSWORD=%s\n' "$(gen_secret 32)"
    printf 'SELLRIGHT_MASTER_KEY=%s\n' "$(gen_secret 32)"
    printf 'DOWNLOAD_URL_SECRET=%s\n' "$(gen_secret 32)"
    printf 'COOKIE_SECRET=%s\n' "$(gen_secret 32)"
    printf 'LICENSING_SECRET=%s\n' "$(gen_secret 32)"
    printf 'CONTACT_FORM_SECRET=%s\n' "$(gen_secret 32)"
    printf 'CACHE_SECRET=%s\n' "$(gen_secret 32)"
    printf 'RECOVERY_KIT_ID=%s\n' "$(gen_secret 8)"
    printf 'STOREFRONT_URL=%s\n' "${SELLRIGHT_DOMAIN:-https://localhost}"
    printf 'SELLRIGHT_DOMAIN=%s\n' "${SELLRIGHT_DOMAIN:-:80}"
    # No BOOTSTRAP_STORE_SLUG/ADMIN_EMAIL/ADMIN_PASSWORD here: the one-click
    # install claims itself in the browser (`sellright setup-link` +
    # POST /v1/setup/claim), never by typing a generated password out of a
    # file. An operator who wants the OLD env-based bootstrap can still set
    # all three by hand in this file after it's written (see compose.yaml).
  } > "$env_file"
  chmod 600 "$env_file"
}

write_recovery_kit() {
  kit_file="${SELLRIGHT_HOME}/recovery-kit.json"
  if [ -f "$kit_file" ]; then
    return 0
  fi
  # shellcheck disable=SC1090,SC1091
  . "${SELLRIGHT_HOME}/.env"
  umask 077
  cat > "$kit_file" <<EOF
{
  "kitId": "${RECOVERY_KIT_ID}",
  "generatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "masterKey": "${SELLRIGHT_MASTER_KEY}",
  "backupLocation": "${SELLRIGHT_HOME}/backups",
  "offsite": {
    "configured": false,
    "note": "Run 'sellright backup --offsite' after configuring deploy/.env's SELLRIGHT_S3_* / rclone remote to enable encrypted off-site copies."
  }
}
EOF
  chmod 600 "$kit_file"
  log "Recovery kit written to ${kit_file} (600, root-owned). Download and store it offline — it is required to restore this install and is never re-derivable."
}

fetch_release_files() {
  mkdir -p "$SELLRIGHT_HOME"
  for f in compose.yaml Caddyfile gateway-accounts.example.json; do
    if [ ! -f "${SELLRIGHT_HOME}/${f}" ]; then
      curl -fsSL -o "${SELLRIGHT_HOME}/${f}" "${REPO_RAW}/deploy/${f}"
    fi
  done
  if [ ! -f "${SELLRIGHT_HOME}/gateway-accounts.json" ]; then
    cp "${SELLRIGHT_HOME}/gateway-accounts.example.json" "${SELLRIGHT_HOME}/gateway-accounts.json"
    chmod 600 "${SELLRIGHT_HOME}/gateway-accounts.json"
  fi
  curl -fsSL -o /usr/local/bin/sellright "${REPO_RAW}/deploy/sellright.sh"
  chmod 755 /usr/local/bin/sellright
}

verify_and_pull() {
  images="api admin storefront"
  for svc in $images; do
    ref="${IMAGE_PREFIX}-${svc}:${IMAGE_TAG}"
    log "Verifying signature for ${ref}..."
    cosign verify \
      --certificate-identity-regexp "^https://github.com/Orthic-Labs/sellright/" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$ref" >/dev/null || die "cosign verification failed for ${ref}; refusing to run an unsigned image"
  done
  ( cd "$SELLRIGHT_HOME" && docker compose --env-file .env -f compose.yaml pull )
}

start_stack() {
  ( cd "$SELLRIGHT_HOME" && docker compose --env-file .env -f compose.yaml up -d )
}

wait_for_api() {
  log "Waiting for the API to finish migrating and come up..."
  i=0
  while [ "$i" -lt 60 ]; do
    if ( cd "$SELLRIGHT_HOME" && docker compose --env-file .env -f compose.yaml exec -T admin \
        wget -qO- http://127.0.0.1:8080/v1/readyz 2>/dev/null | grep -q '"status":"ok"' ); then
      return 0
    fi
    i=$((i + 1))
    sleep 2
  done
  die "API did not become ready in time; check: sellright logs api"
}

main() {
  require_root
  check_os
  check_resources
  check_ports
  install_docker
  install_cosign
  install_jq
  fetch_release_files
  write_env
  write_recovery_kit
  verify_and_pull
  start_stack
  wait_for_api
  log ""
  log "SellRight is running. Claim it — this link is shown ONLY here, once:"
  log ""
  /usr/local/bin/sellright setup-link
  log ""
  log "Recovery kit: ${SELLRIGHT_HOME}/recovery-kit.json — download it now and store it somewhere other than this server."
}

main "$@"
