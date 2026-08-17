#!/usr/bin/env pwsh
# ============================================================
# breaker-outage-loadtest.ps1 - Redis circuit-breaker load test
# under a REAL Redis outage (no external infra required).
#
# Brings up a self-contained stack (uam-backend + redis + postgres,
# see dev/docker-compose.outage.yml), then:
#
#   1. BASELINE  - k6 hammers /ready while Redis is healthy. This is the
#                  breaker-overhead number (p99 of breaker-protected calls).
#   2. OUTAGE    - `docker compose pause redis` mid-traffic. Asserts:
#                     * the breaker reports OPEN (uam_redis_circuit_state=1)
#                     * traffic is REJECTED FAST (503s, p99 still bounded)
#                     * the circuit actually tripped (circuit_open_total++)
#   3. RECOVERY  - `docker compose unpause redis`. Asserts the breaker
#                  returns to CLOSED and /ready serves 200s again.
#
# Usage:
#   ./scripts/breaker-outage-loadtest.ps1           # full run, ~3 min
#   ./scripts/breaker-outage-loadtest.ps1 -Vus 100  # heavier load
#   ./scripts/breaker-outage-loadtest.ps1 -KeepUp   # leave stack running
#
# Requires: Docker Desktop / docker engine + compose v2 (k6 runs in Docker).
# ============================================================

param(
    [switch]$KeepUp,
    [int]$Vus = 50,
    [string]$PhaseSeconds = "25,35,25",   # baseline, outage, recovery
    [string]$UamUrl = "http://127.0.0.1:18080",
    [string]$K6Url = "http://host.docker.internal:18080",
    [string]$ComposeFile = "docker-compose.outage.yml"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# -- Paths ----------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$DevDir     = Split-Path -Parent $ScriptDir
$RepoRoot   = Split-Path -Parent $DevDir
$Compose    = Join-Path $DevDir $ComposeFile
$TestsDir   = Join-Path $DevDir "tests"
$OutDir     = Join-Path $env:TEMP "gateway-outage"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Time       = [System.Diagnostics.Stopwatch]::StartNew()

$PASS = 0; $FAIL = 0
function Assert-Test($name, $condition) {
    if ($condition) {
        Write-Host "  PASS: $name" -ForegroundColor Green
        $script:PASS++
    } else {
        Write-Host "  FAIL: $name" -ForegroundColor Red
        $script:FAIL++
    }
}

# -- Helpers --------------------------------------------------------------------
function Get-HttpCode($url, $retries = 3, $delaySec = 2) {
    for ($i = 0; $i -lt $retries; $i++) {
        $out = curl.exe -s -o NUL -w "%{http_code}" --max-time 5 $url 2>$null
        if ($out -match '^\d{3}$') { return [int]$out }
        Start-Sleep -Seconds $delaySec
    }
    return 0
}

function Get-MetricValue($metric) {
    $body = curl.exe -s --max-time 5 "$UamUrl/metrics" 2>$null
    foreach ($line in $body) {
        if ($line -like "$metric*") { return ($line -split '\s+')[-1].Trim() }
    }
    return $null
}

function Wait-ForReady($timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ((Get-HttpCode "$UamUrl/ready" 1 1) -eq 200) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Invoke-K6Phase($phase) {
    $export = Join-Path $OutDir "summary-$phase.json"
    $dockerArgs = @(
        "run", "--rm",
        "-v", "${TestsDir}:/scripts:ro",
        "-v", "${OutDir}:/out",
        "-e", "UAM_URL=$K6Url",
        "-e", "PHASE=$phase",
        "grafana/k6:latest",
        "run",
        "--summary-export=/out/summary-$phase.json",
        "/scripts/load_breaker_outage.js"
    )
    Write-Host "`n  [k6] $phase phase ($Vus VUs) -> $K6Url" -ForegroundColor Cyan
    & docker $dockerArgs | ForEach-Object { "    $_" }
    $code = $LASTEXITCODE
    $p99 = $null; $failedRate = $null
    if (Test-Path $export) {
        $summary = Get-Content $export -Raw | ConvertFrom-Json
        $p99 = [math]::Round($summary.metrics.http_req_duration.values.'p(99)', 1)
        $failedRate = [math]::Round($summary.metrics.http_req_failed.values.rate, 4)
    }
    return [pscustomobject]@{ Code = $code; P99Ms = $p99; FailedRate = $failedRate }
}

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Redis circuit-breaker outage load test" -ForegroundColor Cyan
Write-Host "  stack: dev/$ComposeFile   uam: $UamUrl   VUs: $Vus" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# -- Bring up the stack ---------------------------------------------------------
Write-Host "`n== Bring up outage stack (first build can take minutes) ==" -ForegroundColor Yellow
docker compose -f $Compose -p gateway-outage up -d --build | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Write-Host "compose up failed" -ForegroundColor Red; exit 1 }

$booted = Wait-ForReady 300
Assert-Test "uam-backend /ready = 200 before chaos" $booted
if (-not $booted) {
    Write-Host "  Stack never became ready - check logs:" -ForegroundColor Red
    docker compose -f $Compose -p gateway-outage logs --tail 50 uam-backend | ForEach-Object { "    $_" }
    exit 1
}

# -- 1. Baseline (breaker overhead on healthy Redis) ----------------------------
$phases = $PhaseSeconds.Split(',').Trim()
Write-Host "`n== Phase 1/3: BASELINE (healthy Redis) ==" -ForegroundColor Yellow
$base = Invoke-K6Phase "baseline"
Assert-Test "k6 baseline thresholds met (exit 0)" ($base.Code -eq 0)
if ($null -ne $base.P99Ms) {
    Assert-Test "baseline p99 < 1500ms" ($base.P99Ms -lt 1500)
    Write-Host "  BREAKER OVERHEAD (baseline /ready p99): $($base.P99Ms)ms" -ForegroundColor Green
}
Write-Host "  baseline failed-rate: $($base.FailedRate)"

# -- 2. Outage: pause Redis, assert breaker OPENs and rejects fast --------------
Write-Host "`n== Phase 2/3: OUTAGE (pausing redis) ==" -ForegroundColor Yellow
docker compose -f $Compose -p gateway-outage pause redis | ForEach-Object { "  $_" }
Start-Sleep -Seconds 2

$openObserved = $false
$halfOpenObserved = $false
$circuitOpenBefore = [double](Get-MetricValue "uam_redis_circuit_open_total")
$sampler = Start-Job -ArgumentList $UamUrl -ScriptBlock {
    param($url)
    $states = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt 180; $i++) {
        $body = curl.exe -s --max-time 5 "$url/metrics" 2>$null
        foreach ($line in $body) {
            if ($line -like "uam_redis_circuit_state*") { $states.Add(($line -split '\s+')[-1].Trim()); break }
        }
        Start-Sleep -Milliseconds 500
    }
    $states -join ','
}
$t0 = Get-Date
$outage = Invoke-K6Phase "outage"
$openAfterSec = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
$states = (Receive-Job $sampler -Wait) -split ','
Remove-Job $sampler -Force
$openObserved = $states -contains '1'
$halfOpenObserved = $states -contains '2'
$circuitOpenAfter = [double](Get-MetricValue "uam_redis_circuit_open_total")

