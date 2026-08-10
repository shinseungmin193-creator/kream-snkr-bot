[CmdletBinding()]
param(
    [string]$InstallPath = 'C:\KREAMBOT',
    [ValidateSet('Latest','Repair')][string]$ReinstallMode = 'Latest',
    [string]$WorkerScript = $(Join-Path $PSScriptRoot '..\scripts\install-worker-pc.ps1'),
    [switch]$TestMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:CurrentStage = '설치 준비'
$script:TempRoot = Join-Path ([IO.Path]::GetTempPath()) "KREAMBOT-installer-$([Guid]::NewGuid().ToString('N'))"
$script:TempLog = Join-Path $script:TempRoot 'installer.log'
$script:FinalLog = Join-Path $InstallPath 'logs\installer.log'

function Write-InstallerLine {
    param([string]$Message, [ValidateSet('INFO','OK','WARN','ERROR')][string]$Level = 'INFO')
    $line = "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] [$Level] [$($script:CurrentStage)] $Message"
    Write-Host $line
    Add-Content -LiteralPath $script:TempLog -Value $line -Encoding UTF8
}

function Set-InstallerStage {
    param([string]$Name)
    $script:CurrentStage = $Name
    Write-InstallerLine $Name
}

function Publish-InstallerLog {
    try {
        $logDirectory = Split-Path -Parent $script:FinalLog
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        if (Test-Path -LiteralPath $script:TempLog -PathType Leaf) {
            Add-Content -LiteralPath $script:FinalLog -Value (Get-Content -LiteralPath $script:TempLog -Raw -Encoding UTF8) -Encoding UTF8
        }
    } catch {
        Write-Host "설치 로그 저장 실패: $($_.Exception.Message)"
    }
}

function Refresh-InstallerPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machinePath, $userPath) -join ';'
}

function Find-InstalledExecutable {
    param([string]$CommandName, [string[]]$KnownPaths)
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1
    $candidates = @($(if ($command) { $command.Source }), $KnownPaths) | Where-Object { $_ }
    return $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

function Invoke-InstallerProcess {
    param([string]$FilePath, [string[]]$Arguments, [string]$Description)
    Write-InstallerLine "$Description 실행"
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -notin @(0, 3010)) { throw "$Description 실패 (종료 코드 $($process.ExitCode))" }
    if ($process.ExitCode -eq 3010) { Write-InstallerLine "$Description 완료: Windows 재시작 권장" 'WARN' }
}

function Try-WingetInstall {
    param([string]$PackageId, [string]$DisplayName)
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) {
        Write-InstallerLine "winget 없음: $DisplayName 공식 설치 파일로 전환" 'WARN'
        return $false
    }
    try {
        Write-InstallerLine "winget으로 $DisplayName 설치 시도"
        & $winget.Source install --id $PackageId --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity 2>&1 |
            ForEach-Object { Write-InstallerLine ([string]$_) }
        if ($LASTEXITCODE -eq 0) { Refresh-InstallerPath; return $true }
        Write-InstallerLine "winget 설치 종료 코드 ${LASTEXITCODE}: 공식 설치 파일로 재시도" 'WARN'
    } catch {
        Write-InstallerLine "winget 설치 오류: $($_.Exception.Message)" 'WARN'
    }
    return $false
}

function Install-GitOfficial {
    $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'KREAMBOT-Installer' } -TimeoutSec 60
    $asset = $release.assets | Where-Object { $_.name -match '^Git-[0-9.]+-64-bit\.exe$' } | Select-Object -First 1
    if (-not $asset) { throw 'Git for Windows 공식 설치 파일을 찾지 못했습니다.' }
    $installer = Join-Path $script:TempRoot 'git-installer.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $installer -TimeoutSec 300
    Invoke-InstallerProcess $installer @('/VERYSILENT', '/NORESTART', '/SP-') 'Git for Windows 공식 설치'
}

