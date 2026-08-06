param()

. (Join-Path $PSScriptRoot 'common.ps1')
Assert-KreamAdministrator
$sourceRoot = Get-KreamProjectRoot
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("kream-update-test-" + [Guid]::NewGuid().ToString('N'))
$workRoot = Join-Path $testRoot 'work'
$remoteRoot = Join-Path $testRoot 'remote.git'
$publisherRoot = Join-Path $testRoot 'publisher'

function Invoke-TestCommand {
    param([string]$FilePath, [string[]]$CommandArguments, [string]$WorkingDirectory)
    Push-Location $WorkingDirectory
    try {
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $output = & $FilePath @CommandArguments 2>&1 | Out-String
            $exitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousPreference }
        if ($exitCode -ne 0) { throw $output.Trim() }
        return $output.Trim()
    } finally { Pop-Location }
}

try {
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    foreach ($file in @('.gitignore','app.js','database.js','inventory.js','compareAll.js','filterTargets.js','package.json','package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $file) -Destination (Join-Path $workRoot $file) -Force
    }
    foreach ($directory in @('public','system','scripts')) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot $directory) -Destination (Join-Path $workRoot $directory) -Recurse -Force
    }

    Invoke-TestCommand 'git.exe' @('init', '-b', 'main') $workRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('config', 'user.name', 'KREAM BOT Test') $workRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('config', 'user.email', 'kream-bot-test@localhost') $workRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('add', '.') $workRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('commit', '-m', 'base') $workRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('init', '--bare', $remoteRoot) $testRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('remote', 'add', 'origin', $remoteRoot) $workRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('push', '-u', 'origin', 'main') $workRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('clone', '-b', 'main', $remoteRoot, $publisherRoot) $testRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('config', 'user.name', 'KREAM BOT Test') $publisherRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('config', 'user.email', 'kream-bot-test@localhost') $publisherRoot | Out-Null

    Set-Content -LiteralPath (Join-Path $publisherRoot 'update-marker.txt') -Value 'safe update' -Encoding UTF8
    Invoke-TestCommand 'git.exe' @('add', 'update-marker.txt') $publisherRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('commit', '-m', 'safe test update') $publisherRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('push', 'origin', 'main') $publisherRoot | Out-Null
    $updateScript = Join-Path $workRoot 'scripts\update.ps1'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updateScript -Mode Manual
    if ($LASTEXITCODE -ne 0) { throw '격리 저장소의 정상 업데이트 테스트가 실패했습니다.' }
    if (-not (Test-Path -LiteralPath (Join-Path $workRoot 'update-marker.txt'))) { throw '업데이트된 파일이 작업 저장소에 반영되지 않았습니다.' }

    $rollbackTarget = (Invoke-TestCommand 'git.exe' @('rev-parse', 'HEAD') $workRoot).Trim()
    Add-Content -LiteralPath (Join-Path $publisherRoot 'app.js') -Value "`nconst = ;" -Encoding UTF8
    Invoke-TestCommand 'git.exe' @('add', 'app.js') $publisherRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('commit', '-m', 'invalid syntax rollback test') $publisherRoot | Out-Null
    Invoke-TestCommand 'git.exe' @('push', 'origin', 'main') $publisherRoot | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updateScript -Mode Manual
    if ($LASTEXITCODE -eq 0) { throw '구문 오류 업데이트가 성공으로 처리되었습니다.' }
    $afterRollback = (Invoke-TestCommand 'git.exe' @('rev-parse', 'HEAD') $workRoot).Trim()
    if ($afterRollback -ne $rollbackTarget) { throw '실패한 업데이트가 이전 커밋으로 롤백되지 않았습니다.' }
    & (Get-KreamNodePath) --check (Join-Path $workRoot 'app.js')
    if ($LASTEXITCODE -ne 0) { throw '롤백 후 app.js 구문 검사가 실패했습니다.' }
    $history = Get-Content -LiteralPath (Join-Path $workRoot 'data\update-history.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $history[0].rolledBack -or $history[0].success) { throw '롤백 결과가 업데이트 기록에 올바르게 저장되지 않았습니다.' }
    Write-Host '격리 Git 업데이트 및 실패 롤백 테스트 통과'
} finally {
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $resolvedTest = [IO.Path]::GetFullPath($testRoot)
    if ($resolvedTest.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTest).StartsWith('kream-update-test-')) {
        Remove-Item -LiteralPath $resolvedTest -Recurse -Force -ErrorAction SilentlyContinue
    }
}
