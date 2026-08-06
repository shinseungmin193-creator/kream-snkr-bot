param(
    [ValidateSet('Manual','Automatic')][string]$Mode = 'Manual',
    [switch]$RestartService,
    [switch]$CheckOnly,
    [switch]$DisableRollback,
    [switch]$DryRun,
    [string]$LockToken = ''
)

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-KreamAdministrator

$projectRoot = Get-KreamProjectRoot
$nodePath = Get-KreamNodePath
$serviceName = if ($env:KREAM_SERVICE_NAME) { $env:KREAM_SERVICE_NAME } else { 'KREAMBOT' }
$lockPath = Join-Path $projectRoot 'data\system-update.lock'
$startedAt = Get-Date
$beforeCommit = ''
$afterCommit = ''
$changedRepository = $false
$rolledBack = $false
$packageChanged = $false
$lockOwned = $false

function ConvertTo-SafeError {
    param([string]$Message)
    $safe = $Message -replace 'https?://[^\s@/]+:[^\s@/]+@', 'https://***:***@'
    $safe = $safe -replace '(?i)(token|password|authorization)=([^\s&]+)', '$1=***'
    if ($safe.Length -gt 500) { $safe = $safe.Substring(0, 500) }
    return $safe
}

function Invoke-CheckedCommand {
    param([string]$FilePath, [string[]]$CommandArguments, [int]$TimeoutSeconds = 0)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @CommandArguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw (ConvertTo-SafeError $output.Trim()) }
    return $output.Trim()
}

function Write-UpdateHistory {
    param([bool]$Success, [string]$ErrorSummary = '')
    $duration = [Math]::Max(0, [int]((Get-Date) - $startedAt).TotalMilliseconds)
    $encodedError = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-SafeError $ErrorSummary)))
    $historyScript = Join-Path $projectRoot 'scripts\record-update.js'
    & $nodePath $historyScript '--timestamp' ([DateTime]::UtcNow.ToString('o')) '--computer' $env:COMPUTERNAME '--mode' $Mode '--before' $beforeCommit '--after' $afterCommit '--success' $Success.ToString().ToLowerInvariant() '--rolled-back' $rolledBack.ToString().ToLowerInvariant() '--duration-ms' $duration.ToString() '--error-base64' $encodedError
    if ($LASTEXITCODE -ne 0) { Write-KreamLog -Type error -Message '업데이트 기록 저장에 실패했습니다.' -ProjectRoot $projectRoot }
}

function Acquire-UpdateLock {
    New-Item -ItemType Directory -Path (Split-Path -Parent $lockPath) -Force | Out-Null
    if ($LockToken) {
        if (-not (Test-Path -LiteralPath $lockPath)) { throw '예약된 업데이트 잠금 파일을 찾을 수 없습니다.' }
        $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($lock.token -ne $LockToken) { throw '업데이트 잠금 토큰이 일치하지 않습니다.' }
        $script:lockOwned = $true
        return
    }
    try {
        $stream = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $payload = [Text.Encoding]::UTF8.GetBytes((@{ pid = $PID; createdAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress))
            $stream.Write($payload, 0, $payload.Length)
        } finally { $stream.Dispose() }
        $script:lockOwned = $true
    } catch [IO.IOException] {
        throw '이미 업데이트가 진행 중입니다.'
    }
}

function Test-RequiredFiles {
    $requiredFiles = @(
        'app.js', 'database.js', 'inventory.js', 'compareAll.js', 'filterTargets.js',
        'public\index.html', 'public\script.js', 'system\system-manager.js',
        'scripts\restart-service.ps1'
    )
    foreach ($relativePath in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
            throw "필수 파일이 없습니다: $relativePath"
        }
    }
}

function Test-JavaScriptSyntax {
    $javascriptFiles = @(
        'app.js', 'database.js', 'inventory.js', 'compareAll.js', 'filterTargets.js',
        'public\script.js', 'system\config.js', 'system\file-logger.js', 'system\system-manager.js'
    )
    foreach ($relativePath in $javascriptFiles) {
        Invoke-CheckedCommand $nodePath @('--check', (Join-Path $projectRoot $relativePath)) | Out-Null
    }
}

