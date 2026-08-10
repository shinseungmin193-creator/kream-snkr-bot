[CmdletBinding()]
param(
    [string]$InstallPath = 'C:\KREAMBOT',
    [string]$SourceRoot = '',
    [ValidateSet('Prompt','Yes','No')][string]$ChromeInstallChoice = 'Prompt',
    [switch]$TestMode,
    [ValidateSet('Git','Node','Npm','Chrome','Nssm')][string[]]$SimulateMissingTool = @(),
    [switch]$SimulateWingetUnavailable,
    [switch]$SimulateExistingService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:RepositoryUrl = 'https://github.com/shinseungmin193-creator/kream-snkr-bot.git'
$script:ServiceName = 'KREAMBOT'
$script:FirewallRuleName = 'KREAM Local Server 3000'
$script:Port = 3000
$script:CdpPort = 9222
$script:InstallRoot = $null
$script:LogPath = $null
$script:GitPath = $null
$script:NodePath = $null
$script:NpmPath = $null
$script:NssmPath = $null
$script:ChromePath = $null
$script:SimulatedInstalledTools = @()

function Write-InstallMessage {
    param([string]$Message, [ValidateSet('INFO','OK','WARN','ERROR')][string]$Level = 'INFO')
    $colors = @{ INFO = 'Cyan'; OK = 'Green'; WARN = 'Yellow'; ERROR = 'Red' }
    $line = "[$Level] $Message"
    Write-Host $line -ForegroundColor $colors[$Level]
    if ($script:LogPath) {
        try {
            $parent = Split-Path -Parent $script:LogPath
            if (Test-Path -LiteralPath $parent -PathType Container) {
                Add-Content -LiteralPath $script:LogPath -Value "[$([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))] $line" -Encoding UTF8
            }
        } catch {}
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ExpectedRepositoryOrigin {
    if ($TestMode -and $env:KREAM_WORKER_TEST_ORIGIN) { return $env:KREAM_WORKER_TEST_ORIGIN.TrimEnd('/') }
    return $script:RepositoryUrl
}

function Test-RepositoryOriginMatch {
    param([string]$Actual, [string]$Expected)
    if ($TestMode) { return $Actual.Trim().TrimEnd('/') -ieq $Expected.Trim().TrimEnd('/') }
    return $Actual.Trim() -ceq $Expected
}

function Resolve-SafeInstallPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw '설치 경로가 비어 있습니다.' }
    $candidate = $Path.Trim().Trim('"')
    if ($candidate -notmatch '^[A-Za-z]:\\') { throw '설치 경로는 로컬 드라이브의 절대 경로여야 합니다.' }
    $fullPath = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
    $driveRoot = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\')
    if ($fullPath.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '드라이브 루트에는 설치할 수 없습니다.'
    }
    $blocked = @(
        [Environment]::GetFolderPath('Windows'),
        [Environment]::GetFolderPath('ProgramFiles'),
        [Environment]::GetFolderPath('ProgramFilesX86')
    ) | Where-Object { $_ }
    foreach ($blockedPath in $blocked) {
        $normalized = [IO.Path]::GetFullPath($blockedPath).TrimEnd('\')
        if ($fullPath.Equals($normalized, [StringComparison]::OrdinalIgnoreCase) -or
            $fullPath.StartsWith("$normalized\", [StringComparison]::OrdinalIgnoreCase)) {
            throw "시스템 보호 경로에는 설치할 수 없습니다: $normalized"
        }
    }
    return $fullPath
}

function Refresh-ProcessPath {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($machinePath, $userPath) -join ';'
}

function Find-Executable {
    param(
        [ValidateSet('Git','Node','Npm','Chrome','Nssm')][string]$Tool,
        [string]$CommandName,
        [string[]]$KnownPaths = @()
    )
    if (($SimulateMissingTool -contains $Tool) -and -not ($script:SimulatedInstalledTools -contains $Tool)) { return $null }
    $candidates = [Collections.Generic.List[string]]::new()
    if ($CommandName) {
        $command = Get-Command $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command -and $command.Source) { $candidates.Add($command.Source) }
    }
    foreach ($knownPath in $KnownPaths) {
        if ($knownPath) { $candidates.Add($knownPath) }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return [IO.Path]::GetFullPath($candidate)
        }
    }
    return $null
}

function Invoke-ExternalCommand {
    param(
        [string]$FilePath,
        [string[]]$Arguments,
        [string]$Description,
        [switch]$ReturnOutput
    )
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $FilePath @Arguments 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) {
        $detail = $output.Trim()
        if ($detail.Length -gt 1200) { $detail = $detail.Substring($detail.Length - 1200) }
        throw "$Description 실패 (종료 코드 $exitCode)`n$detail"
    }
    if ($ReturnOutput) { return $output.Trim() }
}

