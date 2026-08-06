param(
    [string]$ServiceName = $(if ($env:KREAM_SERVICE_NAME) { $env:KREAM_SERVICE_NAME } else { 'KREAMBOT' }),
    [string]$ConfirmRemoval
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-KreamAdministrator
if ($ConfirmRemoval -ne $ServiceName) { throw "서비스 삭제를 확인하려면 -ConfirmRemoval $ServiceName 을 지정하세요." }
$nssmPath = Get-KreamNssmPath
$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $service) { Write-Host "$ServiceName 서비스가 등록되어 있지 않습니다."; exit 0 }
if ($service.Status -ne 'Stopped') {
    Stop-Service -Name $ServiceName -Force
    Wait-KreamServiceState -ServiceName $ServiceName -DesiredState Stopped
}
Invoke-KreamNssm $nssmPath @('remove', $ServiceName, 'confirm')
Write-Host "$ServiceName 서비스 삭제 완료"
