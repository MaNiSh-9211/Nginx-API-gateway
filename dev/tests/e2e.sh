#!/usr/bin/env bash
# Portable E2E smoke test for CI (Linux/macOS). Windows: use test.ps1 (full 33-case suite).
set -euo pipefail

GW="${GATEWAY_URL:-http://localhost:18083}"
CP="${CONTROL_PLANE_URL:-http://localhost:18085}"
SECRET="${JWT_SECRET:-super_secret_key_for_hmac_sha256_change_in_prod}"

pass=0; fail=0

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $name"
    ((pass++)) || true
  else
    echo "  FAIL: $name (expected $expected, got $actual)"
    ((fail++)) || true
  fi
}

# Regex match (for body/header assertions)
check_match() {
  local name="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -qE "$pattern"; then
    echo "  PASS: $name"
    ((pass++)) || true
  else
    echo "  FAIL: $name (expected match: $pattern)"
    ((fail++)) || true
  fi
}

code() { curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$1"; }

body() {
  local url="$1" auth="${2:-}"
  if [[ -n "$auth" ]]; then
    curl -s --max-time 10 -H "Authorization: Bearer $auth" "$url"
  else
    curl -s --max-time 10 "$url"
  fi
}

# Mint HS256 JWT (python3). Optional third arg: jti claim.
mint_jwt() {
  local sub="$1" region="$2" jti="${3:-}"
  python3 - "$sub" "$region" "$SECRET" "$jti" <<'PY'
import sys, json, base64, hmac, hashlib, time
sub, region, secret, jti = sys.argv[1:5]
now = int(time.time())
def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
header = b64url(json.dumps({"alg":"HS256","typ":"JWT"}).encode())
claims = {
    "sub": sub, "home_region": region, "iat": now, "exp": now+3600,
    "iss": "api-gateway-auth-server", "aud": "api-gateway-clients",
}
if jti:
    claims["jti"] = jti
payload = b64url(json.dumps(claims).encode())
msg = f"{header}.{payload}".encode()
sig = b64url(hmac.new(secret.encode(), msg, hashlib.sha256).digest())
print(f"{header}.{payload}.{sig}")
PY
}

echo "=== 1. Health & Readiness ==="
check "Gateway /health" "200" "$(code "$GW/health")"
check "Gateway /ready"  "200" "$(code "$GW/ready")"
check "Control plane /health" "200" "$(code "$CP/health")"

echo ""
echo "=== 2. Authentication ==="
check "No token -> 401" "401" "$(code "$GW/api/v1/orders")"
TOKEN=$(mint_jwt "ci-user" "EU")
check "Valid EU token -> 200" "200" "$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "$GW/api/v1/orders")"

echo ""
echo "=== 3. WAF ==="
check "Path traversal -> 403" "403" "$(code "$GW/etc/passwd?x=../../secret")"
check "Double-encoded XSS -> 403" "403" "$(code "$GW/api/v1/x?q=%253Cscript%253E")"
check "XSS in POST body -> 403" "403" "$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"x":"<script>alert(1)</script>"}' "$GW/api/v1/orders")"

echo ""
echo "=== 3b. Security headers (proxied route) ==="
HDRS=$(curl -s -D - -o /dev/null --max-time 10 "$GW/public/status")
check_match "X-Frame-Options: DENY" "(?i)x-frame-options:.*deny" "$HDRS"
check_match "X-Content-Type-Options: nosniff" "(?i)x-content-type-options:.*nosniff" "$HDRS"

echo ""
echo "=== 4. Public route ==="
check "Public route -> 200" "200" "$(code "$GW/public/status")"

echo ""
echo "=== 5. Identity headers (ADR-0040) ==="
EU_BODY=$(body "$GW/" "$TOKEN")
check_match "X-User-Id forwarded" "ci-user" "$EU_BODY"
SPOOF_BODY=$(curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" -H "X-User-Id: attacker" "$GW/")
check_match "Spoofed X-User-Id ignored (ADR-0048)" "ci-user" "$SPOOF_BODY"
check_match "Spoofed header not attacker" "^(?!.*attacker).*" "$SPOOF_BODY"

echo ""
echo "=== 6. Config security ==="
CFG=$(curl -s --max-time 10 "$CP/config")
if echo "$CFG" | grep -q 'jwt_secret'; then
  echo "  FAIL: JWT secret NOT exposed (found jwt_secret in response)"
  ((fail++)) || true
else
  echo "  PASS: JWT secret NOT exposed"
  ((pass++)) || true
fi

echo ""
echo "=== 7. Metrics ==="
METRICS=$(curl -s --max-time 10 "$GW/metrics")
check_match "gateway_config_ready 1" "gateway_config_ready 1" "$METRICS"

echo ""
echo "=== 8. Token revocation (ADR-0038/0039) ==="
REV_JTI="ci-revoke-$(date +%s)"
REV_TOKEN=$(mint_jwt "revoked-ci" "EU" "$REV_JTI")
curl -s -o /dev/null -X POST "$CP/revoke" \
  -H "Content-Type: application/json" \
  -d "{\"jti\":\"$REV_JTI\",\"ttl_secs\":120}"
check "Revoked jti token -> 401" "401" "$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $REV_TOKEN" "$GW/api/v1/orders")"

echo ""
echo "=== Summary ==="
total=$((pass + fail))
echo "  Passed: $pass / $total"
[[ "$fail" -eq 0 ]]
