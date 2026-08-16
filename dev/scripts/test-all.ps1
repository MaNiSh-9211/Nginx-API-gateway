# Run full local test suite — gateway E2E + UAM integration
# Requires stack: docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml up

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "`n=== Full test suite ===" -ForegroundColor Cyan

& (Join-Path $PSScriptRoot "..\test.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& (Join-Path $PSScriptRoot "test-uam.ps1")
exit $LASTEXITCODE
