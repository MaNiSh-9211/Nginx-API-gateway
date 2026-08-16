#!/usr/bin/env pwsh
# Run k6 load tests via Docker (no local k6 install required).
#
#   ./scripts/load-test.ps1          # full load (500 VUs, ~2 min)
#   ./scripts/load-test.ps1 -Smoke # smoke load (50 VUs, ~30 s)

param(
    [switch]$Smoke,
    [string]$GatewayUrl = $(if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { "http://host.docker.internal:18083" }),
    [string]$JwtSecret = $(if ($env:JWT_SECRET) { $env:JWT_SECRET } else { "super_secret_key_for_hmac_sha256_change_in_prod" })
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Script = if ($Smoke) { "load_smoke.js" } else { "load_testing.js" }
$Label = if ($Smoke) { "smoke" } else { "full" }

Write-Host "k6 $Label load test -> $GatewayUrl" -ForegroundColor Cyan

docker run --rm `
    -v "${RepoRoot}/tests:/scripts:ro" `
    -e "GATEWAY_URL=$GatewayUrl" `
    -e "JWT_SECRET=$JwtSecret" `
    grafana/k6:latest run "/scripts/$Script"

if ($LASTEXITCODE -ne 0) {
    Write-Host "k6 load test FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "k6 $Label load test PASSED" -ForegroundColor Green
