#!/usr/bin/env pwsh
# ============================================================
# End-to-end test suite — Ultra-Scale API Gateway
#
# Mints REAL HS256 JWTs (signed with $SECRET, with iss/aud/exp/iat) so the
# gateway's strict auth accepts them. Requires the stack to be running:
#   docker compose up -d --build
#
# Usage: ./test.ps1
# ============================================================

$GW = $env:GATEWAY_URL;       if (-not $GW) { $GW = "http://localhost:18083" }
$CP = $env:CONTROL_PLANE_URL; if (-not $CP) { $CP = "http://localhost:18085" }
# Must match the gateway's JWT_SECRET (../gateway-edge/.env / root .env).
$SECRET = $env:JWT_SECRET;     if (-not $SECRET) { $SECRET = "super_secret_key_for_hmac_sha256_change_in_prod" }

$PASS = 0; $FAIL = 0

function Get-ConfigReadHeaders() {
    $tok = $env:CONFIG_READ_TOKEN
    if (-not $tok) { $tok = "uam_dev_config_read_token_change_me" }
    return @("X-Config-Read-Token: $tok")
}

function Test-Case($name, $expected, $actual) {
    if ($actual -match $expected) {
        Write-Host "  PASS: $name" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host "  FAIL: $name" -ForegroundColor Red
        Write-Host "        expected match: $expected" -ForegroundColor DarkRed
        Write-Host "        got:            $actual" -ForegroundColor DarkRed
        $script:FAIL++
    }
}

