param(
    [string]$ServiceName = $(if ($env:KREAM_SERVICE_NAME) { $env:KREAM_SERVICE_NAME } else { 'KREAMBOT' }),
    [ValidateRange(0, 30)][int]$DelaySeconds = 0
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-KreamAdministrator
$projectRoot = Get-KreamProjectRoot

if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
$service = Get-Service -Name $ServiceName -ErrorAction Stop
Write-KreamLog -Type app -Message "$ServiceName 서비스 재시작 시작" -ProjectRoot $projectRoot
if ($service.Status -ne 'Stopped') {
    & sc.exe stop $ServiceName | Out-Null
    if ($LASTEXITCODE -notin @(0, 1062)) { throw "$ServiceName 서비스 중지 요청에 실패했습니다. 종료 코드: $LASTEXITCODE" }
    Wait-KreamServiceState -ServiceName $ServiceName -DesiredState Stopped
}
& sc.exe start $ServiceName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "$ServiceName 서비스 시작 요청에 실패했습니다. 종료 코드: $LASTEXITCODE" }
Wait-KreamServiceState -ServiceName $ServiceName -DesiredState Running
Write-KreamLog -Type app -Message "$ServiceName 서비스 재시작 완료" -ProjectRoot $projectRoot
Write-Host "$ServiceName 서비스 재시작 완료"
