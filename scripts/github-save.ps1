param(
    [switch]$NonInteractive,
    [string]$DeployConfirmation = '',
    [ValidateSet('','patch','minor','major')][string]$VersionType = '',
    [string]$CommitMessage = '',
    [string]$PushConfirmation = '',
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$expectedOrigin = 'https://github.com/shinseungmin193-creator/kream-snkr-bot.git'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packagePath = Join-Path $projectRoot 'package.json'
$packageLockPath = Join-Path $projectRoot 'package-lock.json'
$versionChanged = $false
$stagedByScript = $false
$originalPackageBytes = $null
$originalPackageLockBytes = $null

function Write-Section {
    param([string]$Text)
    Write-Host ''
    Write-Host "===== $Text =====" -ForegroundColor Cyan
}

function Invoke-GitCapture {
    param([string[]]$GitArguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& git.exe @GitArguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    $text = ($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine
    if ($exitCode -ne 0) { throw $text.Trim() }
    return $text.Trim()
}

function Invoke-GitVisible {
    param([string[]]$GitArguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git.exe @GitArguments
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -ne 0) { throw "Git 명령이 실패했습니다. 종료 코드: $exitCode" }
}

function Test-GitHasOutput {
    param([string[]]$GitArguments)
    $text = Invoke-GitCapture $GitArguments
    return -not [string]::IsNullOrWhiteSpace($text)
}

function Test-SensitivePath {
    param([string]$PathValue)
    $value = ($PathValue -replace '\\', '/').TrimStart('./').ToLowerInvariant()
    if ($value -match '(^|/)(node_modules|backups|logs|profile|chrome-profile|chrome_profile|chrome-data|chrome_debug|user-data-dir|cookies|sessions|tmp|temp)(/|$)') { return $true }
    if ($value -match '(^|/)playwright/\.auth(/|$)') { return $true }
    if ($value -match '(^|/)\.env($|\.)' -and $value -notmatch '(^|/)\.env\.example$') { return $true }
    if ($value -in @('config/system-config.json','data/system-config.json','data/system-settings.json','data/update-history.json','data/system-update.lock','cookies')) { return $true }
    if ($value -match '\.(db|db-wal|db-shm|cookie|cookies|tmp|temp|bak|pid|log)$') { return $true }
    if ($value -match '(^|/)(cookie|cookies|session|storage-state|auth-state)[^/]*\.json$') { return $true }
    return $false
}

function Ensure-GitIgnore {
    $gitIgnorePath = Join-Path $projectRoot '.gitignore'
    $requiredRules = @(
        'node_modules/', 'backups/', 'logs/', 'profile/', '.env', '.env.*', '!.env.example',
        'config/system-config.json', 'data/system-config.json', 'data/system-settings.json',
        'data/update-history.json', 'data/system-update.lock', '*.db', '*.db-wal', '*.db-shm',
        'chrome-profile/', 'chrome_profile/', 'chrome-data/', 'chrome_debug/', 'user-data-dir/',
        'playwright/.auth/', 'cookies/', 'sessions/', 'Cookies', '*.cookie', '*.cookies',
        'cookie*.json', 'cookies*.json', 'session*.json', 'storage-state*.json', 'auth-state*.json',
        '*.tmp', '*.temp', '*.bak', '*.pid', '*.log', 'tmp/', 'temp/'
    )
    if (-not (Test-Path -LiteralPath $gitIgnorePath)) {
        [IO.File]::WriteAllText($gitIgnorePath, '', [Text.UTF8Encoding]::new($false))
    }
    $existingLines = @(Get-Content -LiteralPath $gitIgnorePath -Encoding UTF8 | ForEach-Object { $_.Trim() })
    $missing = @($requiredRules | Where-Object { $existingLines -notcontains $_ })
    if ($missing.Count -gt 0) {
        $builder = [Text.StringBuilder]::new()
        [void]$builder.AppendLine('')
        [void]$builder.AppendLine('# GitHub save safety rules')
        foreach ($rule in $missing) { [void]$builder.AppendLine($rule) }
        [IO.File]::AppendAllText($gitIgnorePath, $builder.ToString(), [Text.UTF8Encoding]::new($false))
        Write-Host ".gitignore에 누락된 안전 제외 규칙 $($missing.Count)개를 추가했습니다." -ForegroundColor Yellow
    }
}

function Restore-VersionFiles {
    if (-not $versionChanged) { return }
    if ($null -ne $originalPackageBytes) { [IO.File]::WriteAllBytes($packagePath, $originalPackageBytes) }
    if ($null -ne $originalPackageLockBytes -and (Test-Path -LiteralPath $packageLockPath)) {
        [IO.File]::WriteAllBytes($packageLockPath, $originalPackageLockBytes)
    }
    $script:versionChanged = $false
}

function Reset-ScriptStaging {
    if (-not $stagedByScript) { return }
    try { Invoke-GitCapture @('reset', '--mixed', 'HEAD') | Out-Null } catch { Write-Host "스테이징 해제 실패: $($_.Exception.Message)" -ForegroundColor Yellow }
    $script:stagedByScript = $false
}

function Stop-Safely {
    param([string]$Message, [int]$Code = 1, [switch]$RestoreVersion, [switch]$ResetStaging)
    if ($RestoreVersion) { Restore-VersionFiles }
    if ($ResetStaging) { Reset-ScriptStaging }
    Write-Host $Message -ForegroundColor $(if ($Code -eq 0) { 'Yellow' } else { 'Red' })
    exit $Code
}

Write-Host '이 기능은 개발 PC에서 GitHub에 새 버전을 배포하는 기능입니다.' -ForegroundColor Yellow
Write-Host '계속하려면 DEPLOY를 입력하세요.' -ForegroundColor Yellow
$deployInput = if ($NonInteractive) { $DeployConfirmation } else { Read-Host '확인' }
if ($deployInput -cne 'DEPLOY') { Stop-Safely 'DEPLOY가 정확히 입력되지 않아 종료합니다.' 2 }

Set-Location -LiteralPath $projectRoot
Write-Host "프로젝트 경로: $projectRoot"

try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot '.git'))) { throw '현재 폴더가 Git 저장소가 아닙니다.' }
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) { throw 'git.exe를 찾을 수 없습니다.' }
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'node.exe를 찾을 수 없습니다.' }
    if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw 'package.json을 찾을 수 없습니다.' }

    Write-Section 'Git 환경 확인'
    $branch = Invoke-GitCapture @('branch', '--show-current')
    $origin = Invoke-GitCapture @('config', '--get', 'remote.origin.url')
    Write-Host "현재 브랜치: $branch"
    Write-Host "origin: $origin"
    if ($branch -cne 'main') { throw 'main 브랜치가 아니므로 종료합니다. 브랜치는 자동으로 변경하지 않습니다.' }
    if ($origin -cne $expectedOrigin) { throw "origin 주소가 허용된 저장소와 일치하지 않습니다.`n예상: $expectedOrigin`n현재: $origin" }

    Ensure-GitIgnore

    $trackedSensitive = @(Invoke-GitCapture @('ls-files') -split "`r?`n" | Where-Object { $_ -and (Test-SensitivePath $_) })
    if ($trackedSensitive.Count -gt 0) {
        Write-Host '이미 Git이 추적 중인 민감 파일이 있습니다:' -ForegroundColor Red
        $trackedSensitive | ForEach-Object { Write-Host "  $_" }
        throw '위 파일은 git rm --cached로 추적 해제한 뒤 다시 실행하세요.'
    }

    $stagedBefore = Test-GitHasOutput @('diff', '--cached', '--name-only')
    if ($stagedBefore) { throw '이미 staged 상태인 변경사항이 있습니다. 기존 staging을 보존하기 위해 먼저 commit하거나 unstage하세요.' }

    Write-Section '현재 변경사항'
    $statusText = Invoke-GitCapture @('-c', 'core.quotepath=false', 'status', '--short', '--untracked-files=all')
    if ([string]::IsNullOrWhiteSpace($statusText)) { Stop-Safely '저장할 변경사항이 없습니다.' 0 }
    Write-Host $statusText

    Write-Section 'Git에 포함될 파일 목록'
    $candidateFiles = Invoke-GitCapture @('-c', 'core.quotepath=false', 'status', '--short', '--untracked-files=all')
    Write-Host $candidateFiles

    Write-Section '원격 최신 상태 확인'
    Invoke-GitVisible @('fetch', 'origin', 'main')
    $remoteAhead = [int](Invoke-GitCapture @('rev-list', '--count', 'HEAD..origin/main'))
    if ($remoteAhead -gt 0) { throw '원격에 먼저 받아야 할 변경사항이 있습니다.' }

    $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
    $oldVersion = [string]$package.version
    $versionMatch = [regex]::Match($oldVersion, '^(\d+)\.(\d+)\.(\d+)$')
    if (-not $versionMatch.Success) { throw "지원하지 않는 package.json 버전 형식입니다: $oldVersion" }

    Write-Section '버전 종류 선택'
    Write-Host '[1] patch'
    Write-Host '[2] minor'
    Write-Host '[3] major'
    Write-Host '[Enter] patch'
    $selection = if ($NonInteractive) { $VersionType } else { Read-Host '선택' }
    $selectedType = switch ($selection) {
        { $_ -in @('', '1', 'patch') } { 'patch'; break }
        { $_ -in @('2', 'minor') } { 'minor'; break }
        { $_ -in @('3', 'major') } { 'major'; break }
        default { throw '버전 선택은 1, 2, 3 또는 Enter만 사용할 수 있습니다.' }
    }

    [long]$major = $versionMatch.Groups[1].Value
    [long]$minor = $versionMatch.Groups[2].Value
    [long]$patch = $versionMatch.Groups[3].Value
    switch ($selectedType) {
        'patch' { $patch += 1 }
        'minor' { $minor += 1; $patch = 0 }
        'major' { $major += 1; $minor = 0; $patch = 0 }
    }
    $newVersion = "$major.$minor.$patch"
    Write-Host "$selectedType`: $oldVersion → $newVersion" -ForegroundColor Green

    $messageInput = if ($NonInteractive) { $CommitMessage } else { Read-Host "커밋 메시지 [기본: release: v$newVersion]" }
    $finalCommitMessage = ($messageInput -replace "`r|`n", ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($finalCommitMessage)) { $finalCommitMessage = "release: v$newVersion" }

    $originalPackageBytes = [IO.File]::ReadAllBytes($packagePath)
    if (Test-Path -LiteralPath $packageLockPath) { $originalPackageLockBytes = [IO.File]::ReadAllBytes($packageLockPath) }
    $versionChanged = $true
    $versionUpdater = @'