function Get-WingetPath {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    return $null
}

function Install-WithWinget {
    param([string]$PackageId, [string]$DisplayName)
    if ($TestMode) {
        if ($SimulateWingetUnavailable) {
            throw "winget을 찾을 수 없어 $DisplayName 자동 설치를 진행할 수 없습니다. Git: https://git-scm.com/download/win / Node.js: https://nodejs.org/en/download / Chrome: https://www.google.com/chrome/ 에서 설치 후 다시 실행하세요."
        }
        $tool = switch ($PackageId) {
            'Git.Git' { 'Git' }
            'OpenJS.NodeJS.LTS' { 'Node' }
            'Google.Chrome' { 'Chrome' }
            default { $null }
        }
        if ($tool) { $script:SimulatedInstalledTools += $tool }
        Write-InstallMessage "테스트 모드: winget install --id $PackageId 자동 설치 경로 확인 완료" 'OK'
        return
    }
    $winget = Get-WingetPath
    if (-not $winget) {
        throw "winget을 찾을 수 없어 $DisplayName 자동 설치를 진행할 수 없습니다. Git: https://git-scm.com/download/win / Node.js: https://nodejs.org/en/download / Chrome: https://www.google.com/chrome/ 에서 설치 후 다시 실행하세요."
    }
    Write-InstallMessage "$DisplayName 자동 설치를 시작합니다."
    Invoke-ExternalCommand $winget @(
        'install', '--id', $PackageId, '--exact', '--silent',
        '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'
    ) "$DisplayName winget 설치"
    Refresh-ProcessPath
}

