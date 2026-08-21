# Start uam-backend and dependencies (Postgres, Redis, gateway base).
set -euo pipefail
$libDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$composeLibDir = "$libDir\..\scripts"
$repoRoot = (Get-Item "$composeLibDir\..").FullName
$devDir = "$repoRoot\dev"

Write-Host "Starting uam-backend..."
if (-not (Test-Path "$devDir\.env")) {
    if (Test-Path "$devDir\.env.example") {
        Copy-Item "$devDir\.env.example" "$devDir\.env" -Force
        Write-Host "Created dev/.env from dev/.env.example"
    }
}

. "$composeLibDir\compose-common.sh" 2>$null || Write-Warning "compose-common.sh not found, proceeding manually"

Write-Host "Starting uam-backend..."
cd $devDir
docker compose -f docker-compose.yml -f docker-compose.uam.yml up -d --build uam-backend
Write-Host "UAM backend healthy on internal network (via gateway /api/auth)."