const fs = require('fs');
const version = process.argv[1];
for (const file of ['package.json', 'package-lock.json']) {
  if (!fs.existsSync(file)) continue;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = version;
  if (file === 'package-lock.json' && data.packages && data.packages['']) data.packages[''].version = version;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}
'@
    & node.exe -e $versionUpdater $newVersion
    if ($LASTEXITCODE -ne 0) { throw 'package.json 버전 변경에 실패했습니다.' }

    Write-Section 'JavaScript 구문 검사'
    $syntaxFiles = @(
        'app.js', 'database.js', 'inventory.js', 'compareAll.js', 'filterTargets.js',
        'public/script.js', 'public/system.js', 'system/config.js',
        'system/file-logger.js', 'system/system-manager.js'
    )
    foreach ($relativePath in $syntaxFiles) {
        $fullPath = Join-Path $projectRoot $relativePath
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
        & node.exe --check $fullPath
        if ($LASTEXITCODE -ne 0) {
            Restore-VersionFiles
            Stop-Safely "JavaScript 구문 검사 실패: $relativePath`n버전을 $oldVersion 상태로 복구했습니다." 1
        }
        Write-Host "통과: $relativePath"
    }

    Invoke-GitVisible @('add', '.')
    $stagedByScript = $true
    $stagedFiles = @(Invoke-GitCapture @('diff', '--cached', '--name-only') -split "`r?`n" | Where-Object { $_ })
    $stagedSensitive = @($stagedFiles | Where-Object { Test-SensitivePath $_ })
    if ($stagedSensitive.Count -gt 0) {
        Write-Host '스테이징에서 민감 파일을 발견했습니다:' -ForegroundColor Red
        $stagedSensitive | ForEach-Object { Write-Host "  $_" }
        Stop-Safely '민감 파일이 포함되어 commit을 차단했습니다.' 1 -RestoreVersion -ResetStaging
    }

    Write-Section '커밋 예정 변경 통계'
    Invoke-GitVisible @('diff', '--cached', '--stat')

    if ($DryRun) {
        Stop-Safely "DRY-RUN 완료: $oldVersion → $newVersion, commit과 push는 실행하지 않았습니다." 0 -RestoreVersion -ResetStaging
    }

    Write-Host ''
    Write-Host "커밋 메시지: $finalCommitMessage"
    Write-Host '최종 commit과 GitHub push를 실행하려면 PUSH를 입력하세요.' -ForegroundColor Yellow
    $pushInput = if ($NonInteractive) { $PushConfirmation } else { Read-Host '최종 확인' }
    if ($pushInput -cne 'PUSH') {
        Stop-Safely '최종 확인이 취소되었습니다. 버전과 staging을 실행 전 상태로 복구했습니다.' 0 -RestoreVersion -ResetStaging
    }

    Write-Section 'Commit'
    try { Invoke-GitVisible @('commit', '-m', $finalCommitMessage) }
    catch {
        Write-Host "commit 실패: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host '변경사항과 버전은 staged 상태로 유지됩니다. git status를 확인한 뒤 문제를 해결하고 다시 commit하세요.' -ForegroundColor Yellow
        exit 1
    }
    $stagedByScript = $false
    $shortCommit = Invoke-GitCapture @('rev-parse', '--short', 'HEAD')

    Write-Section 'Push'
    try { Invoke-GitVisible @('push', 'origin', 'main') }
    catch {
        Write-Host "push 실패: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "commit $shortCommit 은 로컬에 안전하게 남아 있습니다." -ForegroundColor Yellow
        Write-Host '인증 또는 네트워크 문제를 해결한 뒤 git push origin main 을 실행하세요.' -ForegroundColor Yellow
        exit 1
    }

    Write-Section 'GitHub 저장 완료'
    Write-Host "이전 버전: $oldVersion"
    Write-Host "새 버전: $newVersion"
    Write-Host "커밋: $shortCommit"
    Write-Host "커밋 메시지: $finalCommitMessage"
    Write-Host 'GitHub 저장 완료' -ForegroundColor Green
    Write-Host '직원 PC에서는 시스템 관리의 최신 업데이트로 적용할 수 있습니다.' -ForegroundColor Green
    exit 0
} catch {
    if ($versionChanged -and -not $stagedByScript) { Restore-VersionFiles }
    Write-Host "오류: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'commit과 push는 실행되지 않았습니다.' -ForegroundColor Yellow
    exit 1
}
