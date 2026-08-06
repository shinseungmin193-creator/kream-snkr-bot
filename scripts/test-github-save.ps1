param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$sourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("kream-github-save-test-" + [Guid]::NewGuid().ToString('N'))
$workRoot = Join-Path $testRoot 'work'
$remoteRoot = Join-Path $testRoot 'remote.git'
$publisherRoot = Join-Path $testRoot 'publisher'
$expectedOrigin = 'https://github.com/shinseungmin193-creator/kream-snkr-bot.git'

function Invoke-NativeResult {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
    Push-Location $WorkingDirectory
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& $FilePath @Arguments 2>&1)
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
        Pop-Location
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = (($output | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine) }
}

function Invoke-NativeChecked {
    param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory)
    $result = Invoke-NativeResult $FilePath $Arguments $WorkingDirectory
    if ($result.ExitCode -ne 0) { throw $result.Output }
    return $result.Output.Trim()
}

function Invoke-SaveTest {
    param(
        [string]$Deploy = 'DEPLOY',
        [string]$Type = 'patch',
        [string]$Message = 'test release',
        [string]$Push = 'PUSH',
        [switch]$DryRun
    )
    $saveScript = Join-Path $workRoot 'scripts\github-save.ps1'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $saveScript, '-NonInteractive', '-DeployConfirmation', $Deploy, '-VersionType', $Type, '-CommitMessage', $Message, '-PushConfirmation', $Push)
    if ($DryRun) { $arguments += '-DryRun' }
    return Invoke-NativeResult 'powershell.exe' $arguments $workRoot
}

