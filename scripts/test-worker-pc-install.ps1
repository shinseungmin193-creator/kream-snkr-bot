[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repositoryUrl = 'https://github.com/shinseungmin193-creator/kream-snkr-bot.git'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$installer = Join-Path $projectRoot 'scripts\install-worker-pc.ps1'
$uninstaller = Join-Path $projectRoot 'scripts\uninstall-worker-pc.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "KREAMBOT-worker-install-test-$([Guid]::NewGuid().ToString('N'))"
$sourceRepository = Join-Path $testRoot 'source'
$bareRepository = Join-Path $testRoot 'remote.git'
$installRoot = Join-Path $testRoot 'worker'
$emptyInstallRoot = Join-Path $testRoot 'empty worker'
$preservedInstallRoot = Join-Path $testRoot 'preserved worker'
$quotedInstallRoot = Join-Path $testRoot 'quoted worker'
$trailingInstallRoot = Join-Path $testRoot 'trailing worker'
$programFilesAssets = Join-Path $testRoot 'Program Files\KREAM BOT Installer\installer-assets'
$bootstrapInstallRoot = Join-Path $testRoot 'bootstrap worker'
$results = [Collections.Generic.List[object]]::new()

function Add-TestResult {
    param([string]$Name, [bool]$Passed, [string]$Detail = '')
    $results.Add([pscustomobject]@{ Name = $Name; Passed = $Passed; Detail = $Detail })
    $color = if ($Passed) { 'Green' } else { 'Red' }
    $label = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Host "[$label] $Name$(if ($Detail) { ": $Detail" })" -ForegroundColor $color
    if (-not $Passed) { throw "테스트 실패: $Name - $Detail" }
}

function Write-Utf8File {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Invoke-Git {
    param([string]$WorkingDirectory, [string[]]$Arguments, [switch]$ReturnOutput)
    Push-Location $WorkingDirectory
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git.exe @Arguments 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') 실패`n$output" }
        if ($ReturnOutput) { return $output.Trim() }
    } finally {
        $ErrorActionPreference = $previousPreference
        Pop-Location
    }
}

function Invoke-WorkerScript {
    param([string]$ScriptPath, [string[]]$Arguments)
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath @Arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Get-FileSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Initialize-FixtureRepository {
    New-Item -ItemType Directory -Path $sourceRepository -Force | Out-Null
    Write-Utf8File (Join-Path $sourceRepository '.gitignore') @'
node_modules/
data/
logs/
backups/
chrome-profile/
config/system-config.json
KREAM_로그인_Chrome.bat
'@
    Write-Utf8File (Join-Path $sourceRepository 'app.js') @'
const http = require('http');
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(3000);
'@
    Write-Utf8File (Join-Path $sourceRepository 'package.json') @'
{
  "name": "kream-worker-install-fixture",
  "version": "1.2.3",
  "private": true
}
'@
    Write-Utf8File (Join-Path $sourceRepository 'package-lock.json') @'
{
  "name": "kream-worker-install-fixture",
  "version": "1.2.3",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "kream-worker-install-fixture",
      "version": "1.2.3"
    }
  }
}
'@
    Write-Utf8File (Join-Path $sourceRepository 'config\system-config.example.json') '{"nssmPath":"C:\\Tools\\nssm\\nssm.exe"}'
    Write-Utf8File (Join-Path $sourceRepository 'tools\nssm\win64\nssm.exe') 'test-only NSSM placeholder'

    $null = Invoke-Git $sourceRepository @('init', '--initial-branch=main', '.') -ReturnOutput
    Invoke-Git $sourceRepository @('config', 'user.name', 'KREAM Install Test')
    Invoke-Git $sourceRepository @('config', 'user.email', 'install-test@example.invalid')
    Invoke-Git $sourceRepository @('add', '.')
    Invoke-Git $sourceRepository @('commit', '-m', 'fixture: initial')
    $null = Invoke-Git $testRoot @('clone', '--bare', $sourceRepository, $bareRepository) -ReturnOutput
}

function Set-LocalUrlRewrite {
    $bareUri = ([Uri]::new($bareRepository)).AbsoluteUri
    if (-not $bareUri.EndsWith('/')) { $bareUri += '/' }
    $env:GIT_CONFIG_COUNT = '2'
    $env:GIT_CONFIG_KEY_0 = "url.$bareUri.insteadOf"
    $env:GIT_CONFIG_VALUE_0 = $repositoryUrl
    $env:GIT_CONFIG_KEY_1 = 'protocol.file.allow'
    $env:GIT_CONFIG_VALUE_1 = 'always'
    $env:KREAM_WORKER_TEST_ORIGIN = $bareUri.TrimEnd('/')
}