function Install-NodeOfficial {
    $releases = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
    $release = $releases | Where-Object { $_.lts -and ($_.files -contains 'win-x64-msi') } | Select-Object -First 1
    if (-not $release) { throw 'Node.js LTS 공식 MSI 정보를 찾지 못했습니다.' }
    $version = [string]$release.version
    $installer = Join-Path $script:TempRoot 'node-lts.msi'
    $url = "https://nodejs.org/dist/$version/node-$version-x64.msi"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $installer -TimeoutSec 300
    Invoke-InstallerProcess 'msiexec.exe' @('/i', "`"$installer`"", '/qn', '/norestart') 'Node.js LTS 공식 설치'
}

function Install-ChromeOfficial {
    $installer = Join-Path $script:TempRoot 'chrome-enterprise.msi'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' -OutFile $installer -TimeoutSec 300
    Invoke-InstallerProcess 'msiexec.exe' @('/i', "`"$installer`"", '/qn', '/norestart') 'Google Chrome 공식 설치'
}

function Ensure-Git {
    Set-InstallerStage 'Git 확인'
    $known = @((Join-Path $env:ProgramFiles 'Git\cmd\git.exe'), (Join-Path $env:ProgramFiles 'Git\bin\git.exe'))
    $git = Find-InstalledExecutable 'git.exe' $known
    if (-not $git) {
        $wingetInstalled = Try-WingetInstall 'Git.Git' 'Git'
        Refresh-InstallerPath
        $git = Find-InstalledExecutable 'git.exe' $known
        if (-not $git) {
            if ($wingetInstalled) { Write-InstallerLine 'winget 설치 후 Git 검증에 실패해 공식 설치 파일로 재시도합니다.' 'WARN' }
            Install-GitOfficial
            Refresh-InstallerPath
            $git = Find-InstalledExecutable 'git.exe' $known
        }
    }
    if (-not $git) { throw 'Git 설치 후 git.exe 검증에 실패했습니다.' }
    $version = & $git --version
    if ($LASTEXITCODE -ne 0) { throw 'git --version 검증에 실패했습니다.' }
    Write-InstallerLine $version 'OK'
}

function Ensure-NodeAndNpm {
    Set-InstallerStage 'Node.js 확인'
    $nodeKnown = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
    $node = Find-InstalledExecutable 'node.exe' $nodeKnown
    $supported = $false
    if ($node) {
        $versionText = (& $node -p 'process.versions.node').Trim()
        if ($LASTEXITCODE -eq 0) {
            $major = [int]($versionText.Split('.')[0])
            $supported = $major -ge 20
            if (-not $supported) { Write-InstallerLine "기존 Node.js $versionText 버전이 오래되어 LTS로 갱신합니다." 'WARN' }
        }
    }
    if (-not $supported) {
        $wingetInstalled = Try-WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js LTS'
        Refresh-InstallerPath
        $node = Find-InstalledExecutable 'node.exe' $nodeKnown
        if ($node) {
            $candidateVersion = (& $node -p 'process.versions.node').Trim()
            $supported = $LASTEXITCODE -eq 0 -and [int]($candidateVersion.Split('.')[0]) -ge 20
        }
        if (-not $supported) {
            if ($wingetInstalled) { Write-InstallerLine 'winget 설치 후 Node.js LTS 검증에 실패해 공식 MSI로 재시도합니다.' 'WARN' }
            Install-NodeOfficial
            Refresh-InstallerPath
            $node = Find-InstalledExecutable 'node.exe' $nodeKnown
        }
    }
    if (-not $node) { throw 'Node.js 설치 후 node.exe 검증에 실패했습니다.' }
    $verifiedNodeVersion = (& $node -p 'process.versions.node').Trim()
    if ($LASTEXITCODE -ne 0 -or [int]($verifiedNodeVersion.Split('.')[0]) -lt 20) {
        throw "지원되지 않는 Node.js 버전입니다: $verifiedNodeVersion"
    }
    $nodeVersion = & $node --version
    $npm = Find-InstalledExecutable 'npm.cmd' @((Join-Path $env:ProgramFiles 'nodejs\npm.cmd'))
    if (-not $npm) { throw 'Node.js 설치 후 npm.cmd 검증에 실패했습니다.' }
    $npmVersion = & $npm --version
    if ($LASTEXITCODE -ne 0) { throw 'npm --version 검증에 실패했습니다.' }
    Write-InstallerLine "Node.js $nodeVersion / npm $npmVersion" 'OK'
}

function Ensure-Chrome {
    Set-InstallerStage 'Chrome 확인'
    $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $known = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        $(if ($programFilesX86) { Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' })
    ) | Where-Object { $_ }
    $chrome = Find-InstalledExecutable 'chrome.exe' $known
    if (-not $chrome) {
        $wingetInstalled = Try-WingetInstall 'Google.Chrome' 'Google Chrome'
        Refresh-InstallerPath
        $chrome = Find-InstalledExecutable 'chrome.exe' $known
        if (-not $chrome) {
            if ($wingetInstalled) { Write-InstallerLine 'winget 설치 후 Chrome 검증에 실패해 공식 MSI로 재시도합니다.' 'WARN' }
            Install-ChromeOfficial
            Refresh-InstallerPath
            $chrome = Find-InstalledExecutable 'chrome.exe' $known
        }
    }
    if (-not $chrome) { throw 'Chrome 설치 후 chrome.exe 검증에 실패했습니다.' }
    Write-InstallerLine "Google Chrome 확인 완료: $chrome" 'OK'
}

function Invoke-WorkerInstaller {
    if (-not (Test-Path -LiteralPath $WorkerScript -PathType Leaf)) { throw "직원 PC 설치 엔진을 찾을 수 없습니다: $WorkerScript" }
    Set-InstallerStage 'KREAM BOT 다운로드 및 구성'
    $arguments = @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $WorkerScript,
        '-InstallPath', $InstallPath,
        '-SourceRoot', (Split-Path -Parent $WorkerScript),
        '-ReinstallMode', $ReinstallMode,
        '-ChromeInstallChoice', 'No'
    )
    if ($TestMode) { $arguments += '-TestMode' }
    $output = & powershell.exe @arguments 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) { if ($line) { Write-InstallerLine ([string]$line) } }
    if ($exitCode -ne 0) { throw "KREAM BOT 설치 엔진 실패 (종료 코드 $exitCode)" }
}