Acquire-UpdateLock
Push-Location $projectRoot
try {
    Write-KreamLog -Type update -Message "$Mode 업데이트 시작 (dryRun=$DryRun, checkOnly=$CheckOnly)" -ProjectRoot $projectRoot

    if ($Mode -eq 'Automatic') {
        try {
            $status = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/system/status' -TimeoutSec 5
            if ($status.job.busy) {
                Write-KreamLog -Type update -Message "자동 업데이트 연기: $($status.job.name) 작업 진행 중" -ProjectRoot $projectRoot
                Write-UpdateHistory -Success $true -ErrorSummary '자동화 작업 진행 중으로 다음 예약 시간까지 연기됨'
                exit 0
            }
        } catch {
            Write-KreamLog -Type update -Message '서비스 상태 API에 연결되지 않아 독립 업데이트 점검을 계속합니다.' -ProjectRoot $projectRoot
        }
    }

    Test-RequiredFiles
    Test-JavaScriptSyntax
    $beforeCommit = Invoke-CheckedCommand 'git.exe' @('rev-parse', 'HEAD')
    $afterCommit = $beforeCommit
    $dirty = Invoke-CheckedCommand 'git.exe' @('status', '--porcelain', '--untracked-files=no')
    if ($dirty) { throw '커밋되지 않은 로컬 변경사항이 있어 업데이트를 중단했습니다.' }
    $branch = Invoke-CheckedCommand 'git.exe' @('branch', '--show-current')
    if (-not $branch) { throw 'detached HEAD 상태에서는 자동 업데이트할 수 없습니다.' }
    $remotes = (Invoke-CheckedCommand 'git.exe' @('remote')) -split "`r?`n" | Where-Object { $_ }
    $remote = if ($remotes -contains 'origin') { 'origin' } elseif ($remotes.Count -gt 0) { $remotes[0] } else { $null }
    if (-not $remote) { throw 'Git remote가 설정되어 있지 않습니다.' }

    if ($DryRun) {
        Write-KreamLog -Type update -Message "Dry-run 검증 완료: branch=$branch, commit=$($beforeCommit.Substring(0, 7))" -ProjectRoot $projectRoot
        Write-UpdateHistory -Success $true
        exit 0
    }

    Write-KreamLog -Type update -Message "Git 업데이트 확인: remote=$remote, branch=$branch" -ProjectRoot $projectRoot
    Invoke-CheckedCommand 'git.exe' @('fetch', '--prune', $remote, $branch) | Out-Null
    $targetCommit = Invoke-CheckedCommand 'git.exe' @('rev-parse', "refs/remotes/$remote/$branch")
    if ($targetCommit -eq $beforeCommit) {
        Write-KreamLog -Type update -Message '이미 최신 버전입니다.' -ProjectRoot $projectRoot
        Write-UpdateHistory -Success $true
        exit 0
    }

    if ($CheckOnly) {
        Write-KreamLog -Type update -Message "새 업데이트 확인: $($beforeCommit.Substring(0, 7)) -> $($targetCommit.Substring(0, 7))" -ProjectRoot $projectRoot
        Write-UpdateHistory -Success $true -ErrorSummary '새 업데이트 확인됨(자동 적용 OFF)'
        exit 0
    }

    $backupScript = Join-Path $projectRoot 'scripts\backup-db.js'
    Invoke-CheckedCommand $nodePath @($backupScript) | Out-Null
    Write-KreamLog -Type update -Message '업데이트 전 DB 백업 완료' -ProjectRoot $projectRoot

    $backupStamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
    $localBackup = Join-Path $projectRoot "backups\update_$backupStamp\local"
    New-Item -ItemType Directory -Path $localBackup -Force | Out-Null
    $importantFiles = @('.env', 'data\system-settings.json', 'data\system-config.json')
    foreach ($relativePath in $importantFiles) {
        $source = Join-Path $projectRoot $relativePath
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $destination = Join-Path $localBackup $relativePath
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $source -Destination $destination -Force
        }
    }

    $packageFiles = Invoke-CheckedCommand 'git.exe' @('diff', '--name-only', "$beforeCommit..$targetCommit", '--', 'package.json', 'package-lock.json')
    $packageChanged = [bool]$packageFiles
    Invoke-CheckedCommand 'git.exe' @('merge', '--ff-only', "refs/remotes/$remote/$branch") | Out-Null
    $changedRepository = $true
    $afterCommit = Invoke-CheckedCommand 'git.exe' @('rev-parse', 'HEAD')

    if ($packageChanged) {
        $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
        if (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json')) {
            Invoke-CheckedCommand $npmPath @('ci') | Out-Null
        } else {
            Invoke-CheckedCommand $npmPath @('install') | Out-Null
        }
        Write-KreamLog -Type update -Message 'Node.js 의존성 업데이트 완료' -ProjectRoot $projectRoot
    }

    Test-RequiredFiles
    Test-JavaScriptSyntax
    Write-KreamLog -Type update -Message "업데이트 검증 완료: $($beforeCommit.Substring(0, 7)) -> $($afterCommit.Substring(0, 7))" -ProjectRoot $projectRoot

    if ($RestartService) {
        & (Join-Path $projectRoot 'scripts\restart-service.ps1') -ServiceName $serviceName
        if ($LASTEXITCODE -ne 0) { throw '업데이트 후 서비스 재시작에 실패했습니다.' }
    }
    Write-UpdateHistory -Success $true
    Write-KreamLog -Type update -Message '업데이트 완료' -ProjectRoot $projectRoot
} catch {
    $safeError = ConvertTo-SafeError $_.Exception.Message
    Write-KreamLog -Type error -Message "업데이트 실패: $safeError" -ProjectRoot $projectRoot
    Write-KreamLog -Type update -Message "업데이트 실패: $safeError" -ProjectRoot $projectRoot
    if ($changedRepository -and -not $DisableRollback -and $beforeCommit) {
        try {
            Invoke-CheckedCommand 'git.exe' @('reset', '--hard', $beforeCommit) | Out-Null
            $afterCommit = Invoke-CheckedCommand 'git.exe' @('rev-parse', 'HEAD')
            if ($packageChanged -and (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json'))) {
                $npmPath = (Get-Command npm.cmd -ErrorAction Stop).Source
                Invoke-CheckedCommand $npmPath @('ci') | Out-Null
            }
            Test-RequiredFiles
            Test-JavaScriptSyntax
            $rolledBack = $true
            Write-KreamLog -Type update -Message "이전 커밋으로 롤백 완료: $($beforeCommit.Substring(0, 7))" -ProjectRoot $projectRoot
        } catch {
            Write-KreamLog -Type error -Message "롤백 실패: $(ConvertTo-SafeError $_.Exception.Message)" -ProjectRoot $projectRoot
        }
    }
    try {
        $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne 'Running') {
            Start-Service -Name $serviceName
            Wait-KreamServiceState -ServiceName $serviceName -DesiredState Running
        }
    } catch { Write-KreamLog -Type error -Message "서비스 복구 실패: $(ConvertTo-SafeError $_.Exception.Message)" -ProjectRoot $projectRoot }
    Write-UpdateHistory -Success $false -ErrorSummary $safeError
    exit 1
} finally {
    Pop-Location
    if ($lockOwned -and (Test-Path -LiteralPath $lockPath)) {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}
