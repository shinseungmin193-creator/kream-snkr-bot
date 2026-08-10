[CmdletBinding()]
param([switch]$RequireBuiltExe)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$iss = Get-Content -LiteralPath (Join-Path $projectRoot 'installer\KREAMBOT.iss') -Raw -Encoding UTF8
$bootstrap = Get-Content -LiteralPath (Join-Path $projectRoot 'installer\install-bootstrap.ps1') -Raw -Encoding UTF8
$installer = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts\install-worker-pc.ps1') -Raw -Encoding UTF8
$uninstaller = Get-Content -LiteralPath (Join-Path $projectRoot 'scripts\uninstall-worker-pc.ps1') -Raw -Encoding UTF8

$checks = [ordered]@{
    'Inno Setup 소스' = $iss.Contains('[Setup]') -and $iss.Contains('PrivilegesRequired=admin')
    '고정 설치 경로' = $iss.Contains('C:\KREAMBOT')
    'Bootstrap 포함' = $iss.Contains('install-bootstrap.ps1') -and $iss.Contains('AfterInstall: RunBootstrap')
    '설치 실패 차단' = $iss.Contains('ResultCode <> 0') -and $iss.Contains('installer.log')
    '완료 작업 2개' = $iss.Contains('KREAM 로그인 Chrome 실행') -and $iss.Contains('KREAM BOT 열기')
    'Windows 제거 등록' = $iss.Contains('Uninstallable=yes') -and $iss.Contains('RunUninstallWorker')
    '재설치 선택' = $iss.Contains('복구 - 현재 소스를 유지') -and $iss.Contains('최신 버전 재설치')
    'Git 공식 폴백' = $bootstrap.Contains('api.github.com/repos/git-for-windows/git/releases/latest')
    'Node 공식 폴백' = $bootstrap.Contains('https://nodejs.org/dist/index.json')
    'Chrome 공식 폴백' = $bootstrap.Contains('googlechromestandaloneenterprise64.msi')
    'NSSM 고정 경로' = $installer.Contains('tools\nssm\$architecture\nssm.exe')
    '서비스 재시작 5000ms' = $installer.Contains("@('AppRestartDelay', '5000')")
    '운영 데이터 보존 제거' = $uninstaller.Contains('Remove-ApplicationFilesPreservingData')
    '직원 push 차단 유지' = $installer.Contains('disabled://worker-pc-push-blocked')
}

foreach ($entry in $checks.GetEnumerator()) {
    if (-not $entry.Value) { throw "설치 프로그램 정적 검사 실패: $($entry.Key)" }
    Write-Host "[PASS] $($entry.Key)" -ForegroundColor Green
}

if ($RequireBuiltExe) {
    foreach ($name in @('KREAMBOT_Setup.exe', "KREAMBOT_Setup_v$($package.version).exe")) {
        $path = Join-Path $projectRoot "dist\$name"
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "빌드 결과가 없습니다: $path" }
        $file = Get-Item -LiteralPath $path
        if ($file.Length -lt 1MB) { throw "빌드 결과 크기가 비정상적입니다: $path" }
        Write-Host "[PASS] $name ($([Math]::Round($file.Length / 1MB, 2)) MB)" -ForegroundColor Green
    }
}

Write-Host "KREAM BOT 설치 프로그램 검사 완료: version $($package.version)" -ForegroundColor Cyan