function Ensure-CoreTools {
    Write-InstallMessage "PowerShell $($PSVersionTable.PSVersion) 확인 완료" 'OK'

    $gitKnown = @(
        (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'),
        (Join-Path $env:ProgramFiles 'Git\bin\git.exe')
    )
    $script:GitPath = Find-Executable -Tool Git -CommandName 'git.exe' -KnownPaths $gitKnown
    if (-not $script:GitPath) {
        Install-WithWinget -PackageId 'Git.Git' -DisplayName 'Git'
        $script:GitPath = Find-Executable -Tool Git -CommandName 'git.exe' -KnownPaths $gitKnown
    }
    if (-not $script:GitPath) { throw 'Git 설치 후에도 git.exe를 찾을 수 없습니다. Windows를 다시 로그인한 뒤 재시도하세요.' }
    $gitVersion = Invoke-ExternalCommand $script:GitPath @('--version') 'Git 버전 확인' -ReturnOutput
    Write-InstallMessage "$gitVersion 확인 완료" 'OK'

    $nodeKnown = @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
    $script:NodePath = Find-Executable -Tool Node -CommandName 'node.exe' -KnownPaths $nodeKnown
    if (-not $script:NodePath) {
        Install-WithWinget -PackageId 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS'
        $script:NodePath = Find-Executable -Tool Node -CommandName 'node.exe' -KnownPaths $nodeKnown
    }
    if (-not $script:NodePath) { throw 'Node.js 설치 후에도 node.exe를 찾을 수 없습니다. Windows를 다시 로그인한 뒤 재시도하세요.' }
    $nodeVersion = Invoke-ExternalCommand $script:NodePath @('--version') 'Node.js 버전 확인' -ReturnOutput
    Write-InstallMessage "Node.js $nodeVersion 확인 완료" 'OK'

    $npmKnown = @((Join-Path $env:ProgramFiles 'nodejs\npm.cmd'))
    $script:NpmPath = Find-Executable -Tool Npm -CommandName 'npm.cmd' -KnownPaths $npmKnown
    if (-not $script:NpmPath) { throw 'npm.cmd를 찾을 수 없습니다. Node.js LTS 설치를 복구한 뒤 다시 실행하세요.' }
    $npmVersion = Invoke-ExternalCommand $script:NpmPath @('--version') 'npm 버전 확인' -ReturnOutput
    Write-InstallMessage "npm $npmVersion 확인 완료" 'OK'
}

function Ensure-Chrome {
    $programFilesX86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $chromeKnown = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        $(if ($programFilesX86) { Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe' }),
        $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe' })
    ) | Where-Object { $_ }
    $script:ChromePath = Find-Executable -Tool Chrome -CommandName 'chrome.exe' -KnownPaths $chromeKnown
    if ($script:ChromePath) {
        Write-InstallMessage "Google Chrome 확인 완료: $script:ChromePath" 'OK'
        return
    }

    $installChrome = $false
    if ($ChromeInstallChoice -eq 'Yes') { $installChrome = $true }
    elseif ($ChromeInstallChoice -eq 'Prompt' -and -not $TestMode) {
        Write-Host 'Google Chrome이 없습니다. winget으로 설치하려면 INSTALL CHROME을 입력하세요.' -ForegroundColor Yellow
        $answer = Read-Host '선택'
        $installChrome = $answer -eq 'INSTALL CHROME'
    }

    if ($installChrome) {
        Install-WithWinget -PackageId 'Google.Chrome' -DisplayName 'Google Chrome'
        $script:ChromePath = Find-Executable -Tool Chrome -CommandName 'chrome.exe' -KnownPaths $chromeKnown
        if (-not $script:ChromePath) { throw 'Chrome 설치 후 chrome.exe를 찾을 수 없습니다. Windows를 다시 로그인한 뒤 재시도하세요.' }
        Write-InstallMessage "Google Chrome 설치 완료: $script:ChromePath" 'OK'
    } else {
        Write-InstallMessage 'Chrome 자동 설치를 건너뜁니다. https://www.google.com/chrome/ 에서 설치한 뒤 로그인용 BAT를 실행하세요.' 'WARN'
    }
}

function Test-DirectoryEmpty {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $true }
    return -not (Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop | Select-Object -First 1)
}

function Invoke-GitInRepository {
    param([string[]]$Arguments, [switch]$ReturnOutput)
    Push-Location $script:InstallRoot
    try {
        return Invoke-ExternalCommand $script:GitPath $Arguments "git $($Arguments -join ' ')" -ReturnOutput:$ReturnOutput
    } finally { Pop-Location }
}

function Initialize-OrUpdateRepository {
    $expectedOrigin = Get-ExpectedRepositoryOrigin
    $gitDirectory = Join-Path $script:InstallRoot '.git'
    if (-not (Test-Path -LiteralPath $script:InstallRoot)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $script:InstallRoot) -Force | Out-Null
    }

    if (-not (Test-Path -LiteralPath $gitDirectory -PathType Container)) {
        if (-not (Test-DirectoryEmpty $script:InstallRoot)) {
            throw "설치 경로가 비어 있지 않고 Git 저장소도 아닙니다. 기존 파일을 보존하기 위해 중단합니다: $script:InstallRoot"
        }
        if (Test-Path -LiteralPath $script:InstallRoot) {
            Remove-Item -LiteralPath $script:InstallRoot -Force
        }
        Write-InstallMessage "GitHub main 브랜치를 복제합니다: $script:InstallRoot"
        Invoke-ExternalCommand $script:GitPath @('clone', '--branch', 'main', '--single-branch', $script:RepositoryUrl, $script:InstallRoot) 'Git 저장소 복제'
    } else {
        Write-InstallMessage '기존 설치를 확인했습니다. 운영 데이터와 설정을 보존합니다.'
        $localDataChecks = [ordered]@{
            'DB' = 'data\kream-bot.db'
            '앱 설정' = 'data\system-config.json'
            '직원 설정' = 'config\system-config.json'
            'Chrome 전용 프로필' = 'chrome-profile'
            '로그' = 'logs'
            '백업' = 'backups'
        }
        foreach ($entry in $localDataChecks.GetEnumerator()) {
            $present = Test-Path -LiteralPath (Join-Path $script:InstallRoot $entry.Value)
            Write-InstallMessage "기존 $($entry.Key) 확인: $(if ($present) { '있음(보존)' } else { '없음(필요 시 생성)' })"
        }
        $origin = Invoke-GitInRepository @('remote', 'get-url', 'origin') -ReturnOutput
        if (-not (Test-RepositoryOriginMatch -Actual $origin -Expected $expectedOrigin)) {
            throw "origin 주소가 허용된 저장소와 다릅니다. 기존 주소를 변경하지 않고 중단합니다: $origin"
        }
        $branch = Invoke-GitInRepository @('branch', '--show-current') -ReturnOutput
        if ($branch.Trim() -cne 'main') {
            throw "현재 브랜치가 main이 아닙니다. 브랜치를 임의로 변경하지 않고 중단합니다: $branch"
        }
        $status = Invoke-GitInRepository @('status', '--porcelain') -ReturnOutput
        if ($status) {
            throw "로컬 변경사항이 있어 fetch/pull을 실행하지 않습니다. 변경사항을 먼저 확인하세요.`n$status"
        }
        Write-InstallMessage 'origin/main 최신 내용을 확인합니다.'
        Invoke-GitInRepository @('fetch', '--prune', 'origin', 'main') | Out-Null
        Invoke-GitInRepository @('pull', '--ff-only', 'origin', 'main') | Out-Null
        Write-InstallMessage 'Git 저장소 업데이트 완료' 'OK'
    }

    $originAfter = Invoke-GitInRepository @('remote', 'get-url', 'origin') -ReturnOutput
    $branchAfter = Invoke-GitInRepository @('branch', '--show-current') -ReturnOutput
    if (-not (Test-RepositoryOriginMatch -Actual $originAfter -Expected $expectedOrigin) -or $branchAfter.Trim() -cne 'main') {
        throw '복제 후 저장소 origin/main 검증에 실패했습니다.'
    }
    foreach ($required in @('app.js', 'package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:InstallRoot $required) -PathType Leaf)) {
            throw "필수 파일이 없습니다: $required"
        }
    }
}

