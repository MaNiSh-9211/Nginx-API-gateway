# Publish each deployable service folder to its own GitHub repo (open-source safe).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

$Gitignore = @"
# Real credentials — NEVER commit. Copy .env.example → .env.dev locally.
.env.dev
.env.local

# Node.js
node_modules/
dist/
dist-ssr/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Rust
target/
**/target/
**/*.rs.bk

# Logs & temp debug artifacts
*.log
logs/
curl_output.txt
pid_check.txt

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp

# Dev runtime data (demo-backend)
data/users.json
"@

$Repos = [ordered]@{
    "gateway-edge"          = "https://github.com/MaNiSh-9211/gateway-edge.git"
    "gateway-control-plane" = "https://github.com/MaNiSh-9211/gateway-control-plane.git"
    "gateway-sidecar"       = "https://github.com/MaNiSh-9211/gateway-sidecar.git"
    "uam-backend"           = "https://github.com/MaNiSh-9211/uam-backend.git"
    "uam-frontend"          = "https://github.com/MaNiSh-9211/uam-frontend.git"
    "demo-backend"          = "https://github.com/MaNiSh-9211/demo-backend.git"
    "demo-frontend"         = "https://github.com/MaNiSh-9211/demo-frontend.git"
}

$SecretPatterns = @(
    'mongodb\+srv://[^"\s]+',
    'GOCSPX-[A-Za-z0-9_-]+',
    '862014520901-',
    'YNli62V5lGIPz21B'
)

function Test-NoSecrets([string[]]$Files) {
    foreach ($f in $Files) {
        if (-not (Test-Path $f)) { continue }
        if ($f -match '\.env\.example$') { continue }
        $content = Get-Content $f -Raw -ErrorAction SilentlyContinue
        if (-not $content) { continue }
        foreach ($pat in $SecretPatterns) {
            if ($content -match $pat) {
                throw "SECRET DETECTED in staged file '$f' (pattern: $pat). Aborting."
            }
        }
    }
}

foreach ($name in $Repos.Keys) {
    $dir = Join-Path $Root $name
    $url = $Repos[$name]
    Write-Host "`n========== $name ==========" -ForegroundColor Cyan

    if (-not (Test-Path $dir)) {
        throw "Missing folder: $dir"
    }

    Set-Location $dir
    Set-Content -Path ".gitignore" -Value $Gitignore -Encoding UTF8

    if (Test-Path ".git") {
        Remove-Item -Recurse -Force ".git"
    }

    git init -q
    git config user.email "publish@local"
    git config user.name "MaNiSh-9211"
    git add -A

    $staged = git diff --cached --name-only
    if (-not $staged) {
        throw "Nothing staged for $name"
    }

    $blocked = @(".env.dev", "node_modules", "\target\", "dist\", "curl_output.txt", "pid_check.txt")
    foreach ($s in $staged) {
        foreach ($b in $blocked) {
            if ($s -like "*$b*") {
                throw "Blocked path staged in ${name}: $s"
            }
        }
    }

    $stagedPaths = $staged | ForEach-Object { Join-Path $dir $_ }
    Test-NoSecrets -Files $stagedPaths

    Write-Host "Staged files ($($staged.Count)):"
    $staged | ForEach-Object { Write-Host "  $_" }

    git commit -q -m "Initial open-source release

Safe defaults in .env and .env.example only.
Real credentials belong in .env.dev (gitignored)."

    git branch -M main
    $remotes = git remote 2>$null
    if ($remotes -contains 'origin') {
        git remote remove origin
    }
    git remote add origin $url
    git push -u origin main

    Write-Host "Pushed $name -> $url" -ForegroundColor Green
}

Write-Host "`nAll repos published." -ForegroundColor Green
