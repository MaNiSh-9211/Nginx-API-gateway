#!/usr/bin/env pwsh
# Run k6 load test against the UAM backend via Docker (no local k6 install).
#
#   ./scripts/load-test-uam.ps1
#   ./scripts/load-test-uam.ps1 -UamUrl http://host.docker.internal:18080

param(
    [string]$UamUrl = $(if ($env:UAM_URL) { $env:UAM_URL } else { "http://host.docker.internal:18080" })
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "k6 uam load test -> $UamUrl" -ForegroundColor Cyan

docker run --rm `
    -v "${RepoRoot}/tests:/scripts:ro" `
    -e "UAM_URL=$UamUrl" `
    grafana/k6:latest run "/scripts/load_uam.js"

if ($LASTEXITCODE -ne 0) {
    Write-Host "k6 uam load test FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "k6 uam load test PASSED" -ForegroundColor Green