function Disable-WorkerGitPush {
    Invoke-GitInRepository @('config', '--local', 'remote.origin.pushurl', 'disabled://worker-pc-push-blocked') | Out-Null
    $hookPath = Join-Path $script:InstallRoot '.git\hooks\pre-push'
    $hook = @'
#!/bin/sh
echo "KREAM BOT 직원 PC에서는 GitHub push가 차단되어 있습니다." >&2
exit 1
'@
    [IO.File]::WriteAllText($hookPath, $hook, [Text.UTF8Encoding]::new($false))
    Write-InstallMessage '직원 PC의 GitHub push 차단 설정 완료' 'OK'
}

function Remove-VerifiedTemporaryDirectory {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $full = [IO.Path]::GetFullPath($Path)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    if (-not $full.StartsWith("$tempRoot\KREAMBOT-", [StringComparison]::OrdinalIgnoreCase)) {
        throw "안전하지 않은 임시 경로 삭제를 차단했습니다: $full"
    }
    Remove-Item -LiteralPath $full -Recurse -Force
}

function Install-NssmFromOfficialSource {
    if ($TestMode) { throw '테스트 모드: NSSM 없음 상태를 확인했습니다.' }
    $downloadUrl = 'https://nssm.cc/ci/nssm-2.24-101-g897c7ad.zip'
    $expectedSha256 = '99F5045FFFBFFB745D67FE3A065A953C4A3D9C253B868892D9B685B0EE7D07B8'
    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "KREAMBOT-nssm-$([Guid]::NewGuid().ToString('N'))"
    $zipPath = Join-Path $temporaryDirectory 'nssm.zip'
    try {
        New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
        Write-InstallMessage 'NSSM 공식 배포 파일을 다운로드하고 무결성을 확인합니다.'
        Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $zipPath -TimeoutSec 90
        $actualHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
        if ($actualHash -ne $expectedSha256) {
            throw "NSSM 파일 해시가 일치하지 않아 설치를 중단합니다. 실제 SHA256: $actualHash"
        }
        Expand-Archive -LiteralPath $zipPath -DestinationPath $temporaryDirectory -Force
        $architecture = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
        $downloaded = Get-ChildItem -LiteralPath $temporaryDirectory -Recurse -Filter nssm.exe |
            Where-Object { $_.FullName -match "[\\/]$architecture[\\/]nssm\.exe$" } |
            Select-Object -First 1
        if (-not $downloaded) { throw "NSSM 압축 파일에서 $architecture\nssm.exe를 찾지 못했습니다." }
        $destination = Join-Path $script:InstallRoot "tools\nssm\$architecture\nssm.exe"
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $downloaded.FullName -Destination $destination -Force
        return $destination
    } catch {
        throw "NSSM 자동 설치에 실패했습니다. https://nssm.cc/download 에서 내려받아 tools\nssm\win64\nssm.exe에 배치한 뒤 다시 실행하세요. 원인: $($_.Exception.Message)"
    } finally {
        Remove-VerifiedTemporaryDirectory $temporaryDirectory
    }
}

function Ensure-Nssm {
    $configured = $null
    foreach ($configPath in @(
        (Join-Path $script:InstallRoot 'data\system-config.json'),
        (Join-Path $script:InstallRoot 'config\system-config.json')
    )) {
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
            try {
                $value = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).nssmPath
                if ($value -and (Test-Path -LiteralPath $value -PathType Leaf)) { $configured = $value; break }
            } catch {}
        }
    }
    $architecture = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
    $known = @(
        $configured,
        (Join-Path $script:InstallRoot "tools\nssm\$architecture\nssm.exe"),
        (Join-Path $script:InstallRoot 'tools\nssm\win64\nssm.exe'),
        $(if ($SourceRoot) { Join-Path $SourceRoot "tools\nssm\$architecture\nssm.exe" }),
        'C:\Tools\nssm\nssm.exe'
    ) | Where-Object { $_ }
    $script:NssmPath = Find-Executable -Tool Nssm -CommandName 'nssm.exe' -KnownPaths $known
    if (-not $script:NssmPath) { $script:NssmPath = Install-NssmFromOfficialSource }
    if (-not (Test-Path -LiteralPath $script:NssmPath -PathType Leaf)) { throw 'nssm.exe 준비에 실패했습니다.' }
    Write-InstallMessage "NSSM 확인 완료: $script:NssmPath" 'OK'
}