function Assert-Test {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

try {
    New-Item -ItemType Directory -Path (Join-Path $workRoot 'scripts') -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'package.json') -Destination (Join-Path $workRoot 'package.json')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'package-lock.json') -Destination (Join-Path $workRoot 'package-lock.json')
    Copy-Item -LiteralPath (Join-Path $sourceRoot 'scripts\github-save.ps1') -Destination (Join-Path $workRoot 'scripts\github-save.ps1')
    [IO.File]::WriteAllText((Join-Path $workRoot 'app.js'), "console.log('valid');`n", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot '.gitignore'), '', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot 'base.txt'), "base`n", [Text.UTF8Encoding]::new($false))

    Invoke-NativeChecked 'git.exe' @('init', '-b', 'main') $workRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('config', 'user.name', 'KREAM BOT Test') $workRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('config', 'user.email', 'kream-bot-test@localhost') $workRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('add', '.') $workRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('commit', '-m', 'base') $workRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('init', '--bare', $remoteRoot) $testRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('remote', 'add', 'origin', $expectedOrigin) $workRoot | Out-Null
    $remoteUri = ([Uri]$remoteRoot).AbsoluteUri
    Invoke-NativeChecked 'git.exe' @('config', "url.$remoteUri.insteadOf", $expectedOrigin) $workRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('push', '-u', 'origin', 'main') $workRoot | Out-Null

    $initialHead = Invoke-NativeChecked 'git.exe' @('rev-parse', 'HEAD') $workRoot
    $wrongDeploy = Invoke-SaveTest -Deploy 'deploy'
    Assert-Test ($wrongDeploy.ExitCode -eq 2) 'DEPLOY 오입력 차단 테스트 실패'
    Assert-Test ((Invoke-NativeChecked 'git.exe' @('rev-parse', 'HEAD') $workRoot) -eq $initialHead) 'DEPLOY 오입력 후 commit이 변경됨'

    New-Item -ItemType Directory -Path (Join-Path $workRoot 'logs'),(Join-Path $workRoot 'backups'),(Join-Path $workRoot 'config'),(Join-Path $workRoot 'profile') -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $workRoot '.env'), 'KREAM_SYSTEM_ADMIN_PIN=never-upload', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot 'logs\app.log'), 'secret log', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot 'backups\test.db'), 'db', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot 'config\system-config.json'), '{"local":true}', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot 'profile\Cookies'), 'cookie', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot 'scratch.tmp'), 'temp', [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workRoot 'feature.txt'), 'safe change', [Text.UTF8Encoding]::new($false))

    $patchResult = Invoke-SaveTest -Type patch -Message 'test: patch release'
    Assert-Test ($patchResult.ExitCode -eq 0) "patch commit/push 테스트 실패:`n$($patchResult.Output)"
    $patchVersion = (Get-Content -LiteralPath (Join-Path $workRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    Assert-Test ($patchVersion -eq '1.0.1') "patch 버전 결과 오류: $patchVersion"
    $remoteTree = Invoke-NativeChecked 'git.exe' @('--git-dir', $remoteRoot, 'ls-tree', '-r', '--name-only', 'main') $testRoot
    foreach ($sensitive in @('.env','logs/app.log','backups/test.db','config/system-config.json','profile/Cookies','scratch.tmp')) {
        Assert-Test (-not (($remoteTree -split "`r?`n") -contains $sensitive)) "민감 파일이 원격 commit에 포함됨: $sensitive"
    }
    Assert-Test (($remoteTree -split "`r?`n") -contains 'feature.txt') '정상 파일이 원격 commit에 포함되지 않음'

    $noChanges = Invoke-SaveTest
    Assert-Test ($noChanges.ExitCode -eq 0 -and $noChanges.Output.Contains('저장할 변경사항이 없습니다.')) '변경사항 없음 처리 테스트 실패'

    [IO.File]::WriteAllText((Join-Path $workRoot 'choice-test.txt'), 'choice', [Text.UTF8Encoding]::new($false))
    $minorResult = Invoke-SaveTest -Type minor -DryRun
    Assert-Test ($minorResult.ExitCode -eq 0 -and $minorResult.Output.Contains('1.0.1 → 1.1.0')) 'minor 선택 테스트 실패'
    $majorResult = Invoke-SaveTest -Type major -DryRun
    Assert-Test ($majorResult.ExitCode -eq 0 -and $majorResult.Output.Contains('1.0.1 → 2.0.0')) 'major 선택 테스트 실패'
    Assert-Test (((Get-Content -LiteralPath (Join-Path $workRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version) -eq '1.0.1') 'dry-run 후 버전이 복구되지 않음'

    $headBeforeSyntax = Invoke-NativeChecked 'git.exe' @('rev-parse', 'HEAD') $workRoot
    [IO.File]::AppendAllText((Join-Path $workRoot 'app.js'), "const = ;`n", [Text.UTF8Encoding]::new($false))
    $syntaxResult = Invoke-SaveTest -Type patch
    Assert-Test ($syntaxResult.ExitCode -ne 0 -and $syntaxResult.Output.Contains('JavaScript 구문 검사 실패: app.js')) 'JavaScript 구문 오류 차단 테스트 실패'
    Assert-Test (((Get-Content -LiteralPath (Join-Path $workRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version) -eq '1.0.1') '구문 오류 후 버전이 복구되지 않음'
    Assert-Test ((Invoke-NativeChecked 'git.exe' @('rev-parse', 'HEAD') $workRoot) -eq $headBeforeSyntax) '구문 오류 후 commit이 생성됨'
    $syntaxStaged = Invoke-NativeChecked 'git.exe' @('diff', '--cached', '--name-only') $workRoot
    Assert-Test ([string]::IsNullOrWhiteSpace($syntaxStaged)) '구문 오류 후 staged 변경이 남음'

    [IO.File]::WriteAllText((Join-Path $workRoot 'app.js'), "console.log('valid');`n", [Text.UTF8Encoding]::new($false))
    Invoke-NativeChecked 'git.exe' @('clone', '-b', 'main', $remoteRoot, $publisherRoot) $testRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('config', 'user.name', 'Remote Publisher') $publisherRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('config', 'user.email', 'remote-publisher@localhost') $publisherRoot | Out-Null
    [IO.File]::WriteAllText((Join-Path $publisherRoot 'remote-change.txt'), 'remote ahead', [Text.UTF8Encoding]::new($false))
    Invoke-NativeChecked 'git.exe' @('add', 'remote-change.txt') $publisherRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('commit', '-m', 'test: remote ahead') $publisherRoot | Out-Null
    Invoke-NativeChecked 'git.exe' @('push', 'origin', 'main') $publisherRoot | Out-Null

    $headBeforeAhead = Invoke-NativeChecked 'git.exe' @('rev-parse', 'HEAD') $workRoot
    $versionBeforeAhead = (Get-Content -LiteralPath (Join-Path $workRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $aheadResult = Invoke-SaveTest -Type patch
    Assert-Test ($aheadResult.ExitCode -ne 0 -and $aheadResult.Output.Contains('원격에 먼저 받아야 할 변경사항이 있습니다.')) '원격 선행 commit 차단 테스트 실패'
    Assert-Test ((Invoke-NativeChecked 'git.exe' @('rev-parse', 'HEAD') $workRoot) -eq $headBeforeAhead) '원격 선행 차단 후 로컬 commit이 변경됨'
    Assert-Test (((Get-Content -LiteralPath (Join-Path $workRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version) -eq $versionBeforeAhead) '원격 선행 차단 후 버전이 변경됨'

    Write-Host '격리 GitHub 저장 테스트 통과: DEPLOY, no-change, patch/minor/major, 민감 파일, 구문 오류, 원격 선행, local commit/push'
} finally {
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTest.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTest).StartsWith('kream-github-save-test-')) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force -ErrorAction SilentlyContinue
    }
}
