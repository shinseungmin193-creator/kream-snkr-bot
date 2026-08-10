[CmdletBinding()]
param([switch]$SkipCompilerInstall)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$packagePath = Join-Path $projectRoot 'package.json'
$issPath = Join-Path $projectRoot 'installer\KREAMBOT.iss'
$distPath = Join-Path $projectRoot 'dist'

function Find-InnoCompiler {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @(
        $(if ($command) { $command.Source }),
        $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe' }),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe' })
    ) | Where-Object { $_ }
    return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Install-InnoCompiler {
    Write-Host 'Inno Setup 6 컴파일러가 없어 최초 1회 설치합니다.' -ForegroundColor Yellow
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($winget) {
        & $winget.Source install --id JRSoftware.InnoSetup --exact --silent --scope user --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -eq 0) { return }
        Write-Host 'winget 설치가 완료되지 않아 공식 설치 파일로 재시도합니다.' -ForegroundColor Yellow
    }

    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "KREAMBOT-inno-$([Guid]::NewGuid().ToString('N'))"
    $installerPath = Join-Path $temporaryDirectory 'innosetup.exe'
    try {
        New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
        Invoke-WebRequest -UseBasicParsing -Uri 'https://jrsoftware.org/download.php/is.exe' -OutFile $installerPath -TimeoutSec 300
        $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
        if ($signature.Status -ne 'Valid') {
            throw "Inno Setup 공식 설치 파일의 디지털 서명을 검증하지 못했습니다: $($signature.Status)"
        }
        $process = Start-Process -FilePath $installerPath -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER') -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Inno Setup 설치 실패 (종료 코드 $($process.ExitCode))" }
    } finally {
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        $resolved = [IO.Path]::GetFullPath($temporaryDirectory)
        if ($resolved.StartsWith("$tempRoot\KREAMBOT-inno-", [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { throw "package.json을 찾을 수 없습니다: $packagePath" }
if (-not (Test-Path -LiteralPath $issPath -PathType Leaf)) { throw "Inno Setup 소스를 찾을 수 없습니다: $issPath" }
$package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "package.json version 형식이 올바르지 않습니다: $version" }

$compiler = Find-InnoCompiler
if (-not $compiler) {
    if ($SkipCompilerInstall) { throw 'Inno Setup 6 컴파일러가 설치되어 있지 않습니다.' }
    Install-InnoCompiler
    $compiler = Find-InnoCompiler
}
if (-not $compiler) { throw 'Inno Setup 설치 후에도 ISCC.exe를 찾지 못했습니다.' }

New-Item -ItemType Directory -Path $distPath -Force | Out-Null
$versionedName = "KREAMBOT_Setup_v$version.exe"
$versionedPath = Join-Path $distPath $versionedName
$releasePath = Join-Path $distPath 'KREAMBOT_Setup.exe'

Write-Host "KREAM BOT $version 설치 파일을 빌드합니다." -ForegroundColor Cyan
Write-Host "Inno Setup: $compiler"
& $compiler "/DAppVersion=$version" $issPath
if ($LASTEXITCODE -ne 0) { throw "Inno Setup 컴파일 실패 (종료 코드 $LASTEXITCODE)" }
if (-not (Test-Path -LiteralPath $versionedPath -PathType Leaf)) { throw "버전 설치 파일이 생성되지 않았습니다: $versionedPath" }

Copy-Item -LiteralPath $versionedPath -Destination $releasePath -Force
$file = Get-Item -LiteralPath $releasePath
if ($file.Length -lt 1MB) { throw "생성된 설치 파일 크기가 비정상적으로 작습니다: $($file.Length) bytes" }
$hash = (Get-FileHash -LiteralPath $releasePath -Algorithm SHA256).Hash

Write-Host ''
Write-Host '================ 설치 파일 생성 완료 ================' -ForegroundColor Green
Write-Host "버전       : $version"
Write-Host "배포 파일  : $releasePath"
Write-Host "버전 파일  : $versionedPath"
Write-Host "크기       : $([Math]::Round($file.Length / 1MB, 2)) MB"
Write-Host "SHA256     : $hash"
