#!/usr/bin/env bash
# CI-only runtime regression using the production Caddyfile & pinned production image.
set -euo pipefail
name="sellright-caddy-ip-$$"
fixture=$(mktemp -d)
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker network rm "$name-cf" "$name-direct" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT
# Simulate an actual Cloudflare socket separately from an untrusted direct-origin socket.
docker network create --internal --subnet 173.245.48.0/24 "$name-cf" >/dev/null
docker network create --internal --subnet 172.29.240.0/24 "$name-direct" >/dev/null
cp deploy/Caddyfile "$fixture/Caddyfile"
cat >> "$fixture/Caddyfile" <<'CADDY'

:8080, :4100 {
    respond "{header.X-Real-IP}|{header.CF-Connecting-IP}"
}
CADDY
docker create --name "$name" --network "$name-cf" --ip 173.245.48.2 \
  --network-alias edge --network-alias admin --network-alias storefront \
  -e SELLRIGHT_DOMAIN=http://edge -e SELLRIGHT_STOREFRONT_DOMAIN=:8090 \
  -v "$fixture/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.10-alpine >/dev/null
docker network connect --ip 172.29.240.2 --alias edge "$name-direct" "$name"
docker start "$name" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$name" wget -qO- http://127.0.0.1:8080 >/dev/null 2>&1; then break; fi
  if [ "$attempt" = 30 ]; then docker logs "$name"; exit 1; fi
  sleep 1
done
request() {
  docker run --rm --network "$1" --ip "$2" --entrypoint wget caddy:2.10-alpine \
    -qO- --header="CF-Connecting-IP: $3" --header='X-Real-IP: 203.0.113.250' \
    --header='X-Forwarded-For: 203.0.113.251' "http://edge:$4/probe"
}
for port in 80 8090; do
  # Visitors behind one CF socket keep distinct identities; attacker-supplied X-Real-IP never survives.
  test "$(request "$name-cf" 173.245.48.3 198.51.100.1 "$port")" = '198.51.100.1|'
  test "$(request "$name-cf" 173.245.48.3 198.51.100.2 "$port")" = '198.51.100.2|'
  # Direct visitors cannot choose identity through either public forwarding header.
  test "$(request "$name-direct" 172.29.240.3 198.51.100.99 "$port")" = '172.29.240.3|'
done
echo 'Caddy preserves verified visitor identity & rejects direct-origin header spoofing'
