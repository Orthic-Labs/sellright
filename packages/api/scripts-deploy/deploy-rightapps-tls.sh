#!/usr/bin/env bash
# One-shot Right Apps public TLS deploy. Run on the box WITH SUDO:
#   sudo bash ~/sites/sellright/packages/api/scripts-deploy/deploy-rightapps-tls.sh
#
# Why a dedicated cert (not --expand the spoares.com cert): the spoares.com APEX
# is behind Cloudflare Access, so its ACME HTTP-01 challenge gets redirected to a
# login page and fails. admin/api.spoares.com are DNS-only (grey) → not behind
# Access → their HTTP-01 challenge reaches the origin directly. So we mint a
# separate cert covering ONLY those two hosts and leave the apex cert alone.
set -euo pipefail
NGINX_DIR=/home/vendure/sites/nginx
VHOST="$NGINX_DIR/rightapps.conf"
WEBROOT="$NGINX_DIR/webroot"
EMAIL=adrdsouza@gmail.com

cd "$NGINX_DIR"

echo "== Phase 1: rebuild nginx with the rightapps vhost (still on the spoares.com cert) =="
docker compose build
docker compose run --rm nginx-brotli nginx -t          # aborts here if the config is bad
docker compose up -d
echo "   nginx up; admin/api.spoares.com now serve :80 (ACME) + :443 (temp cert)"

echo "== Phase 2: issue a dedicated LE cert for admin+api only (apex excluded) =="
certbot certonly --webroot -w "$WEBROOT" --cert-name rightapps \
  -d admin.spoares.com -d api.spoares.com \
  --non-interactive --agree-tos -m "$EMAIL" --keep-until-expiring

echo "== Phase 3: point the vhost at the new cert + reload nginx =="
sed -i 's#/etc/letsencrypt/live/spoares.com/#/etc/letsencrypt/live/rightapps/#g' "$VHOST"
docker compose build
docker compose run --rm nginx-brotli nginx -t
docker compose up -d

echo
echo "== DONE =="
echo "Test:  curl -sI https://api.spoares.com/v1/health"
echo "Admin: https://admin.spoares.com"
