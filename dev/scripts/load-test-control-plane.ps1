#!/usr/bin/env pwsh
# Run k6 load test against the control plane via Docker (no local k6 install).
#
#   ./scripts/load-test-control-plane.ps1
#   ./scripts/load-test-control-plane.ps1 -ControlPlaneUrl http://host.docker.internal:18085

param(
    [string]$ControlPlaneUrl = $(if ($env:CONTROL_PLANE_URL) { $env:CONTROL_PLANE_URL } else { "http://host.docker.internal:18085" }),
    [string]$ConfigReadToken = $(if ($env:CONFIG_READ_TOKEN) { $env:CONFIG_READ_TOKEN } else { "uam_dev_config_read_token_change_me" })
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "k6 control-plane load test -> $ControlPlaneUrl" -ForegroundColor Cyan

docker run --rm `
    -v "${RepoRoot}/tests:/scripts:ro" `
    -e "CONTROL_PLANE_URL=$ControlPlaneUrl" `
    -e "CONFIG_READ_TOKEN=$ConfigReadToken" `
    grafana/k6:latest run "/scripts/load_control_plane.js"

if ($LASTEXITCODE -ne 0) {
    Write-Host "k6 control-plane load test FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host "k6 control-plane load test PASSED" -ForegroundColor Green