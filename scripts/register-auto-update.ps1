param(
    [string]$Time = '04:00',
    [string]$AutoApply = 'False',
    [string]$RollbackOnFailure = 'True'
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-KreamAdministrator
if ($Time -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw '자동 업데이트 시간은 HH:mm 형식이어야 합니다.' }
$projectRoot = Get-KreamProjectRoot
$updateScript = Join-Path $projectRoot 'scripts\update.ps1'
$taskName = if ($env:KREAM_AUTO_UPDATE_TASK_NAME) { $env:KREAM_AUTO_UPDATE_TASK_NAME } else { 'KREAMBOT-AutoUpdate' }
$apply = [Convert]::ToBoolean($AutoApply)
$rollback = [Convert]::ToBoolean($RollbackOnFailure)
$taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$updateScript`" -Mode Automatic -RestartService"
if (-not $apply) { $taskCommand += ' -CheckOnly' }
if (-not $rollback) { $taskCommand += ' -DisableRollback' }

& schtasks.exe /Create /TN $taskName /TR $taskCommand /SC DAILY /ST $Time /RU SYSTEM /RL HIGHEST /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "자동 업데이트 작업 등록에 실패했습니다. 종료 코드: $LASTEXITCODE" }
Write-KreamLog -Type app -Message "자동 업데이트 작업 등록: $taskName, $Time, autoApply=$apply" -ProjectRoot $projectRoot
Write-Host "자동 업데이트 작업 등록 완료: $taskName ($Time)"