function Remove-TestRootSafely {
    if (-not (Test-Path -LiteralPath $testRoot)) { return }
    $resolved = [IO.Path]::GetFullPath($testRoot)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $resolved.StartsWith("$tempRoot\KREAMBOT-worker-install-test-", [StringComparison]::OrdinalIgnoreCase)) {
        throw "테스트 임시 경로 삭제 차단: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

$oldGitConfigCount = $env:GIT_CONFIG_COUNT
$oldGitConfigKey0 = $env:GIT_CONFIG_KEY_0
$oldGitConfigValue0 = $env:GIT_CONFIG_VALUE_0
$oldGitConfigKey1 = $env:GIT_CONFIG_KEY_1
$oldGitConfigValue1 = $env:GIT_CONFIG_VALUE_1
$oldTestOrigin = $env:KREAM_WORKER_TEST_ORIGIN

try {
    Initialize-FixtureRepository
    Set-LocalUrlRewrite

    $first = Invoke-WorkerScript $installer @(
        '-InstallPath', $installRoot, '-TestMode', '-ChromeInstallChoice', 'No',
        '-SimulateMissingTool', 'Chrome'
    )
    if ($first.ExitCode -ne 0) { Write-Host $first.Output -ForegroundColor Yellow }
    Add-TestResult '신규 직원 PC 설치' ($first.ExitCode -eq 0) $first.Output.Trim().Split("`n")[-1]
    Add-TestResult '격리 origin 주소 유지' ((Invoke-Git $installRoot @('remote', 'get-url', 'origin') -ReturnOutput).TrimEnd('/') -eq $env:KREAM_WORKER_TEST_ORIGIN)
    Add-TestResult 'main 브랜치 유지' ((Invoke-Git $installRoot @('branch', '--show-current') -ReturnOutput) -eq 'main')
    Add-TestResult 'npm ci 실행' ($first.Output -match 'npm ci')
    Add-TestResult 'KREAMBOT 서비스 모의 Running/Auto 검증' ($first.Output -match 'Running \(simulated\).+Auto \(simulated\)')
    Add-TestResult '방화벽 규칙 모의 검증' ($first.Output -match '방화벽 규칙 검증 완료')
    Add-TestResult 'CDP 9222 실행 BAT 생성' ((Get-Content -LiteralPath (Join-Path $installRoot 'KREAM_로그인_Chrome.bat') -Raw -Encoding UTF8) -match 'remote-debugging-port=9222')
    Add-TestResult 'Chrome 전용 프로필 경로 적용' ((Get-Content -LiteralPath (Join-Path $installRoot 'KREAM_로그인_Chrome.bat') -Raw -Encoding UTF8) -match [Regex]::Escape((Join-Path $installRoot 'chrome-profile')))
    Add-TestResult '직원 PC pushurl 차단' ((Invoke-Git $installRoot @('remote', 'get-url', '--push', 'origin') -ReturnOutput) -eq 'disabled://worker-pc-push-blocked')
    Add-TestResult 'pre-push 훅 차단' (Test-Path -LiteralPath (Join-Path $installRoot '.git\hooks\pre-push'))

    New-Item -ItemType Directory -Path $emptyInstallRoot -Force | Out-Null
    $emptyInstall = Invoke-WorkerScript $installer @('-InstallPath', $emptyInstallRoot, '-TestMode', '-ChromeInstallChoice', 'No')
    Add-TestResult '빈 C:\KREAMBOT 대응 설치' ($emptyInstall.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $emptyInstallRoot '.git')))

    New-Item -ItemType Directory -Path (Join-Path $preservedInstallRoot 'data'), (Join-Path $preservedInstallRoot 'logs') -Force | Out-Null
    Write-Utf8File (Join-Path $preservedInstallRoot 'data\preserved.test') 'preserve me'
    $preservedInstall = Invoke-WorkerScript $installer @('-InstallPath', $preservedInstallRoot, '-TestMode', '-ChromeInstallChoice', 'No')
    Add-TestResult 'data/logs만 존재하는 재설치' ($preservedInstall.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $preservedInstallRoot 'data\preserved.test')))

    $quotedValue = '"' + $quotedInstallRoot + '"'
    $sourceRootWithSpaces = '"' + (Join-Path $testRoot 'Source Root With Spaces') + '"'
    $quotedInstall = Invoke-WorkerScript $installer @('-InstallPath', $quotedValue, '-SourceRoot', $sourceRootWithSpaces, '-TestMode', '-ChromeInstallChoice', 'No')
    Add-TestResult '따옴표/공백 SourceRoot' ($quotedInstall.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $quotedInstallRoot '.git'))) $(if ($quotedInstall.ExitCode -ne 0) { $quotedInstall.Output.Trim() } else { 'PowerShell 5.1 인수 전달 성공' })
    $trailingInstall = Invoke-WorkerScript $installer @('-TestMode', '-ChromeInstallChoice', 'No', '-InstallPath', ($trailingInstallRoot + '\'))
    Add-TestResult '후행 백슬래시 설치 경로' ($trailingInstall.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $trailingInstallRoot '.git'))) $(if ($trailingInstall.ExitCode -ne 0) { $trailingInstall.Output.Trim() } else { '정규화 성공' })

    New-Item -ItemType Directory -Path $programFilesAssets -Force | Out-Null
    $bootstrapCopy = Join-Path $programFilesAssets 'install-bootstrap.ps1'
    $workerCopy = Join-Path $programFilesAssets 'install-worker-pc.ps1'
    Copy-Item -LiteralPath (Join-Path $projectRoot 'installer\install-bootstrap.ps1') -Destination $bootstrapCopy -Force
    Copy-Item -LiteralPath $installer -Destination $workerCopy -Force
    $bootstrapLatest = Invoke-WorkerScript $bootstrapCopy @('-InstallPath', $bootstrapInstallRoot, '-WorkerScript', $workerCopy, '-ReinstallMode', 'Latest', '-TestMode')
    Add-TestResult 'Program Files 경로 WorkerScript + Latest' ($bootstrapLatest.ExitCode -eq 0 -and $bootstrapLatest.Output -match [Regex]::Escape("WorkerScript: $workerCopy"))
    Add-TestResult '실제 bootstrap installer-assets를 SourceRoot로 미전달' ($bootstrapLatest.Output -notmatch 'SourceRoot')
    $bootstrapRepair = Invoke-WorkerScript $bootstrapCopy @('-InstallPath', $bootstrapInstallRoot, '-WorkerScript', $workerCopy, '-ReinstallMode', 'Repair', '-TestMode')
    Add-TestResult 'Program Files 경로 WorkerScript + Repair' ($bootstrapRepair.ExitCode -eq 0 -and $bootstrapRepair.Output -match 'ReinstallMode: Repair')

    $dbPath = Join-Path $installRoot 'data\kream-bot.db'
    $settingsPath = Join-Path $installRoot 'data\system-settings.json'
    $profileState = Join-Path $installRoot 'chrome-profile\Login Data.test'
    Write-Utf8File $dbPath 'worker database sentinel'
    Write-Utf8File $settingsPath '{"backupRetention":30}'
    Write-Utf8File $profileState 'worker chrome profile sentinel'
    $beforeHashes = @{
        Db = Get-FileSha256 $dbPath
        Settings = Get-FileSha256 $settingsPath
        Profile = Get-FileSha256 $profileState
        Config = Get-FileSha256 (Join-Path $installRoot 'config\system-config.json')
    }

    $reinstall = Invoke-WorkerScript $installer @(
        '-InstallPath', $installRoot, '-TestMode', '-ChromeInstallChoice', 'No', '-SimulateExistingService'
    )
    Add-TestResult '재설치 성공' ($reinstall.ExitCode -eq 0)
    Add-TestResult '기존 서비스 갱신 분기' ($reinstall.Output -match '기존 서비스 설정 갱신')
    Add-TestResult 'DB 재설치 보존' ((Get-FileSha256 $dbPath) -eq $beforeHashes.Db)
    Add-TestResult '설정 재설치 보존' ((Get-FileSha256 $settingsPath) -eq $beforeHashes.Settings -and (Get-FileSha256 (Join-Path $installRoot 'config\system-config.json')) -eq $beforeHashes.Config)
    Add-TestResult 'Chrome 프로필 재설치 보존' ((Get-FileSha256 $profileState) -eq $beforeHashes.Profile)

    Write-Utf8File (Join-Path $sourceRepository 'release.txt') 'remote update applied'
    Invoke-Git $sourceRepository @('add', 'release.txt')
    Invoke-Git $sourceRepository @('commit', '-m', 'fixture: remote update')
    Invoke-Git $sourceRepository @('push', $bareRepository, 'main')
    $update = Invoke-WorkerScript $installer @('-InstallPath', $installRoot, '-TestMode', '-ChromeInstallChoice', 'No')
    Add-TestResult 'origin/main pull 업데이트' ($update.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $installRoot 'release.txt')))

    Add-Content -LiteralPath (Join-Path $installRoot 'app.js') -Value '// local change' -Encoding UTF8
    $dirty = Invoke-WorkerScript $installer @('-InstallPath', $installRoot, '-TestMode', '-ChromeInstallChoice', 'No')
    Add-TestResult '로컬 변경 시 pull 차단' ($dirty.ExitCode -ne 0 -and $dirty.Output -match '로컬 변경사항')
    Invoke-Git $installRoot @('restore', 'app.js')

    $missingGit = Invoke-WorkerScript $installer @('-InstallPath', (Join-Path $testRoot 'missing-git'), '-TestMode', '-ChromeInstallChoice', 'No', '-SimulateMissingTool', 'Git')
    Add-TestResult 'Git 없음 winget 자동 설치 경로' ($missingGit.ExitCode -eq 0 -and $missingGit.Output -match 'winget install --id Git.Git')
    $missingNode = Invoke-WorkerScript $installer @('-InstallPath', (Join-Path $testRoot 'missing-node'), '-TestMode', '-ChromeInstallChoice', 'No', '-SimulateMissingTool', 'Node')
    Add-TestResult 'Node.js 없음 winget 자동 설치 경로' ($missingNode.ExitCode -eq 0 -and $missingNode.Output -match 'winget install --id OpenJS.NodeJS.LTS')
    $missingChrome = Invoke-WorkerScript $installer @('-InstallPath', (Join-Path $testRoot 'missing-chrome'), '-TestMode', '-ChromeInstallChoice', 'Yes', '-SimulateMissingTool', 'Chrome')
    Add-TestResult 'Chrome 사용자 동의 후 winget 설치 경로' ($missingChrome.ExitCode -eq 0 -and $missingChrome.Output -match 'winget install --id Google.Chrome')
    $missingWinget = Invoke-WorkerScript $installer @('-InstallPath', (Join-Path $testRoot 'missing-winget'), '-TestMode', '-ChromeInstallChoice', 'No', '-SimulateMissingTool', 'Git', '-SimulateWingetUnavailable')
    Add-TestResult 'winget 없음 공식 다운로드 안내' ($missingWinget.ExitCode -ne 0 -and $missingWinget.Output -match 'git-scm.com/download/win')
    $missingNssm = Invoke-WorkerScript $installer @('-InstallPath', (Join-Path $testRoot 'missing-nssm'), '-TestMode', '-ChromeInstallChoice', 'No', '-SimulateMissingTool', 'Nssm')
    Add-TestResult 'NSSM 없음 안전 차단' ($missingNssm.ExitCode -ne 0 -and $missingNssm.Output -match 'NSSM 없음')

    $basicUninstall = Invoke-WorkerScript $uninstaller @('-InstallPath', $installRoot, '-TestMode', '-SimulateExistingService')
    Add-TestResult '기본 제거 성공' ($basicUninstall.ExitCode -eq 0)
    Add-TestResult '기본 제거 DB/설정/로그인 프로필 보존' ((Test-Path -LiteralPath $dbPath) -and (Test-Path -LiteralPath $settingsPath) -and (Test-Path -LiteralPath $profileState))
    Add-TestResult '기본 제거 Chrome 실행 BAT 제거' (-not (Test-Path -LiteralPath (Join-Path $installRoot 'KREAM_로그인_Chrome.bat')))
    Add-TestResult '기본 제거 프로그램 파일 제거' (-not (Test-Path -LiteralPath (Join-Path $installRoot 'app.js')) -and -not (Test-Path -LiteralPath (Join-Path $installRoot '.git')))

    $repair = Invoke-WorkerScript $installer @('-InstallPath', $installRoot, '-TestMode', '-ChromeInstallChoice', 'No')
    Add-TestResult '기본 제거 후 재설치 복구' ($repair.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $installRoot 'KREAM_로그인_Chrome.bat')))
    Add-TestResult '보존 데이터 위에 Git 저장소 복구' (Test-Path -LiteralPath (Join-Path $installRoot '.git'))

    $guard = Invoke-WorkerScript $uninstaller @('-InstallPath', $installRoot, '-TestMode', '-DeleteAllData', '-Confirmation', 'delete all data')
    Add-TestResult 'DELETE ALL DATA 대소문자/정확 입력 보호' ($guard.ExitCode -ne 0 -and (Test-Path -LiteralPath $installRoot))

    $fullDelete = Invoke-WorkerScript $uninstaller @('-InstallPath', $installRoot, '-TestMode', '-DeleteAllData', '-Confirmation', 'DELETE ALL DATA')
    Add-TestResult '정확한 전체 삭제 확인' ($fullDelete.ExitCode -eq 0 -and -not (Test-Path -LiteralPath $installRoot))

    Write-Host ''
    Write-Host "직원 PC 설치 자동화 격리 테스트 완료: $($results.Count)개 통과" -ForegroundColor Green
    $results | Format-Table -AutoSize
    exit 0
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $results | Format-Table -AutoSize
    exit 1
} finally {
    $env:GIT_CONFIG_COUNT = $oldGitConfigCount
    $env:GIT_CONFIG_KEY_0 = $oldGitConfigKey0
    $env:GIT_CONFIG_VALUE_0 = $oldGitConfigValue0
    $env:GIT_CONFIG_KEY_1 = $oldGitConfigKey1
    $env:GIT_CONFIG_VALUE_1 = $oldGitConfigValue1
    $env:KREAM_WORKER_TEST_ORIGIN = $oldTestOrigin
    Remove-TestRootSafely
}