function Write-JsonFile {
    param([string]$Path, [object]$Value)
    $json = $Value | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

function Initialize-LocalConfiguration {
    foreach ($directory in @('data', 'logs', 'backups', 'config', 'chrome-profile')) {
        New-Item -ItemType Directory -Path (Join-Path $script:InstallRoot $directory) -Force | Out-Null
    }
    $script:LogPath = Join-Path $script:InstallRoot 'logs\install-worker-pc.log'

    $configPath = Join-Path $script:InstallRoot 'config\system-config.json'
    $examplePath = Join-Path $script:InstallRoot 'config\system-config.example.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        $config = [ordered]@{ nssmPath = $script:NssmPath }
        if (Test-Path -LiteralPath $examplePath -PathType Leaf) {
            try {
                $example = Get-Content -LiteralPath $examplePath -Raw -Encoding UTF8 | ConvertFrom-Json
                $example | Add-Member -NotePropertyName nssmPath -NotePropertyValue $script:NssmPath -Force
                $config = $example
            } catch {
                Write-InstallMessage '설정 예제 해석에 실패하여 안전한 기본 설정을 생성합니다.' 'WARN'
            }
        }
        Write-JsonFile -Path $configPath -Value $config
        Write-InstallMessage 'config\system-config.json 최초 생성 완료' 'OK'
    } else {
        Write-InstallMessage '기존 config\system-config.json을 덮어쓰지 않고 보존합니다.' 'OK'
    }

    $runtimeConfigPath = Join-Path $script:InstallRoot 'data\system-config.json'
    if (-not (Test-Path -LiteralPath $runtimeConfigPath -PathType Leaf)) {
        Copy-Item -LiteralPath $configPath -Destination $runtimeConfigPath
        Write-InstallMessage '앱용 data\system-config.json 최초 생성 완료' 'OK'
    } else {
        Write-InstallMessage '기존 data\system-config.json을 덮어쓰지 않고 보존합니다.' 'OK'
    }

    $markerPath = Join-Path $script:InstallRoot 'data\worker-install.json'
    $marker = [ordered]@{
        installPath = $script:InstallRoot
        repository = $script:RepositoryUrl
        serviceName = $script:ServiceName
        lastInstallAttempt = [DateTime]::UtcNow.ToString('o')
        status = 'installing'
    }
    Write-JsonFile -Path $markerPath -Value $marker
}

function Install-NodeDependencies {
    Push-Location $script:InstallRoot
    try {
        if (Test-Path -LiteralPath (Join-Path $script:InstallRoot 'package-lock.json') -PathType Leaf) {
            Write-InstallMessage 'package-lock.json 기준 npm ci를 실행합니다.'
            Invoke-ExternalCommand $script:NpmPath @('ci', '--no-audit', '--no-fund') 'npm ci'
        } else {
            Write-InstallMessage 'package-lock.json이 없어 npm install을 실행합니다.' 'WARN'
            Invoke-ExternalCommand $script:NpmPath @('install', '--no-audit', '--no-fund') 'npm install'
        }
    } finally { Pop-Location }
    Write-InstallMessage 'Node.js 의존성 설치 완료' 'OK'
}

