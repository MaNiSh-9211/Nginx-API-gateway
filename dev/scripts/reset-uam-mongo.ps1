# Reset UAM MongoDB volume (required once when enabling Mongo auth on an existing dev volume).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

Write-Host "Stopping UAM stack..." -ForegroundColor Yellow
docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml down 2>&1 | Out-Null

$vol = docker volume ls -q --filter name=uam-mongodb-data 2>$null
if ($vol) {
    Write-Host "Removing volume $vol" -ForegroundColor Yellow
    docker volume rm $vol 2>&1
}

Write-Host "Starting UAM stack..." -ForegroundColor Green
docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml up -d --build mongodb uam-backend uam-frontend gateway 2>&1

Write-Host "Done. Run: powershell -File scripts/test-uam.ps1" -ForegroundColor Cyan
