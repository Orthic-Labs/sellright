#!/usr/bin/env bash
# Verify cookie sessions + CSRF + admin 2FA. The 2FA flow runs on a THROWAWAY
# admin account so it can never lock out the real operator.
set -euo pipefail
PW="${ADMIN_PASSWORD:?set ADMIN_PASSWORD env}"
B=http://127.0.0.1:3300
SS=(-H 'x-store-slug: damned' -H 'content-type: application/json')
jget() { python3 -c "import sys,json;print(json.load(sys.stdin).get('$1',''))"; }
# current TOTP code for a base32 secret (mirrors auth/totp.ts)
totp() { node -e '
const c=require("crypto");const B="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const dec=s=>{let b="";for(const ch of s.toUpperCase().replace(/=+$/,"")){const v=B.indexOf(ch);if(v>=0)b+=v.toString(2).padStart(5,"0");}const o=[];for(let i=0;i+8<=b.length;i+=8)o.push(parseInt(b.slice(i,i+8),2));return Buffer.from(o);};
const h=(s,n)=>{const bf=Buffer.alloc(8);bf.writeBigUInt64BE(BigInt(n));const m=c.createHmac("sha1",s).update(bf).digest();const o=m[m.length-1]&0xf;const x=((m[o]&0x7f)<<24)|((m[o+1]&0xff)<<16)|((m[o+2]&0xff)<<8)|(m[o+3]&0xff);return (x%1000000).toString().padStart(6,"0");};
console.log(h(dec(process.argv[1]),Math.floor(Date.now()/30000)));' "$1"; }

JAR=$(mktemp)
echo "[1] login (cookie session)"
R=$(curl -s -c "$JAR" -X POST $B/v1/admin/login "${SS[@]}" -d "{\"email\":\"adrdsouza@gmail.com\",\"password\":\"$PW\"}")
CSRF=$(echo "$R" | jget csrfToken); TOKEN=$(echo "$R" | jget token)
echo "  csrf=${CSRF:0:8} token=${TOKEN:0:8} cookie_set=$(grep -c sr_admin "$JAR")"

echo "[2] CSRF enforcement on a cookie mutation"
curl -s -b "$JAR" -o /dev/null -w "  cookie+csrf=%{http_code} (expect 200)\n" -X PATCH $B/v1/admin/settings/payments "${SS[@]}" -H "x-csrf-token: $CSRF" -d '{"cod":true}'
curl -s -b "$JAR" -o /dev/null -w "  cookie+NO-csrf=%{http_code} (expect 403)\n" -X PATCH $B/v1/admin/settings/payments "${SS[@]}" -d '{"cod":true}'
curl -s -o /dev/null -w "  bearer(no-cookie)=%{http_code} (expect 200, CSRF-exempt)\n" -X PATCH $B/v1/admin/settings/payments -H "authorization: Bearer $TOKEN" "${SS[@]}" -d '{"cod":true}'
curl -s -b "$JAR" -o /dev/null -w "  me-via-cookie=%{http_code} (expect 200)\n" $B/v1/admin/me -H 'x-store-slug: damned'

echo "[3] 2FA on a throwaway admin"
TADM="2fatest-$(date +%s | tail -c5)@test.local"; TPW="Test2fa-pw99"
curl -s -b "$JAR" -X POST $B/v1/admin/staff "${SS[@]}" -H "x-csrf-token: $CSRF" -d "{\"email\":\"$TADM\",\"role\":\"manager\",\"password\":\"$TPW\"}" -o /dev/null -w "  create-temp-admin=%{http_code}\n"
JAR2=$(mktemp)
R2=$(curl -s -c "$JAR2" -X POST $B/v1/admin/login "${SS[@]}" -d "{\"email\":\"$TADM\",\"password\":\"$TPW\"}")
CSRF2=$(echo "$R2" | jget csrfToken)
SECRET=$(curl -s -b "$JAR2" -X POST $B/v1/admin/2fa/setup "${SS[@]}" -H "x-csrf-token: $CSRF2" | jget secret)
echo "  setup secret=${SECRET:0:8}"
curl -s -b "$JAR2" -o /dev/null -w "  enable(valid code)=%{http_code} (expect 200)\n" -X POST $B/v1/admin/2fa/enable "${SS[@]}" -H "x-csrf-token: $CSRF2" -d "{\"secret\":\"$SECRET\",\"code\":\"$(totp "$SECRET")\"}"
echo "  login WITHOUT totp -> twoFactorRequired=$(curl -s -X POST $B/v1/admin/login "${SS[@]}" -d "{\"email\":\"$TADM\",\"password\":\"$TPW\"}" | jget twoFactorRequired)"
HASTOK=$(curl -s -X POST $B/v1/admin/login "${SS[@]}" -d "{\"email\":\"$TADM\",\"password\":\"$TPW\",\"totp\":\"$(totp "$SECRET")\"}" | jget token)
echo "  login WITH totp -> got token=$([ -n "$HASTOK" ] && echo yes || echo no)"
JAR3=$(mktemp)
R3=$(curl -s -c "$JAR3" -X POST $B/v1/admin/login "${SS[@]}" -d "{\"email\":\"$TADM\",\"password\":\"$TPW\",\"totp\":\"$(totp "$SECRET")\"}")
CSRF3=$(echo "$R3" | jget csrfToken)
curl -s -b "$JAR3" -o /dev/null -w "  disable 2FA=%{http_code} (expect 200)\n" -X POST $B/v1/admin/2fa/disable "${SS[@]}" -H "x-csrf-token: $CSRF3" -d "{\"code\":\"$(totp "$SECRET")\"}"
# revert the payments toggle noise
curl -s -b "$JAR" -X PATCH $B/v1/admin/settings/payments "${SS[@]}" -H "x-csrf-token: $CSRF" -d '{"cod":true}' >/dev/null
echo "DONE"
