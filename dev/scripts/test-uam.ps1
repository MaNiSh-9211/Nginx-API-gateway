# UAM integration E2E — register/login through gateway
# Requires stack (from dev/): docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml up

$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$GatewayUrl = if ($env:GATEWAY_URL) { $env:GATEWAY_URL } else { "http://localhost:18083" }
$UamFrontUrl = if ($env:UAM_FRONTEND_URL) { $env:UAM_FRONTEND_URL } else { "http://localhost:8091" }

$passed = 0
$failed = 0

function Assert-Test($name, $cond) {
    if ($cond) {
        Write-Host "[PASS] $name" -ForegroundColor Green
        $script:passed++
    } else {
        Write-Host "[FAIL] $name" -ForegroundColor Red
        $script:failed++
    }
}

function Get-CsrfFromSetCookie($setCookieRaw) {
    if ($setCookieRaw -match 'uam_csrf=([^;]+)') { return $Matches[1] }
    return $null
}

function New-UamWebSession {
    return New-Object Microsoft.PowerShell.Commands.WebRequestSession
}

function Invoke-UamAuthPost($uri, $bodyJson, $session, $csrf) {
    $headers = @{}
    if ($csrf) { $headers['X-CSRF-Token'] = $csrf }
    return Invoke-WebRequest -Uri $uri -Method POST -Body $bodyJson -ContentType "application/json" `
        -WebSession $session -Headers $headers -UseBasicParsing
}

function Invoke-UamCsrfBootstrap($session) {
    $resp = Invoke-WebRequest -Uri "$GatewayUrl/api/auth/csrf" -Method GET `
        -WebSession $session -UseBasicParsing
    return Get-CsrfFromSetCookie (($resp.Headers['Set-Cookie'] | ForEach-Object { $_ }) -join "`n")
}

Write-Host "`n=== UAM Gateway Integration Tests ===" -ForegroundColor Cyan

# Flush Redis-backed rate-limit keys from prior test runs.
try {
    $rlKeys = docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml exec -T redis redis-cli --scan --pattern "rl:*" 2>$null
    foreach ($k in ($rlKeys -split "`n" | Where-Object { $_ -match '\S' })) {
        docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml exec -T redis redis-cli DEL $k.Trim() | Out-Null
    }
} catch { }

# 1. UAM backend health via gateway
$gwHealth = try { (Invoke-WebRequest -Uri "$GatewayUrl/health" -UseBasicParsing).StatusCode } catch { 0 }
Assert-Test "Gateway health" ($gwHealth -eq 200)

# 2. UAM frontend serves SPA
$feStatus = try { (Invoke-WebRequest -Uri $UamFrontUrl -UseBasicParsing).StatusCode } catch { 0 }
Assert-Test "UAM frontend reachable" ($feStatus -eq 200)

# 2b. Public migration verify route (no auth guard)
$migrateVerifyStatus = try { (Invoke-WebRequest -Uri "$UamFrontUrl/migrate/verify" -UseBasicParsing).StatusCode } catch { 0 }
Assert-Test "Migration verify page is public" ($migrateVerifyStatus -eq 200)

# 2c. CSRF bootstrap endpoint
$csrfOnlySession = New-UamWebSession
$csrfOnly = Invoke-UamCsrfBootstrap $csrfOnlySession
Assert-Test "GET /api/auth/csrf returns uam_csrf token" ($null -ne $csrfOnly -and $csrfOnly.Length -gt 8)

# 2d. Email link redemption rejects invalid opaque code
$badRedeem = 0
try {
    $r = Invoke-WebRequest -Uri "$GatewayUrl/api/auth/redeem-email-link" -Method POST `
        -Body (@{ code = ('b' * 64) } | ConvertTo-Json) -ContentType "application/json" -UseBasicParsing
    $badRedeem = $r.StatusCode
} catch {
    if ($_.Exception.Response) { $badRedeem = [int]$_.Exception.Response.StatusCode }
}
Assert-Test "Redeem email link rejects invalid code (400)" ($badRedeem -eq 400)

# 2e. OAuth PKCE prepare returns state bound to challenge
$fakeChallenge = ('c' * 43)
$oauthPrep = try {
    Invoke-RestMethod -Uri "$GatewayUrl/api/auth/oauth/prepare" -Method POST `
        -Body (@{ codeChallenge = $fakeChallenge } | ConvertTo-Json) -ContentType "application/json"
} catch { $null }
Assert-Test "OAuth prepare returns state" ($null -ne $oauthPrep -and $oauthPrep.success -and $oauthPrep.state.Length -gt 16)

