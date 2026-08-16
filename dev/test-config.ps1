#!/usr/bin/env pwsh
# ============================================================
# Config push / rollback smoke test (control plane only).
# Uses the current ConfigSnapshot schema (services / routes /
# regional_upstreams) derived from the shipped initial snapshot.
# ============================================================

$CP = $env:CONTROL_PLANE_URL; if (-not $CP) { $CP = "http://localhost:18085" }
$snapshotPath = Join-Path $PSScriptRoot "../gateway-control-plane/conf.d/initial-snapshot.json"

Write-Host "=== CURRENT CONFIG ==="
curl.exe -s "$CP/config"

Write-Host "`n`n=== PUSH v2 CONFIG (bumped version, real schema) ==="
$v2 = (Get-Content -Raw $snapshotPath) -replace '"v1\.0\.0"', '"v2.0.0"'
$tmp = [System.IO.Path]::GetTempFileName()
Set-Content -Path $tmp -Value $v2 -Encoding ASCII
curl.exe -s -X POST "$CP/config" -H "Content-Type: application/json" --data-binary "@$tmp"
Remove-Item $tmp

Write-Host "`n`n=== HISTORY ==="
curl.exe -s "$CP/config/history"

Write-Host "`n`n=== ROLLBACK ==="
curl.exe -s -X POST "$CP/config/rollback"

Write-Host "`n`n=== CONFIG AFTER ROLLBACK (should be v1.0.0) ==="
curl.exe -s "$CP/config"
Write-Host ""
