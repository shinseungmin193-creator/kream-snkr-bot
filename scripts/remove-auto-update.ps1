param()

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-KreamAdministrator
$projectRoot = Get-KreamProjectRoot
$taskName = if ($env:KREAM_AUTO_UPDATE_TASK_NAME) { $env:KREAM_AUTO_UPDATE_TASK_NAME } else { 'KREAMBOT-AutoUpdate' }
& schtasks.exe /Query /TN $taskName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    & schtasks.exe /Delete /TN $taskName /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "자동 업데이트 작업 삭제에 실패했습니다. 종료 코드: $LASTEXITCODE" }
}
Write-KreamLog -Type app -Message "자동 업데이트 작업 해제: $taskName" -ProjectRoot $projectRoot
Write-Host "자동 업데이트 작업 해제 완료: $taskName"
