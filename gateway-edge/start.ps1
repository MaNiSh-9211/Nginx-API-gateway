# Start gateway-edge and dependencies.
set -euo pipefail
$libDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$composeLibDir = "$libDir\..\scripts"
$repoRoot = (Get-Item "$composeLibDir\..").FullName
$devDir = "$repoRoot\dev"

Write-Host "Starting gateway-edge (gateway)..."
if (-not (Test-Path "$devDir\.env")) {
    if (Test-Path "$devDir\.env.example") {
        Copy-Item "$devDir\.env.example" "$devDir\.env" -Force
        Write-Host "Created dev/.env from dev/.env.example"
    }
}

. "$composeLibDir\compose-common.sh" 2>$null || Write-Warning "compose-common.sh not found, proceeding manually"

Write-Host "Starting gateway-edge (gateway)..."
cd $devDir
docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml up -d --build gateway
Write-Host "Gateway: http://localhost:${env:GATEWAY_PORT:-18083}"