# ── JWT minting ───────────────────────────────────────────────
function ConvertTo-Base64Url([byte[]]$bytes) {
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-Jwt($userId, $region, [string]$jti = "") {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $exp = $now + 3600
    $headerJson  = '{"alg":"HS256","typ":"JWT"}'
    $jtiPart = if ($jti) { ",`"jti`":`"$jti`"" } else { "" }
    $payloadJson = "{`"sub`":`"$userId`",`"home_region`":`"$region`",`"iat`":$now,`"exp`":$exp,`"iss`":`"api-gateway-auth-server`",`"aud`":`"api-gateway-clients`"$jtiPart}"

    $h = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($headerJson))
    $p = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($payloadJson))
    $signingInput = "$h.$p"

    $hmac = [System.Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($SECRET))
    try {
        $sig = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($signingInput))
    } finally {
        $hmac.Dispose()
    }
    $s = ConvertTo-Base64Url $sig
    return "Bearer $h.$p.$s"
}

function Get-RawToken($bearer) {
    if ($bearer -match '^Bearer (.+)$') { return $Matches[1] }
    return $bearer
}

# ── curl helpers (return "STATUS|BODY") ───────────────────────
function Curl-Get($url, $auth = "", $ua = "", $extraHeaders = @()) {
    $cargs = @("-s", "-w", "`n%{http_code}")
    if ($auth) { $cargs += @("-H", "Authorization: $auth") }
    if ($ua)   { $cargs += @("-H", "User-Agent: $ua") }
    foreach ($h in $extraHeaders) { $cargs += @("-H", $h) }
    $cargs += $url
    $out = curl.exe @cargs
    $lines = $out -split "`n"
    $code = ($lines | Select-Object -Last 1).Trim()
    $body = ($lines | Select-Object -SkipLast 1) -join ""
    return "$code|$body"
}

function Curl-Post($url, $body = "", $auth = "") {
    $cargs = @("-s", "-w", "`n%{http_code}", "-X", "POST")
    if ($auth) { $cargs += @("-H", "Authorization: $auth") }
    if ($body) {
        $tmp = [System.IO.Path]::GetTempFileName()
        Set-Content -Path $tmp -Value $body -Encoding ASCII
        $cargs += @("-H", "Content-Type: application/json", "--data-binary", "@$tmp")
        $out = curl.exe @cargs $url
        Remove-Item $tmp
    } else {
        $cargs += $url
        $out = curl.exe @cargs
    }
    $lines = $out -split "`n"
    $code = ($lines | Select-Object -Last 1).Trim()
    $body2 = ($lines | Select-Object -SkipLast 1) -join ""
    return "$code|$body2"
}

# Returns response headers + trailing "HTTP_STATUS:<code>".
function Curl-GetHeaders($url, $auth = "") {
    $cargs = @("-s", "-D", "-", "-o", "NUL", "-w", "`nHTTP_STATUS:%{http_code}")
    if ($auth) { $cargs += @("-H", "Authorization: $auth") }
    $cargs += $url
    return (curl.exe @cargs 2>&1) -join "`n"
}

function Get-Body($curlResult) {
    if ($curlResult -match '^\d+\|(.*)$') { return $Matches[1] }
    return $curlResult
}

function Get-Status($curlResult) {
    if ($curlResult -match '^(\d+)\|') { return $Matches[1] }
    return ""
}

# Routing assertion: works with echo-backend (upstream name in body) OR
# backend-test-service (identity.home_region in JSON). See ADR-0047.
function Test-RoutedToRegion($name, $region, $curlResult) {
    $body = Get-Body $curlResult
    $status = Get-Status $curlResult
    if ($status -ne "200") {
        Test-Case $name "200" $curlResult
        return
    }
    $regionUpper = $region.ToUpper()
    $regionLower = $region.ToLower()
    $echoPat = "(?i)${regionLower}-backend|api-${regionLower}"
    $identityPat = "(?i)home_region`":`"$regionUpper`""
    if ($body -match $echoPat -or $body -match $identityPat) {
        Write-Host "  PASS: $name" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host "  FAIL: $name" -ForegroundColor Red
        Write-Host "        expected upstream or home_region=$regionUpper" -ForegroundColor DarkRed
        Write-Host "        got:            $curlResult" -ForegroundColor DarkRed
        $script:FAIL++
    }
}

$EU = New-Jwt "user-eu-123" "EU"
$US = New-Jwt "user-us-456" "US"
$AP = New-Jwt "user-ap-789" "AP"

Write-Host "=== 1. Health & Readiness ===" -ForegroundColor Cyan
Test-Case "Gateway /health"       "healthy" (Curl-Get "$GW/health")
Test-Case "Gateway /ready"        "ready"   (Curl-Get "$GW/ready")
Test-Case "Control plane /health" "healthy" (Curl-Get "$CP/health")

Write-Host ""
Write-Host "=== 2. Authentication ===" -ForegroundColor Cyan
Test-Case "No token -> 401"        "^401" (Curl-Get "$GW/api/v1/orders")
Test-Case "Garbage token -> 401"   "^401" (Curl-Get "$GW/api/v1/orders" "Bearer invalid.bad.token")
Test-Case "Valid EU token -> 200"  "^200" (Curl-Get "$GW/api/v1/orders" $EU)

Write-Host ""
Write-Host "=== 3. Identity-Based Routing (Data Residency) ===" -ForegroundColor Cyan
Test-RoutedToRegion "EU user -> eu upstream" "EU" (Curl-Get "$GW/" $EU)
Test-RoutedToRegion "US user -> us upstream" "US" (Curl-Get "$GW/" $US)
Test-RoutedToRegion "AP user -> ap upstream" "AP" (Curl-Get "$GW/" $AP)
Test-Case "X-User-Id forwarded"        "user-eu-123" (Curl-Get "$GW/" $EU)
Test-Case "X-Home-Region forwarded"    "(?i)x-home-region.*EU|home.region.*EU" (Curl-Get "$GW/" $EU)
$ALICE = New-Jwt "alice" "EU"
Test-Case "Spoofed X-User-Id ignored"  "alice" (Curl-Get "$GW/" $ALICE @() @("X-User-Id: attacker"))

Write-Host ""
Write-Host "=== 4. WAF Inspection ===" -ForegroundColor Cyan
Test-Case "Path traversal -> 403"      "^403" (Curl-Get "$GW/etc/passwd?x=../../secret")
Test-Case "SQLi in query -> 403"       "^403" (Curl-Get "$GW/api/v1/x?q=1'%20or%20'1'='1" $EU)
Test-Case "Scanner UA (sqlmap) -> 403" "^403" (Curl-Get "$GW/" $EU "sqlmap/1.7.2")
Test-Case "Scanner UA (nikto) -> 403"  "^403" (Curl-Get "$GW/" $EU "nikto/2.1.6")
Test-Case "Double-encoded XSS -> 403"  "^403" (Curl-Get "$GW/api/v1/x?q=%253Cscript%253E" $EU)
Test-Case "Double-encoded traversal -> 403" "^403" (Curl-Get "$GW/api/v1/x?p=%252e%252e%252fetc%252fpasswd" $EU)
Test-Case "XSS in POST body -> 403" "^403" (Curl-Post "$GW/api/v1/orders" '{"x":"<script>alert(1)</script>"}' $EU)

Write-Host ""
Write-Host "=== 4b. Security Headers (ADR-0025, more_set_headers) ===" -ForegroundColor Cyan
# Regression: add_header at server level was dropped in location / because that
# block adds X-Cache-Status. Proxied responses must still carry security headers.
$hdrs = Curl-GetHeaders "$GW/public/status"
Test-Case "X-Frame-Options: DENY on proxied route" "(?i)x-frame-options:\s*deny" $hdrs
Test-Case "X-Content-Type-Options on proxied route" "(?i)x-content-type-options:\s*nosniff" $hdrs
Test-Case "CSP on proxied route" "(?i)content-security-policy:" $hdrs

Write-Host ""
Write-Host "=== 5. Public (no-auth) Service ===" -ForegroundColor Cyan
Test-Case "Public route w/o token -> 200" "^200" (Curl-Get "$GW/public/status")

Write-Host ""
Write-Host "=== 6. Config Management ===" -ForegroundColor Cyan
$cfgHdrs = Get-ConfigReadHeaders
$cfg = Curl-Get "$CP/config" "" "" $cfgHdrs
Test-Case "Config has a version"        "version" $cfg
Test-Case "Config exposes services"     "services" $cfg
Test-Case "JWT secret NOT exposed"      "^(?!.*jwt_secret).*$" $cfg
$cfgNoTok = Curl-Get "$CP/config"
if ($cfgNoTok -match '^401') {
    Test-Case "GET /config without token rejected when protected" "^401" $cfgNoTok
} else {
    Test-Case "GET /config open when CONFIG_READ_TOKEN unset" "version" $cfgNoTok
}

Write-Host ""
Write-Host "=== 7. Config Push + Rollback ===" -ForegroundColor Cyan
# Version-agnostic: read live version, push a unique test version, rollback restores it.
$cfgBefore = Get-Body (Curl-Get "$CP/config" "" "" $cfgHdrs)
$baseVersion = if ($cfgBefore -match '"version"\s*:\s*"([^"]+)"') { $Matches[1] } else { "v1.0.0" }
$testVersion = "v2.0.0-e2e-$(Get-Date -Format 'yyyyMMddHHmmss')"
$snapshotPath = Join-Path $PSScriptRoot "../gateway-control-plane/conf.d/initial-snapshot.json"
$v2 = (Get-Content -Raw $snapshotPath) -replace '"version"\s*:\s*"[^"]+"', "`"version`":`"$testVersion`""
$push = Curl-Post "$CP/config" $v2
Test-Case "Push v2 accepted"            "200.*$([regex]::Escape($testVersion))" $push
Test-Case "History lists versions"      "$([regex]::Escape($testVersion))"      (Curl-Get "$CP/config/history" "" "" $cfgHdrs)
$rb = Curl-Post "$CP/config/rollback"
Test-Case "Rollback succeeds"           "version"            $rb
Test-Case "Active config back to base"  "$([regex]::Escape($baseVersion))"           (Curl-Get "$CP/config" "" "" $cfgHdrs)

Write-Host ""
Write-Host "=== 8. Telemetry Ingestion ===" -ForegroundColor Cyan
$tel = '{"requests_total":999,"requests_401":10,"requests_429":5,"requests_500":2,"latency_us_sum":500000,"in_flight":3,"waf_blocks":7,"cache_hits":100,"cache_misses":20}'
Test-Case "Telemetry POST accepted"     "200.*ok" (Curl-Post "$CP/telemetry" $tel)

Write-Host ""
Write-Host "=== 9. Prometheus Metrics ===" -ForegroundColor Cyan
Test-Case "Control-plane /metrics"      "control_plane_up 1" (Curl-Get "$CP/metrics")
Test-Case "Gateway config_ready metric"   "gateway_config_ready 1" (Curl-Get "$GW/metrics")

Write-Host ""
Write-Host "=== 10. Token Revocation (ADR-0038) ===" -ForegroundColor Cyan
$revJti = "e2e-revoke-jti-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$tokJti = New-Jwt "revoked-jti-user" "EU" $revJti
$revBody = "{`"jti`":`"$revJti`",`"ttl_secs`":120}"
Test-Case "Revoke by jti accepted"      "200.*revoked" (Curl-Post "$CP/revoke" $revBody)
Test-Case "Revoked jti token -> 401"    "^401" (Curl-Get "$GW/api/v1/orders" $tokJti)

$tokRaw = New-Jwt "revoked-hash-user" "EU"
$raw = Get-RawToken $tokRaw
$hashBody = "{`"token`":`"$raw`",`"ttl_secs`":120}"
Test-Case "Revoke by token hash accepted" "200.*revoked" (Curl-Post "$CP/revoke" $hashBody)
Test-Case "Revoked token hash -> 401"   "^401" (Curl-Get "$GW/api/v1/orders" $tokRaw)
Test-Case "Unrelated token still valid" "^200" (Curl-Get "$GW/api/v1/orders" $EU)

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
$total = $PASS + $FAIL
$color = if ($FAIL -eq 0) { "Green" } else { "Yellow" }
Write-Host "  Passed: $PASS / $total" -ForegroundColor $color
if ($FAIL -gt 0) { Write-Host "  Failed: $FAIL" -ForegroundColor Red; exit 1 }
