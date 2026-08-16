#!/usr/bin/env pwsh
# ============================================================
# Chaos tests — degrade Redis, kill upstreams, restart the node,
# and assert the gateway fails gracefully (stays up / fails fast).
#
#   docker compose up -d --build
#   ./tests/chaos_test.ps1
# ============================================================

$GW = $env:GATEWAY_URL; if (-not $GW) { $GW = "http://localhost:18083" }
$PASS = 0; $FAIL = 0

function Get-HttpCode($url, $retries = 5, $delaySec = 2) {
    for ($i = 0; $i -lt $retries; $i++) {
        $out = curl.exe -s -o NUL -w "%{http_code}" --max-time 5 $url 2>$null
        if ($out -match '^\d{3}$') { return [int]$out }
        Start-Sleep -Seconds $delaySec
    }
    return 0
}

function Assert-Test($name, $condition) {
    if ($condition) {
        Write-Host "  PASS: $name" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host "  FAIL: $name" -ForegroundColor Red
        $script:FAIL++
    }
}

Write-Host "Chaos Engineering Tests" -ForegroundColor Cyan
Write-Host "Gateway: $GW`n"

# Pre-flight
Assert-Test "Gateway healthy before chaos" ((Get-HttpCode "$GW/health") -eq 200)

# 1. Redis partition — revocation degrades fail-open; gateway stays up (ADR-0022).
Write-Host "`n=== 1. Redis partition ===" -ForegroundColor Yellow
docker compose pause redis 2>$null | Out-Null
Start-Sleep -Seconds 3
Assert-Test "Gateway /health during Redis pause" ((Get-HttpCode "$GW/health") -eq 200)
Assert-Test "Gateway /ready during Redis pause"  ((Get-HttpCode "$GW/ready") -eq 200)
docker compose unpause redis 2>$null | Out-Null
Start-Sleep -Seconds 2

# 2. Upstream crash — circuit breaker should absorb failures (ADR-0008).
Write-Host "`n=== 2. Upstream crash ===" -ForegroundColor Yellow
docker compose stop echo-backend 2>$null | Out-Null
Start-Sleep -Seconds 2
Assert-Test "Gateway stays up when upstream is down" ((Get-HttpCode "$GW/health") -eq 200)
# Hammer to trip circuit breaker; expect 502/503/504 from proxy, not gateway crash.
for ($i = 0; $i -lt 20; $i++) {
    curl.exe -s -o NUL --max-time 3 "$GW/public/status" 2>$null | Out-Null
}
Assert-Test "Gateway still healthy after upstream errors" ((Get-HttpCode "$GW/health") -eq 200)
docker compose start echo-backend 2>$null | Out-Null
Start-Sleep -Seconds 5

# 3. Gateway restart — liveness recovers (ADR-0024).
Write-Host "`n=== 3. Gateway restart ===" -ForegroundColor Yellow
docker compose restart gateway 2>$null | Out-Null
$recovered = $false
for ($i = 0; $i -lt 20; $i++) {
    if ((Get-HttpCode "$GW/health" 1 1) -eq 200) {
        $recovered = $true
        break
    }
    Start-Sleep -Seconds 2
}
Assert-Test "Gateway /health recovers after restart" $recovered
if ($recovered) {
    $ready = $false
    for ($i = 0; $i -lt 15; $i++) {
        if ((Get-HttpCode "$GW/ready" 1 1) -eq 200) {
            $ready = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    Assert-Test "Gateway /ready after config reload" $ready
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$total = $PASS + $FAIL
$color = if ($FAIL -eq 0) { "Green" } else { "Red" }
Write-Host "  Passed: $PASS / $total" -ForegroundColor $color
if ($FAIL -gt 0) { exit 1 }
