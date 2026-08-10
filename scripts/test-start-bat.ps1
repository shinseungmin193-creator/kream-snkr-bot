[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceBat = Join-Path $projectRoot 'start.bat'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) "KREAMBOT-start-test-$([Guid]::NewGuid().ToString('N'))"
$oldSkipChrome = $env:KREAM_START_SKIP_CHROME
$oldSkipBrowser = $env:KREAM_START_SKIP_BROWSER
$oldTestBat = $env:KREAM_TEST_BAT
$mappedDrive = $null

function Write-TestFile {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function New-StartFixture {
    param([string]$Path, [switch]$WithoutNodeModules, [switch]$WithPackageLock, [switch]$WithoutPackage)
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    Copy-Item -LiteralPath $sourceBat -Destination (Join-Path $Path 'start.bat') -Force
    Write-TestFile (Join-Path $Path 'app.js') "console.log('__START_TEST_CWD__=' + process.cwd());`nconsole.log('__START_TEST_FILE__=' + __dirname);`nprocess.exit(37);`n"
    if (-not $WithoutPackage) {
        Write-TestFile (Join-Path $Path 'package.json') "{`"name`":`"kream-start-test`",`"version`":`"1.0.0`",`"private`":true}`n"
    }
    if ($WithPackageLock) {
        Write-TestFile (Join-Path $Path 'package-lock.json') "{`"name`":`"kream-start-test`",`"version`":`"1.0.0`",`"lockfileVersion`":3,`"requires`":true,`"packages`":{`"`":{`"name`":`"kream-start-test`",`"version`":`"1.0.0`"}}}`n"
    }
    if (-not $WithoutNodeModules) { New-Item -ItemType Directory -Path (Join-Path $Path 'node_modules') -Force | Out-Null }
}

function Invoke-StartFixture {
    param([string]$Path)
    $env:KREAM_TEST_BAT = Join-Path $Path 'start.bat'
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $env:ComSpec /d /c 'call "%KREAM_TEST_BAT%" <nul' 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Assert-PathCase {
    param([string]$Name, [string]$Path)
    New-StartFixture $Path
    $result = Invoke-StartFixture $Path
    if ($result.ExitCode -ne 37) { throw "$Name 실패: 종료 코드 $($result.ExitCode)`n$($result.Output)" }
    if ($result.Output -notmatch [Regex]::Escape("__START_TEST_CWD__=$Path")) { throw "$Name 실패: BAT 위치가 작업 경로로 적용되지 않았습니다.`n$($result.Output)" }
    if ($result.Output -notmatch 'Node 경로:' -or $result.Output -notmatch '포트: 3000') { throw "$Name 실패: 시작 정보 출력 누락" }
    Write-Host "[PASS] $Name -> $Path" -ForegroundColor Green
}

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$env:KREAM_START_SKIP_CHROME = '1'
$env:KREAM_START_SKIP_BROWSER = '1'
try {
    Assert-PathCase '다른 사용자명 및 Downloads ZIP 폴더' (Join-Path $testRoot 'Users\admin\Downloads\kream-snkr-bot-main (1)\kream-snkr-bot-main')
    Assert-PathCase 'Desktop 사용자 폴더' (Join-Path $testRoot 'Users\employee\Desktop\KREAM')
    Assert-PathCase '공백 포함 경로' (Join-Path $testRoot 'Company Tools\KREAM BOT')
    foreach ($candidate in @('R:', 'Q:', 'P:')) {
        if (-not (Test-Path "$candidate\")) { $mappedDrive = $candidate; break }
    }
    if (-not $mappedDrive) { throw '다른 드라이브 테스트에 사용할 빈 드라이브 문자가 없습니다.' }
    & subst.exe $mappedDrive $testRoot
    if ($LASTEXITCODE -ne 0) { throw "테스트 드라이브 매핑 실패: $mappedDrive" }
    Assert-PathCase '다른 드라이브 경로' "$mappedDrive\tools\kream"

    $npmInstallPath = Join-Path $testRoot 'npm install case'
    New-StartFixture $npmInstallPath -WithoutNodeModules
    $npmInstall = Invoke-StartFixture $npmInstallPath
    if ($npmInstall.ExitCode -ne 37 -or $npmInstall.Output -notmatch 'npm install') { throw "npm install 분기 실패`n$($npmInstall.Output)" }
    Write-Host '[PASS] node_modules 없음 + package-lock 없음 -> npm install' -ForegroundColor Green

    $npmCiPath = Join-Path $testRoot 'npm ci (locked)'
    New-StartFixture $npmCiPath -WithoutNodeModules -WithPackageLock
    $npmCi = Invoke-StartFixture $npmCiPath
    if ($npmCi.ExitCode -ne 37 -or $npmCi.Output -notmatch 'npm ci') { throw "npm ci 분기 실패`n$($npmCi.Output)" }
    Write-Host '[PASS] node_modules 없음 + package-lock 있음 -> npm ci' -ForegroundColor Green

    $missingPackagePath = Join-Path $testRoot 'missing package'
    New-StartFixture $missingPackagePath -WithoutPackage
    $missingPackage = Invoke-StartFixture $missingPackagePath
    if ($missingPackage.ExitCode -ne 1 -or $missingPackage.Output -notmatch 'package.json') { throw "필수 파일 오류 분기 실패`n$($missingPackage.Output)" }
    Write-Host '[PASS] package.json 누락 오류 및 종료 전 pause' -ForegroundColor Green

    Write-Host 'start.bat 이동 경로 테스트 완료' -ForegroundColor Cyan
} finally {
    $env:KREAM_START_SKIP_CHROME = $oldSkipChrome
    $env:KREAM_START_SKIP_BROWSER = $oldSkipBrowser
    $env:KREAM_TEST_BAT = $oldTestBat
    if ($mappedDrive) { & subst.exe $mappedDrive /D 2>$null }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $resolved = [IO.Path]::GetFullPath($testRoot)
    if ($resolved.StartsWith("$tempRoot\KREAMBOT-start-test-", [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
