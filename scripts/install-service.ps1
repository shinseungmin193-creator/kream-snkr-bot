param(
    [string]$ServiceName = $(if ($env:KREAM_SERVICE_NAME) { $env:KREAM_SERVICE_NAME } else { 'KREAMBOT' }),
    [switch]$Force
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-KreamAdministrator

$projectRoot = Get-KreamProjectRoot
$nodePath = Get-KreamNodePath
$nssmPath = Get-KreamNssmPath -ProjectRoot $projectRoot
$appPath = Join-Path $projectRoot 'app.js'
$logDirectory = Join-Path $projectRoot 'logs'

if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) { throw "app.js를 찾을 수 없습니다: $appPath" }
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and -not $Force) {
    Write-Host "$ServiceName 서비스가 이미 등록되어 있어 기존 설정을 유지합니다. 변경하려면 -Force를 사용하세요."
} else {
    if (-not $existing) { Invoke-KreamNssm $nssmPath @('install', $ServiceName, $nodePath, 'app.js') }
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'Application', $nodePath)
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppDirectory', $projectRoot)
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppParameters', 'app.js')
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppExit', 'Default', 'Restart')
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppRestartDelay', '3000')
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppStdout', (Join-Path $logDirectory 'app.log'))
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppStderr', (Join-Path $logDirectory 'error.log'))
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppRotateFiles', '1')
    Invoke-KreamNssm $nssmPath @('set', $ServiceName, 'AppRotateBytes', '10485760')
}

$service = Get-Service -Name $ServiceName -ErrorAction Stop
if ($service.Status -ne 'Running') {
    Start-Service -Name $ServiceName
    Wait-KreamServiceState -ServiceName $ServiceName -DesiredState Running
}
Write-Host "$ServiceName 서비스 등록 및 실행 확인 완료"
Write-Host "프로젝트: $projectRoot"
Write-Host "Node: $nodePath"
Write-Host "NSSM: $nssmPath"
