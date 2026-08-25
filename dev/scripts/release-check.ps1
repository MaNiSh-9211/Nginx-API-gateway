#!/usr/bin/env pwsh
# Pre-release validation - runs the standard gate before tagging.
# Usage: ./scripts/release-check.ps1 [-SkipE2E]

param([switch]$SkipE2E)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent (Split-Path -Parent $ScriptDir)
Set-Location $Root

$fail = 0

function Step($name, [scriptblock]$action) {
    Write-Host ""
    Write-Host ">> $name" -ForegroundColor Cyan
    try {
        & $action
        if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "exit $LASTEXITCODE" }
        Write-Host "   OK" -ForegroundColor Green
    } catch {
        Write-Host "   FAIL: $_" -ForegroundColor Red
        $script:fail++
    }
}

Write-Host "Release gate - routiq" -ForegroundColor Yellow

Step "gateway-edge rust-ext unit tests" { Push-Location (Join-Path $Root "gateway-edge/rust-ext"); cargo test --release -q; Pop-Location }
Step "gateway-control-plane unit tests" { Push-Location (Join-Path $Root "gateway-control-plane"); cargo test --release -q; Pop-Location }
Step "gateway-sidecar unit tests" { Push-Location (Join-Path $Root "gateway-sidecar"); cargo test --release -q; Pop-Location }
Step "docker compose validate"     { Push-Location (Join-Path $Root "dev"); docker compose -f docker-compose.yml config --quiet; Pop-Location }
Step "multi-region compose validate" { Push-Location (Join-Path $Root "dev"); docker compose -f docker-compose.multi-region.yml config --quiet; Pop-Location }
Step "helm template lint" {
    $helmArgs = @(
        'template', 'api-gateway', 'platform/deploy/helm/api-gateway',
        '--set', 'secrets.jwtSecret=test',
        '--set', 'secrets.adminApiKey=test'
    )
    if (Get-Command helm -ErrorAction SilentlyContinue) {
        & helm @helmArgs | Out-Null
    } else {
        Write-Host "   (helm not on PATH; using alpine/helm container)" -ForegroundColor DarkGray
        $mount = if ($IsWindows -or $env:OS -match 'Windows') { $Root } else { $Root }
        docker run --rm -v "${mount}:/work" -w /work alpine/helm:3.14.4 @helmArgs | Out-Null
    }
}

Step "docker compose validate (UAM stack)" {
    Push-Location (Join-Path $Root "dev")
    docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml config --quiet
    Pop-Location
}

if (-not $SkipE2E) {
    $e2e = Join-Path $Root 'dev/test.ps1'
    Step 'E2E suite (dev/test.ps1)' { Push-Location (Join-Path $Root 'dev'); & $e2e | Out-Null; Pop-Location }
}

Write-Host ""
$totalChecks = if (-not $SkipE2E) { 8 } else { 7 }
if ($fail -eq 0) {
    Write-Host ('Release gate PASSED ({0} checks)' -f $totalChecks) -ForegroundColor Green
    exit 0
} else {
    Write-Host ('Release gate FAILED: {0} of {1} checks' -f $fail, $totalChecks) -ForegroundColor Red
    exit 1
}