# 3. Register through gateway (cookie session — production browser path)
$email = "uam-test-$(Get-Random)@example.com"
$body = @{
    email = $email
    password = "SecurePass123!"
    displayName = "UAM Test User"
} | ConvertTo-Json

$session = New-UamWebSession
$csrf = Invoke-UamCsrfBootstrap $session
$reg = $null
$setCookieRaw = ""
try {
    $regResp = Invoke-UamAuthPost "$GatewayUrl/api/auth/register" $body $session $csrf
    $reg = $regResp.Content | ConvertFrom-Json
    $setCookieRaw = ($regResp.Headers['Set-Cookie'] | ForEach-Object { $_ }) -join "`n"
    $csrf = Get-CsrfFromSetCookie $setCookieRaw
} catch {
    Write-Host "Register error: $_" -ForegroundColor Yellow
}
Assert-Test "Register via gateway returns accessToken" ($null -ne $reg -and $reg.accessToken)
Assert-Test "Register sets uam_refresh HttpOnly cookie" ($setCookieRaw -match 'uam_refresh=' -and $setCookieRaw -match 'HttpOnly')
Assert-Test "Register sets uam_csrf cookie" ($setCookieRaw -match 'uam_csrf=')
Assert-Test "Register omits refreshToken in JSON (ADR-0055)" ($null -eq $reg.refreshToken)

# 3a. Duplicate verified registration rejected via identity index
$dupSession = New-UamWebSession
$dupCsrf = Invoke-UamCsrfBootstrap $dupSession
$dupStatus = 0
try {
    $r = Invoke-UamAuthPost "$GatewayUrl/api/auth/register" $body $dupSession $dupCsrf
    $dupStatus = $r.StatusCode
} catch {
    if ($_.Exception.Response) { $dupStatus = [int]$_.Exception.Response.StatusCode }
}
Assert-Test "Duplicate register rejected (400)" ($dupStatus -eq 400)

# 3b. Login flow (separate session)
$loginEmail = "uam-login-$(Get-Random)@example.com"
$regLoginSession = New-UamWebSession
$regLoginCsrf = Invoke-UamCsrfBootstrap $regLoginSession
$regLoginResp = Invoke-UamAuthPost "$GatewayUrl/api/auth/register" (@{
    email = $loginEmail; password = "SecurePass123!"; displayName = "Login Test"
} | ConvertTo-Json) $regLoginSession $regLoginCsrf
$regLogin = $regLoginResp.Content | ConvertFrom-Json
$loginSession = New-UamWebSession
$loginCsrf = Invoke-UamCsrfBootstrap $loginSession
$loginResp = $null
try {
    $loginResp = Invoke-UamAuthPost "$GatewayUrl/api/auth/login" (@{
        email = $loginEmail; password = "SecurePass123!"
    } | ConvertTo-Json) $loginSession $loginCsrf
} catch { }
$loginData = if ($loginResp) { $loginResp.Content | ConvertFrom-Json } else { $null }
Assert-Test "Login via gateway returns accessToken" ($null -ne $loginData -and $loginData.accessToken)
Assert-Test "Login sets HttpOnly refresh cookie" (
    $loginResp -and (($loginResp.Headers['Set-Cookie'] | ForEach-Object { $_ }) -join "`n") -match 'uam_refresh=.*HttpOnly'
)