function New-ChromeLauncher {
    $launcherPath = Join-Path $script:InstallRoot 'KREAM_로그인_Chrome.bat'
    $profilePath = Join-Path $script:InstallRoot 'chrome-profile'
    $preferredChrome = if ($script:ChromePath) { $script:ChromePath } else { '' }
    $content = @'
@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "KREAM_CHROME_EXE=__CHROME_PATH__"
if not exist "%KREAM_CHROME_EXE%" set "KREAM_CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%KREAM_CHROME_EXE%" set "KREAM_CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%KREAM_CHROME_EXE%" set "KREAM_CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%KREAM_CHROME_EXE%" (
    echo Google Chrome을 찾을 수 없습니다. https://www.google.com/chrome/ 에서 설치하세요.
    pause
    exit /b 1
)

powershell.exe -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:9222/json/version' -TimeoutSec 2 ^| Out-Null; exit 0 } catch { exit 1 }"
if "%ERRORLEVEL%"=="0" (
    echo KREAM 로그인용 Chrome이 이미 9222 포트에서 실행 중입니다.
    pause
    exit /b 0
)

netstat -ano | findstr /r /c:":9222 .*LISTENING" >nul
if "%ERRORLEVEL%"=="0" (
    echo 9222 포트를 다른 프로그램이 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 실행하세요.
    pause
    exit /b 1
)

start "" "%KREAM_CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="__PROFILE_PATH__" --no-first-run --no-default-browser-check "https://partner.kream.co.kr/"
echo KREAM 로그인용 전용 Chrome을 시작했습니다.
echo 이 Chrome에서 KREAM에 직접 로그인하세요. 일반 Chrome 프로필과는 분리되어 있습니다.
exit /b 0
'@
    $content = $content.Replace('__CHROME_PATH__', $preferredChrome).Replace('__PROFILE_PATH__', $profilePath)
    [IO.File]::WriteAllText($launcherPath, $content, [Text.UTF8Encoding]::new($false))
    Write-InstallMessage "KREAM 로그인용 Chrome 실행 파일 생성 완료: $launcherPath" 'OK'

    if (-not $TestMode) {
        try {
            $publicDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
            if ($publicDesktop) {
                $shortcutPath = Join-Path $publicDesktop 'KREAM 로그인 Chrome.lnk'
                $shell = New-Object -ComObject WScript.Shell
                $shortcut = $shell.CreateShortcut($shortcutPath)
                $shortcut.TargetPath = $launcherPath
                $shortcut.WorkingDirectory = $script:InstallRoot
                $shortcut.Description = 'KREAM BOT 로그인용 Chrome (CDP 9222)'
                $shortcut.Save()
                Write-InstallMessage "바탕 화면 바로가기 생성 완료: $shortcutPath" 'OK'
            }
        } catch {
            Write-InstallMessage "바탕 화면 바로가기를 만들지 못했습니다. BAT 파일은 정상 생성되었습니다: $($_.Exception.Message)" 'WARN'
        }
    }
}

function Get-ServiceAppDirectory {
    $registryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$($script:ServiceName)\Parameters"
    try { return (Get-ItemProperty -LiteralPath $registryPath -Name AppDirectory -ErrorAction Stop).AppDirectory }
    catch { return $null }
}

function Ensure-SystemSafeDirectory {
    if ($TestMode) { return }
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $existing = & $script:GitPath 'config' '--system' '--get-all' 'safe.directory' 2>$null | Out-String
        $exitCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousPreference }
    if ($exitCode -notin @(0, 1)) { throw "Git safe.directory 조회 실패 (종료 코드 $exitCode)" }
    $entries = @($existing -split "`r?`n" | Where-Object { $_ })
    if (-not ($entries | Where-Object { $_.TrimEnd('\') -ieq $script:InstallRoot.TrimEnd('\') })) {
        Invoke-ExternalCommand $script:GitPath @('config', '--system', '--add', 'safe.directory', $script:InstallRoot) 'Git safe.directory 등록'
    }
}

function Invoke-Nssm {
    param([string[]]$Arguments, [switch]$ReturnOutput)
    return Invoke-ExternalCommand $script:NssmPath $Arguments "NSSM $($Arguments -join ' ')" -ReturnOutput:$ReturnOutput
}

function Configure-KreamService {
    if ($TestMode) {
        $mode = if ($SimulateExistingService) { '기존 서비스 설정 갱신' } else { '신규 서비스 등록' }
        Write-InstallMessage "테스트 모드: $mode 검증 완료 (동시 실제 서비스 변경 없음)" 'OK'
        return
    }

    $existing = Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
    if ($existing) {
        $oldDirectory = Get-ServiceAppDirectory
        Write-InstallMessage "기존 $($script:ServiceName) 서비스를 확인했습니다. AppDirectory=$oldDirectory" 'WARN'
        if ($existing.Status -ne 'Stopped') {
            Stop-Service -Name $script:ServiceName -Force
            $existing.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
        }
    } else {
        Invoke-Nssm @('install', $script:ServiceName, $script:NodePath, 'app.js') | Out-Null
    }

    $logDirectory = Join-Path $script:InstallRoot 'logs'
    $settings = @(
        @('Application', $script:NodePath),
        @('AppDirectory', $script:InstallRoot),
        @('AppParameters', 'app.js'),
        @('DisplayName', 'KREAM BOT'),
        @('Description', 'KREAM BOT inventory and price management server'),
        @('Start', 'SERVICE_AUTO_START'),
        @('AppRestartDelay', '5000'),
        @('AppStdout', (Join-Path $logDirectory 'service-out.log')),
        @('AppStderr', (Join-Path $logDirectory 'service-error.log')),
        @('AppRotateFiles', '1'),
        @('AppRotateOnline', '1'),
        @('AppRotateBytes', '10485760'),
        @('AppNoConsole', '1')
    )
    foreach ($setting in $settings) {
        Invoke-Nssm (@('set', $script:ServiceName) + $setting) | Out-Null
    }
    Invoke-Nssm @('set', $script:ServiceName, 'AppExit', 'Default', 'Restart') | Out-Null

    $account = Invoke-Nssm @('get', $script:ServiceName, 'ObjectName') -ReturnOutput
    if ($account -match 'LocalSystem|SYSTEM') {
        Ensure-SystemSafeDirectory
        Write-InstallMessage '서비스 계정은 LocalSystem입니다. 공개 origin/main 업데이트를 위해 이 설치 경로만 Git safe.directory로 등록했습니다.' 'OK'
    } else {
        Write-InstallMessage "기존 서비스 계정을 보존했습니다: $account" 'WARN'
    }

    Start-Service -Name $script:ServiceName
    (Get-Service -Name $script:ServiceName).WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(45))
    Write-InstallMessage "$($script:ServiceName) 서비스 등록 및 시작 완료" 'OK'
}

function Configure-Firewall {
    if ($TestMode) {
        Write-InstallMessage "테스트 모드: 방화벽 규칙 검증 완료 ($($script:FirewallRuleName))" 'OK'
        return
    }
    $rule = Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $rule) {
        New-NetFirewallRule -DisplayName $script:FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $script:Port -Profile Private,Domain | Out-Null
    } else {
        $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Private,Domain | Out-Null
        $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort $script:Port | Out-Null
    }
    $validated = Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction Stop | Select-Object -First 1
    $portFilter = $validated | Get-NetFirewallPortFilter
    if ($validated.Enabled -ne 'True' -or $portFilter.Protocol -ne 'TCP' -or "$($portFilter.LocalPort)" -ne "$($script:Port)") {
        throw '포트 3000 방화벽 규칙 검증에 실패했습니다.'
    }
    Write-InstallMessage "방화벽 인바운드 규칙 확인 완료: $($script:FirewallRuleName)" 'OK'
}

