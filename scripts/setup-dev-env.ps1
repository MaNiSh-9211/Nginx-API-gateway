# Bootstrap .env.dev from .env.example (gitignored secrets file).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

function Copy-IfMissing($Dir) {
    $example = Join-Path $Dir ".env.example"
    $dev = Join-Path $Dir ".env.dev"
    if (Test-Path $dev) {
        Write-Host "  skip $dev (exists)"
        return
    }
    if (-not (Test-Path $example)) { return }
    Copy-Item $example $dev
    Write-Host "  created $dev from .env.example — edit with real credentials"
}

Write-Host "=== Bootstrap .env.dev (secrets, gitignored) ==="
Copy-IfMissing (Join-Path $Root "dev")
@(
    "gateway-edge", "gateway-control-plane", "gateway-sidecar", "gateway-redis",
    "uam-backend", "uam-frontend", "demo-backend", "demo-frontend"
) | ForEach-Object { Copy-IfMissing (Join-Path $Root $_) }

Write-Host ""
Write-Host "Edit dev/.env.dev with MONGODB_URI (Atlas) and any OAuth/SMTP secrets."
Write-Host "Safe defaults in committed .env files are used when .env.dev keys are unset."
