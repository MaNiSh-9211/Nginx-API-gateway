# Test MongoDB Atlas URIs from inside the uam-backend container (DNS works there).
# Usage:
#   1. Copy mongodb-uris.local.txt.example → mongodb-uris.local.txt
#   2. Add one URI per line (label|uri optional)
#   3. .\dev\scripts\test-mongodb-uris.ps1
#
# If no local file, tests MONGODB_URI from dev/.env only.

$ErrorActionPreference = "Stop"
$DevDir = Split-Path -Parent $PSScriptRoot
$LocalFile = Join-Path $DevDir "mongodb-uris.local.txt"
$Script = Join-Path $DevDir "scripts\test-mongodb-uris.mjs"
$EnvFile = Join-Path $DevDir ".env.dev"
if (-not (Test-Path $EnvFile)) { $EnvFile = Join-Path $DevDir ".env" }

Set-Location $DevDir

$mongoUri = (Select-String -Path $EnvFile -Pattern '^MONGODB_URI=' | Select-Object -First 1).Line -replace '^MONGODB_URI=', ''

$dockerArgs = @(
    "compose", "-f", "docker-compose.yml", "-f", "docker-compose.testing.yml", "-f", "docker-compose.uam.yml",
    "run", "--rm", "--no-deps",
    "-v", "${Script}:/app/test-mongodb-uris.mjs:ro",
    "-e", "MONGODB_URI=$mongoUri",
    "uam-backend", "node", "/app/test-mongodb-uris.mjs"
)

if (Test-Path $LocalFile) {
    $dockerArgs = @(
        "compose", "-f", "docker-compose.yml", "-f", "docker-compose.testing.yml", "-f", "docker-compose.uam.yml",
        "run", "--rm", "--no-deps",
        "-v", "${Script}:/app/test-mongodb-uris.mjs:ro",
        "-v", "${LocalFile}:/app/uris.txt:ro",
        "uam-backend", "node", "/app/test-mongodb-uris.mjs", "/app/uris.txt"
    )
    Write-Host "Testing URIs from mongodb-uris.local.txt"
} else {
    Write-Host "Testing MONGODB_URI from dev/.env.dev (create mongodb-uris.local.txt to test multiple)"
}

docker @dockerArgs