Assert-Test "breaker reported OPEN (state=1) during outage" $openObserved
Assert-Test "breaker tripped for real (circuit_open_total increased)" ($circuitOpenAfter -gt $circuitOpenBefore)
Assert-Test "k6 outage thresholds met (exit 0 = fast reject + bounded p99)" ($outage.Code -eq 0)
if ($null -ne $outage.P99Ms) {
    Assert-Test "outage p99 < 1500ms (no hangs)" ($outage.P99Ms -lt 1500)
}
Write-Host "  outage failed-rate: $($outage.FailedRate)  (breaker rejected traffic: 503s)"
Write-Host "  state samples seen: $((($states | Where-Object { $_ }) -join ','))"

docker compose -f $Compose -p gateway-outage unpause redis | ForEach-Object { "  $_" }

# -- 3. Recovery: breaker returns to CLOSED, traffic flows again ----------------
Write-Host "`n== Phase 3/3: RECOVERY (redis restored) ==" -ForegroundColor Yellow
$recStart = Get-Date
$recovered = Wait-ForReady 120
$recoverAfterSec = [math]::Round(((Get-Date) - $recStart).TotalSeconds, 1)
$closedObserved = $false
for ($i = 0; $i -lt 40; $i++) {
    $s = Get-MetricValue "uam_redis_circuit_state"
    if ($s -eq '0') { $closedObserved = $true; break }
    Start-Sleep -Milliseconds 500
}
Assert-Test "/ready = 200 after Redis restored" $recovered
Assert-Test "breaker returned to CLOSED (state=0)" $closedObserved

$rec = Invoke-K6Phase "recovery"
Assert-Test "k6 recovery thresholds met (exit 0)" ($rec.Code -eq 0)
Write-Host "  recovery failed-rate: $($rec.FailedRate)"
Write-Host "  recovery latency: /ready 200 in ${recoverAfterSec}s after unpause" -ForegroundColor Green

# -- Summary --------------------------------------------------------------------
$total = $PASS + $FAIL
Write-Host "`n============================================================" -ForegroundColor Cyan
Write-Host "  RESULTS" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  baseline p99:        $($base.P99Ms)ms  (breaker overhead on /ready)"
Write-Host "  outage p99:          $($outage.P99Ms)ms  (must stay bounded - no hangs)"
Write-Host "  outage reject rate:  $($outage.FailedRate)"
Write-Host "  breaker OPEN after:  ${openAfterSec}s of Redis pause"
Write-Host "  breaker CLOSED after:${recoverAfterSec}s of Redis restore"
Write-Host "  elapsed: $([math]::Round($Time.Elapsed.TotalMinutes, 1)) min"
Write-Host "  Passed: $PASS / $total" -ForegroundColor $(if ($FAIL -eq 0) { "Green" } else { "Red" })

if (-not $KeepUp) {
    Write-Host "`n== Tearing down outage stack ==" -ForegroundColor Yellow
    docker compose -f $Compose -p gateway-outage down | ForEach-Object { "  $_" }
} else {
    Write-Host "`n(-KeepUp) stack left running. Tear down with:" -ForegroundColor Yellow
    Write-Host "  docker compose -f dev/$ComposeFile down"
}

if ($FAIL -gt 0) { exit 1 }
exit 0