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
  # P8 (E3): compose.yaml budgets ~3.2 GiB across services (postgres 1g, api 1g, storefront 768m, caddy 256m,
  # admin 128m). A 4 GiB host reports roughly 3.7-3.9 GiB MemTotal after the kernel's reservation.
  if [ "$mem_mb" -lt 3600 ]; then
    die "at least 4 GiB RAM required, found ${mem_mb} MiB"
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
  # Read Compose's resolved environment as data. A preserved .env is not a
  # shell program, and must never execute before signature verification.
  config_json=$(cd "$SELLRIGHT_HOME" && docker compose --env-file .env -f compose.yaml config --format json) || die "could not read recovery kit configuration"
  umask 077
  # Keep resolved secrets on stdin, never in jq argv or exported variables.
  printf '%s' "$config_json" | jq -e --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg backupLocation "${SELLRIGHT_HOME}/backups" \
    '.services.api.environment |
      if type != "object" then error("missing recovery environment")
      elif (.RECOVERY_KIT_ID | type) != "string" or
           (.SELLRIGHT_MASTER_KEY | type) != "string"
      then error("invalid recovery values")
      elif (.SELLRIGHT_MASTER_KEY | length) == 0 then error("missing recovery master key")
      else {kitId: .RECOVERY_KIT_ID, generatedAt: $generatedAt,
        masterKey: .SELLRIGHT_MASTER_KEY, backupLocation: $backupLocation,
        offsite: {configured: false,
        note: "Run sellright backup --offsite after configuring SELLRIGHT_S3_* / rclone remote to enable encrypted off-site copies."}}
      end' > "$kit_file" || { rm -f "$kit_file"; die "could not write recovery kit"; }
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

# Freeze the actual Compose-selected application images, not installer defaults.
# Tags are used only for pulling; signature verification & execution use digests.
verify_and_pull() {
  verified_override=$(mktemp)
  trap 'rm -f "$verified_override"' 0
  command -v jq >/dev/null 2>&1 || die "jq is required to resolve configured images"
  ( cd "$SELLRIGHT_HOME" && docker compose --env-file .env -f compose.yaml pull ) || die "image pull failed"
  config_json=$(cd "$SELLRIGHT_HOME" && docker compose --env-file .env -f compose.yaml config --format json) || die "could not read compose config"
  printf 'services:\n' > "$verified_override" || die "could not write verified image override"
  for svc in api admin storefront; do
    ref=$(printf '%s' "$config_json" | jq -er --arg svc "$svc" '.services[$svc] | select(.build == null and .pull_policy != "build") | .image | select(type == "string" and length > 0)') || die "could not resolve image for ${svc}"
    case "$ref" in -*) die "invalid image reference for ${svc}" ;; esac
    docker pull "$ref" || die "image pull failed for ${svc}"
    digest=$(pulled_image_digest "$ref" 2>/dev/null) || die "could not resolve pulled digest for ${svc}"
    case "$digest" in ''|*[!A-Za-z0-9._:/@-]*) die "invalid pulled digest for ${svc}" ;; esac
    printf '%s\n' "$digest" | LC_ALL=C grep -Eq '^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$' || die "invalid pulled digest for ${svc}"
    log "Verifying signature for ${digest}..."
    cosign verify \
      --certificate-identity-regexp "^https://github.com/Orthic-Labs/sellright/" \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$digest" >/dev/null || die "cosign verification failed for ${svc}; refusing to run an unsigned image"
    printf '  %s:\n    image: %s\n' "$svc" "$digest" >> "$verified_override" || die "could not write verified image override"
  done
}

start_stack() {
  [ -n "${verified_override:-}" ] && [ -s "$verified_override" ] || die "verified image override missing"
  ( cd "$SELLRIGHT_HOME" && docker compose --env-file .env -f compose.yaml -f "$verified_override" up --pull never --no-build -d )
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