function Get-InternalIpv4Address {
    try {
        $configuration = Get-NetIPConfiguration -ErrorAction Stop |
            Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } |
            Select-Object -First 1
        if ($configuration) { return $configuration.IPv4Address.IPAddress }
    } catch {}
    try {
        return Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object { $_.IPAddress -notmatch '^127\.|^169\.254\.' } |
            Select-Object -First 1 -ExpandProperty IPAddress
    } catch { return $null }
}

function Wait-HttpOk {
    param([string]$Uri, [int]$TimeoutSeconds = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
            if ($response.StatusCode -eq 200) { return $response }
        } catch {}
        Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $deadline)
    throw "HTTP 200 응답을 확인하지 못했습니다: $Uri"
}

function Test-InstallationHealth {
    if ($TestMode) {
        return [pscustomobject]@{
            ServiceStatus = 'Running (simulated)'
            StartMode = 'Auto (simulated)'
            LocalUrl = "http://localhost:$($script:Port)"
            LanUrl = "http://192.0.2.10:$($script:Port) (simulated)"
            CdpStatus = '로그인용 Chrome 실행 필요 (simulated)'
        }
    }

    $service = Get-Service -Name $script:ServiceName -ErrorAction Stop
    $serviceInfo = Get-CimInstance Win32_Service -Filter "Name='$($script:ServiceName)'" -ErrorAction Stop
    if ($service.Status -ne 'Running' -or $serviceInfo.StartMode -ne 'Auto') {
        throw "서비스 상태 검증 실패: status=$($service.Status), startMode=$($serviceInfo.StartMode)"
    }
    $application = Invoke-Nssm @('get', $script:ServiceName, 'Application') -ReturnOutput
    $directory = Invoke-Nssm @('get', $script:ServiceName, 'AppDirectory') -ReturnOutput
    $parameters = Invoke-Nssm @('get', $script:ServiceName, 'AppParameters') -ReturnOutput
    if ($application.Trim() -ine $script:NodePath -or $directory.TrimEnd('\') -ine $script:InstallRoot.TrimEnd('\') -or $parameters.Trim() -ne 'app.js') {
        throw 'NSSM Application/AppDirectory/AppParameters 검증에 실패했습니다.'
    }

    $localUrl = "http://127.0.0.1:$($script:Port)"
    Wait-HttpOk $localUrl | Out-Null
    $listening = Get-NetTCPConnection -State Listen -LocalPort $script:Port -ErrorAction SilentlyContinue
    if (-not $listening) { throw "TCP $($script:Port) LISTEN 상태를 확인하지 못했습니다." }

    $internalIp = Get-InternalIpv4Address
    $lanUrl = $null
    if ($internalIp) {
        $lanUrl = "http://$internalIp`:$($script:Port)"
        Wait-HttpOk $lanUrl 15 | Out-Null
    }

    $cdpStatus = '로그인용 Chrome 실행 필요'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($script:CdpPort)/json/version" -TimeoutSec 3 | Out-Null
        $cdpStatus = 'CDP 9222 연결됨'
        try {
            $chrome = Invoke-RestMethod -Uri "http://127.0.0.1:$($script:Port)/api/system/chrome-status" -TimeoutSec 10
            if ($chrome.chrome.loginStatus) { $cdpStatus = "CDP 9222 연결됨 / 로그인 상태: $($chrome.chrome.loginStatus)" }
        } catch {}
    } catch {}

    return [pscustomobject]@{
        ServiceStatus = $service.Status.ToString()
        StartMode = $serviceInfo.StartMode
        LocalUrl = "http://localhost:$($script:Port)"
        LanUrl = $(if ($lanUrl) { $lanUrl } else { '내부 IP를 확인하지 못함' })
        CdpStatus = $cdpStatus
    }
}

