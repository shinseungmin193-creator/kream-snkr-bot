param()

. (Join-Path $PSScriptRoot 'common.ps1')
$projectRoot = Get-KreamProjectRoot
$serviceName = if ($env:KREAM_SERVICE_NAME) { $env:KREAM_SERVICE_NAME } else { 'KREAMBOT' }
Write-Host "관리자 권한: $(Test-KreamAdministrator)"
Write-Host "프로젝트 경로: $projectRoot"
Write-Host "Node 경로: $(Get-KreamNodePath)"
Write-Host "NSSM 경로: $(Get-KreamNssmPath -ProjectRoot $projectRoot)"
$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
Write-Host "서비스: $(if ($service) { "$serviceName / $($service.Status) / $($service.StartType)" } else { '미등록' })"
try {
    $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/system/status' -TimeoutSec 5
    Write-Host "API: 정상 / 버전 $($status.version.appVersion) / 커밋 $($status.version.currentCommitShort)"
} catch { Write-Host "API: 연결 실패 / $($_.Exception.Message)" }
try {
    $chrome = Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json/version' -TimeoutSec 5
    Write-Host "Chrome CDP: 연결됨 / $($chrome.Browser)"
} catch { Write-Host "Chrome CDP: 연결 안 됨" }
Push-Location $projectRoot
try {
    $branch = (& git.exe branch --show-current).Trim()
    $commit = (& git.exe rev-parse --short HEAD).Trim()
    Write-Host "Git: $branch / $commit"
} finally { Pop-Location }
