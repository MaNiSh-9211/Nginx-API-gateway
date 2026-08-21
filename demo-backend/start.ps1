# Start demo-backend (compose service: backend-test-service) and dependencies.
set -euo pipefail
$libDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$composeLibDir = "$libDir\..\scripts"
$repoRoot = (Get-Item "$composeLibDir\..").FullName
$devDir = "$repoRoot\dev"

Write-Host "Starting demo-backend (backend-test-service)..."
# Load dev environment
if (-not (Test-Path "$devDir\.env")) {
    if (Test-Path "$devDir\.env.example") {
        Copy-Item "$devDir\.env.example" "$devDir\.env" -Force
        Write-Host "Created dev/.env from dev/.env.example"
    }
}
# Source the bash helper if available; otherwise manually set env
. "$composeLibDir\compose-common.sh" 2>$null || Write-Warning "compose-common.sh not found, proceeding manually"

Write-Host "Starting demo-backend (backend-test-service)..."
cd $devDir
docker compose -f docker-compose.yml -f docker-compose.testing.yml up -d --build backend-test-service
Write-Host "Sample API upstream registered on gateway internal aliases."