if ($reg -and $reg.accessToken) {
    $token = $reg.accessToken
    $headers = @{ Authorization = "Bearer $token" }

    # 4. /me via gateway
    $me = $null
    try {
        $me = Invoke-RestMethod -Uri "$GatewayUrl/api/auth/me" -Headers $headers
    } catch { }
    Assert-Test "GET /api/auth/me returns user" ($null -ne $me -and $me.user.email -eq $email)

    # 5. Same-origin path through uam-frontend proxy
    $viaFe = $null
    try {
        $viaFe = Invoke-RestMethod -Uri "$UamFrontUrl/api/auth/me" -Headers $headers
    } catch { }
    Assert-Test "GET /api/auth/me via uam-frontend proxy" ($null -ne $viaFe -and $viaFe.user.email -eq $email)

    # 6. Logout + revocation — cookie session, no Authorization header (ADR-0038)
    $email2 = "uam-logout-$(Get-Random)@example.com"
    $session2 = New-UamWebSession
    $csrf2 = Invoke-UamCsrfBootstrap $session2
    $reg2Resp = Invoke-UamAuthPost "$GatewayUrl/api/auth/register" (@{
        email = $email2; password = "SecurePass123!"; displayName = "Logout Test"
    } | ConvertTo-Json) $session2 $csrf2
    $reg2 = $reg2Resp.Content | ConvertFrom-Json
    $csrf2 = Get-CsrfFromSetCookie (($reg2Resp.Headers['Set-Cookie'] | ForEach-Object { $_ }) -join "`n")
    if (-not $csrf2) { $csrf2 = Invoke-UamCsrfBootstrap $session2 }
    $logoutBody = @{ accessToken = $reg2.accessToken } | ConvertTo-Json
    Invoke-UamAuthPost "$GatewayUrl/api/auth/logout" $logoutBody $session2 $csrf2 | Out-Null
    $afterLogout = 0
    try {
        $r = Invoke-WebRequest -Uri "$GatewayUrl/api/v1/users" -Headers @{ Authorization = "Bearer $($reg2.accessToken)" } -UseBasicParsing
        $afterLogout = $r.StatusCode
    } catch {
        if ($_.Exception.Response) { $afterLogout = [int]$_.Exception.Response.StatusCode }
    }
    Assert-Test "After logout, gateway rejects access token (401)" ($afterLogout -eq 401)

    # 7. Business API with active session
    $api = $null
    try {
        $api = Invoke-RestMethod -Uri "$GatewayUrl/api/v1/users" -Headers $headers
    } catch { }
    Assert-Test "UAM token accepted by /api/v1 (gateway JWT validation)" ($null -ne $api)

    # 8. Refresh rotation via HttpOnly cookie + CSRF (no refresh in JSON body)
    $refreshBody = @{ accessToken = $reg.accessToken } | ConvertTo-Json
    $refResp = Invoke-UamAuthPost "$GatewayUrl/api/auth/refresh-token" $refreshBody $session $csrf
    $refreshed = $refResp.Content | ConvertFrom-Json
    Assert-Test "Refresh returns new accessToken" ($null -ne $refreshed.accessToken -and $refreshed.accessToken -ne $reg.accessToken)
    Assert-Test "Refresh omits refreshToken in JSON" ($null -eq $refreshed.refreshToken)

    # 8b. CSRF required when refresh is cookie-based (ADR-0055)
    $csrfFail = 0
    try {
        $r = Invoke-WebRequest -Uri "$GatewayUrl/api/auth/refresh-token" -Method POST `
            -Body (@{ accessToken = $reg.accessToken } | ConvertTo-Json) `
            -ContentType "application/json" -WebSession $session -UseBasicParsing
        $csrfFail = $r.StatusCode
    } catch {
        if ($_.Exception.Response) { $csrfFail = [int]$_.Exception.Response.StatusCode }
    }
    Assert-Test "Refresh without CSRF header rejected (403)" ($csrfFail -eq 403)

    # 9. Token version floor — stale tv rejected without warming JWT LRU cache
    $emailTv = "uam-tv-$(Get-Random)@example.com"
    $tvSession = New-UamWebSession
    $tvCsrf = Invoke-UamCsrfBootstrap $tvSession
    $regTvResp = Invoke-UamAuthPost "$GatewayUrl/api/auth/register" (@{
        email = $emailTv; password = "SecurePass123!"; displayName = "TV Test"
    } | ConvertTo-Json) $tvSession $tvCsrf
    $regTv = $regTvResp.Content | ConvertFrom-Json
    $tvToken = $regTv.accessToken
    $tvMe = Invoke-RestMethod -Uri "$GatewayUrl/api/auth/me" -Headers @{ Authorization = "Bearer $tvToken" }
    $userId = $tvMe.user.id
    if ($userId) {
        docker compose -f docker-compose.yml -f docker-compose.testing.yml -f docker-compose.uam.yml exec -T redis redis-cli SET "gateway:user:tv:$userId" 99 | Out-Null
        $tvReject = 0
        try {
            $r = Invoke-WebRequest -Uri "$GatewayUrl/api/v1/users" -Headers @{ Authorization = "Bearer $tvToken" } -UseBasicParsing
            $tvReject = $r.StatusCode
        } catch {
            if ($_.Exception.Response) { $tvReject = [int]$_.Exception.Response.StatusCode }
        }
        Assert-Test "Stale token version rejected by gateway (401)" ($tvReject -eq 401)
    } else {
        Assert-Test "Stale token version rejected by gateway (401)" $false
    }

    # 10. Resend verification — same response for unknown vs known email (ADR-0060)
    $resendSession = New-UamWebSession
    $resendCsrf = Invoke-UamCsrfBootstrap $resendSession
    $unknownResend = try {
        $r = Invoke-UamAuthPost "$GatewayUrl/api/auth/resend-verification" (@{ email = "no-such-$(Get-Random)@example.com" } | ConvertTo-Json) $resendSession $resendCsrf
        $r.Content | ConvertFrom-Json
    } catch { $null }
    $knownResend = try {
        $r = Invoke-UamAuthPost "$GatewayUrl/api/auth/resend-verification" (@{ email = $email } | ConvertTo-Json) $resendSession $resendCsrf
        $r.Content | ConvertFrom-Json
    } catch { $null }
    Assert-Test "Resend verification returns success for unknown email" ($null -ne $unknownResend -and $unknownResend.success)
    Assert-Test "Resend verification same message for unknown vs known" (
        $null -ne $unknownResend -and $null -ne $knownResend -and $unknownResend.message -eq $knownResend.message
    )

    # 11. Forgot password — uniform response (anti-enumeration)
    $forgotSession = New-UamWebSession
    $forgotCsrf = Invoke-UamCsrfBootstrap $forgotSession
    $forgotUnknownResp = Invoke-UamAuthPost "$GatewayUrl/api/auth/forgot-password" (@{ email = "no-such-$(Get-Random)@example.com" } | ConvertTo-Json) $forgotSession $forgotCsrf
    $forgotKnownResp = Invoke-UamAuthPost "$GatewayUrl/api/auth/forgot-password" (@{ email = $email } | ConvertTo-Json) $forgotSession $forgotCsrf
    $forgotUnknown = $forgotUnknownResp.Content | ConvertFrom-Json
    $forgotKnown = $forgotKnownResp.Content | ConvertFrom-Json
    Assert-Test "Forgot password returns success for unknown email" ($forgotUnknown.success -eq $true)
    Assert-Test "Forgot password same message for unknown vs known" ($forgotUnknown.message -eq $forgotKnown.message)

    # 12. Verification status — GET never leaks verified emails (ADR-0062)
    $getStatus = try {
        Invoke-RestMethod -Uri "$GatewayUrl/api/auth/verification-status?email=$([uri]::EscapeDataString($email))" -Method GET
    } catch { $null }
    Assert-Test "GET verification-status never returns verified=true" (
        $null -ne $getStatus -and $getStatus.verified -eq $false
    )

    # 13. POST with invalid poll token — always unverified
    $postBadPoll = try {
        Invoke-RestMethod -Uri "$GatewayUrl/api/auth/verification-status" -Method POST `
            -Body (@{ pollToken = ('a' * 64) } | ConvertTo-Json) `
            -ContentType "application/json"
    } catch { $null }
    Assert-Test "POST verification-status invalid poll returns verified=false" (
        $null -ne $postBadPoll -and $postBadPoll.verified -eq $false
    )
}

Write-Host "`n=== Results: $passed passed, $failed failed ===" -ForegroundColor Cyan
if ($failed -gt 0) { exit 1 }