New-Item -ItemType Directory -Path $script:TempRoot -Force | Out-Null
try {
    Write-InstallerLine "KREAM BOT Windows 설치 시작: mode=$ReinstallMode"
    if (-not $TestMode) {
        Ensure-Git
        Ensure-NodeAndNpm
        Ensure-Chrome
    }
    Invoke-WorkerInstaller
    Set-InstallerStage '최종 확인'
    if (-not $TestMode) {
        $service = Get-Service -Name 'KREAMBOT' -ErrorAction Stop
        if ($service.Status -ne 'Running') { throw 'KREAMBOT 서비스가 Running 상태가 아닙니다.' }
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000' -TimeoutSec 15
        if ($response.StatusCode -ne 200) { throw "localhost:3000 확인 실패: HTTP $($response.StatusCode)" }
    }
    Write-InstallerLine 'KREAM BOT 설치가 완료되었습니다.' 'OK'
    exit 0
} catch {
    Write-InstallerLine $_.Exception.Message 'ERROR'
    Write-InstallerLine "실패 단계: $($script:CurrentStage)" 'ERROR'
    Write-Host "설치 실패. 로그: $($script:FinalLog)"
    exit 1
} finally {
    Publish-InstallerLog
    $safeTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    $resolvedTemp = [IO.Path]::GetFullPath($script:TempRoot)
    if ($resolvedTemp.StartsWith("$safeTempRoot\KREAMBOT-installer-", [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