function Complete-InstallMarker {
    param([string]$Status)
    $markerPath = Join-Path $script:InstallRoot 'data\worker-install.json'
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $markerPath))) { return }
    $marker = [ordered]@{
        installPath = $script:InstallRoot
        repository = $script:RepositoryUrl
        serviceName = $script:ServiceName
        completedAt = [DateTime]::UtcNow.ToString('o')
        status = $Status
    }
    Write-JsonFile -Path $markerPath -Value $marker
}

function Invoke-WorkerInstall {
    if (-not $TestMode -and -not (Test-IsAdministrator)) {
        throw '관리자 권한이 필요합니다. 직원PC_설치.bat을 더블클릭해 실행하세요.'
    }
    $script:InstallRoot = Resolve-SafeInstallPath $InstallPath
    $script:LogPath = $null
    Write-InstallMessage "설치 대상 경로: $script:InstallRoot"

    Ensure-CoreTools
    Ensure-Chrome
    Initialize-OrUpdateRepository
    $script:LogPath = Join-Path $script:InstallRoot 'logs\install-worker-pc.log'
    New-Item -ItemType Directory -Path (Split-Path -Parent $script:LogPath) -Force | Out-Null
    Disable-WorkerGitPush
    Ensure-Nssm
    Initialize-LocalConfiguration
    Install-NodeDependencies
    New-ChromeLauncher
    Configure-KreamService
    Configure-Firewall
    $health = Test-InstallationHealth
    Complete-InstallMarker 'complete'

    $package = Get-Content -LiteralPath (Join-Path $script:InstallRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Host ''
    Write-Host '================ KREAM BOT 설치 완료 ================' -ForegroundColor Green
    Write-Host "설치 경로       : $script:InstallRoot"
    Write-Host "설치 버전       : $($package.version)"
    Write-Host "서비스          : $($script:ServiceName) / $($health.ServiceStatus) / 시작 유형 $($health.StartMode)"
    Write-Host "Node 실행 파일  : $script:NodePath"
    Write-Host "app.js 경로     : $(Join-Path $script:InstallRoot 'app.js')"
    Write-Host "로컬 접속       : $($health.LocalUrl)"
    Write-Host "사내망 접속     : $($health.LanUrl)"
    Write-Host "Chrome CDP      : $($health.CdpStatus)"
    Write-Host "Chrome 실행 BAT : $(Join-Path $script:InstallRoot 'KREAM_로그인_Chrome.bat')"
    Write-Host '업데이트        : 시스템 관리 화면에서 origin/main 최신 업데이트 적용 가능'
    Write-Host ''
    Write-Host '사용 순서'
    Write-Host '1. KREAM_로그인_Chrome.bat을 실행합니다.'
    Write-Host '2. 열린 전용 Chrome에서 KREAM에 직접 로그인합니다.'
    Write-Host "3. $($health.LocalUrl) 에 접속합니다."
    Write-Host '4. 이후 업데이트는 시스템 관리 화면에서 확인하고 적용합니다.'
}

try {
    Invoke-WorkerInstall
    exit 0
} catch {
    $message = $_.Exception.Message
    Write-InstallMessage $message 'ERROR'
    if ($script:InstallRoot -and (Test-Path -LiteralPath $script:InstallRoot)) {
        try { Complete-InstallMarker 'failed' } catch {}
    }
    Write-Host '설치가 안전하게 중단되었습니다. npm 설치가 실패한 경우 서비스는 새로 등록되지 않습니다.' -ForegroundColor Yellow
    exit 1
}
