[CmdletBinding()]
param(
    [string]$InstallPath = 'C:\KREAMBOT',
    [switch]$DeleteAllData,
    [string]$Confirmation = '',
    [switch]$TestMode,
    [switch]$SimulateExistingService
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:RepositoryUrl = 'https://github.com/shinseungmin193-creator/kream-snkr-bot.git'
$script:ServiceName = 'KREAMBOT'
$script:FirewallRuleName = 'KREAM Local Server 3000'
$script:InstallRoot = $null

function Write-UninstallMessage {
    param([string]$Message, [ValidateSet('INFO','OK','WARN','ERROR')][string]$Level = 'INFO')
    $colors = @{ INFO = 'Cyan'; OK = 'Green'; WARN = 'Yellow'; ERROR = 'Red' }
    Write-Host "[$Level] $Message" -ForegroundColor $colors[$Level]
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-SafeInstallPath {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { throw '설치 경로가 비어 있습니다.' }
    $candidate = $Path.Trim().Trim('"')
    if ($candidate -notmatch '^[A-Za-z]:\\') { throw '설치 경로는 로컬 드라이브의 절대 경로여야 합니다.' }
    $fullPath = [IO.Path]::GetFullPath($candidate).TrimEnd('\')
    $driveRoot = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\')
    if ($fullPath.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw '드라이브 루트 삭제를 차단했습니다.'
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
            throw "시스템 보호 경로 삭제를 차단했습니다: $normalized"
        }
    }
    return $fullPath
}

function Read-InstallMarker {
    $markerPath = Join-Path $script:InstallRoot 'data\worker-install.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return $null }
    try {
        $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($marker.repository -ne $script:RepositoryUrl) { return $null }
        if ([IO.Path]::GetFullPath([string]$marker.installPath).TrimEnd('\') -ine $script:InstallRoot.TrimEnd('\')) { return $null }
        if ($marker.serviceName -ne $script:ServiceName) { return $null }
        return $marker
    } catch { return $null }
}

function Find-NssmPath {
    $candidates = [Collections.Generic.List[string]]::new()
    foreach ($configPath in @(
        (Join-Path $script:InstallRoot 'data\system-config.json'),
        (Join-Path $script:InstallRoot 'config\system-config.json')
    )) {
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
            try {
                $configured = (Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json).nssmPath
                if ($configured) { $candidates.Add([string]$configured) }
            } catch {}
        }
    }
    foreach ($path in @(
        (Join-Path $script:InstallRoot 'tools\nssm\win64\nssm.exe'),
        (Join-Path $script:InstallRoot 'tools\nssm\win32\nssm.exe'),
        'C:\Tools\nssm\nssm.exe'
    )) { $candidates.Add($path) }
    $command = Get-Command nssm.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { $candidates.Add($command.Source) }
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}

function Get-ServiceAppDirectory {
    $registryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$($script:ServiceName)\Parameters"
    try { return (Get-ItemProperty -LiteralPath $registryPath -Name AppDirectory -ErrorAction Stop).AppDirectory }
    catch { return $null }
}

function Remove-KreamService {
    if ($TestMode) {
        $state = if ($SimulateExistingService) { '기존 서비스 중지/삭제' } else { '서비스 없음' }
        Write-UninstallMessage "테스트 모드: $state 검증 완료" 'OK'
        return
    }

    $service = Get-Service -Name $script:ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        Write-UninstallMessage "$($script:ServiceName) 서비스가 등록되어 있지 않습니다." 'INFO'
        return
    }
    $appDirectory = Get-ServiceAppDirectory
    $marker = Read-InstallMarker
    if ($appDirectory) {
        $resolvedServiceRoot = [IO.Path]::GetFullPath([string]$appDirectory).TrimEnd('\')
        if ($resolvedServiceRoot -ine $script:InstallRoot.TrimEnd('\')) {
            throw "$($script:ServiceName) 서비스가 다른 프로젝트를 실행 중이므로 삭제하지 않습니다. AppDirectory=$resolvedServiceRoot"
        }
    } elseif (-not $marker) {
        throw "$($script:ServiceName) 서비스의 설치 경로를 검증할 수 없어 삭제를 차단했습니다."
    }

    if ($service.Status -ne 'Stopped') {
        Stop-Service -Name $script:ServiceName -Force
        $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
    }
    $nssmPath = Find-NssmPath
    if ($nssmPath) {
        & $nssmPath 'remove' $script:ServiceName 'confirm'
        if ($LASTEXITCODE -ne 0) { throw "NSSM 서비스 삭제 실패 (종료 코드 $LASTEXITCODE)" }
    } else {
        & sc.exe delete $script:ServiceName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "sc.exe 서비스 삭제 실패 (종료 코드 $LASTEXITCODE)" }
    }
    Write-UninstallMessage "$($script:ServiceName) 서비스 중지 및 자동 시작 제거 완료" 'OK'
}

function Remove-KreamFirewallRule {
    if ($TestMode) {
        Write-UninstallMessage "테스트 모드: 방화벽 규칙 제거 검증 완료 ($($script:FirewallRuleName))" 'OK'
        return
    }
    $rules = Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue
    if ($rules) {
        $rules | Remove-NetFirewallRule
        Write-UninstallMessage "방화벽 규칙 제거 완료: $($script:FirewallRuleName)" 'OK'
    } else {
        Write-UninstallMessage '제거할 KREAM 포트 3000 방화벽 규칙이 없습니다.' 'INFO'
    }
}

function Remove-ChromeShortcutAndLauncher {
    $launcherPath = Join-Path $script:InstallRoot 'KREAM_로그인_Chrome.bat'
    if (-not $TestMode) {
        try {
            $publicDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
            if ($publicDesktop) {
                $shell = New-Object -ComObject WScript.Shell
                foreach ($shortcutName in @('KREAM 로그인.lnk', 'KREAM 로그인 Chrome.lnk')) {
                    $shortcutPath = Join-Path $publicDesktop $shortcutName
                    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
                        $shortcut = $shell.CreateShortcut($shortcutPath)
                        if ([IO.Path]::GetFullPath($shortcut.TargetPath) -ieq [IO.Path]::GetFullPath($launcherPath)) {
                            Remove-Item -LiteralPath $shortcutPath -Force
                            Write-UninstallMessage "바탕 화면 바로가기 제거 완료: $shortcutName" 'OK'
                        } else {
                            Write-UninstallMessage "동일 이름의 바로가기가 다른 파일을 가리켜 보존했습니다: $shortcutName" 'WARN'
                        }
                    }
                }

                $botShortcutPath = Join-Path $publicDesktop 'KREAM BOT.lnk'
                if (Test-Path -LiteralPath $botShortcutPath -PathType Leaf) {
                    $botShortcut = $shell.CreateShortcut($botShortcutPath)
                    $expectedExplorer = Join-Path $env:SystemRoot 'explorer.exe'
                    if ([IO.Path]::GetFullPath($botShortcut.TargetPath) -ieq [IO.Path]::GetFullPath($expectedExplorer) -and
                        $botShortcut.Arguments -match 'http://localhost:3000') {
                        Remove-Item -LiteralPath $botShortcutPath -Force
                        Write-UninstallMessage 'KREAM BOT 바탕 화면 바로가기 제거 완료' 'OK'
                    } else {
                        Write-UninstallMessage 'KREAM BOT 바로가기가 다른 대상을 가리켜 보존했습니다.' 'WARN'
                    }
                }
            }
        } catch {
            Write-UninstallMessage "바탕 화면 바로가기 확인 실패: $($_.Exception.Message)" 'WARN'
        }
    }
    if (Test-Path -LiteralPath $launcherPath -PathType Leaf) {
        Remove-Item -LiteralPath $launcherPath -Force
        Write-UninstallMessage 'KREAM 로그인 Chrome 실행 BAT 제거 완료' 'OK'
    }
}

function Remove-ApplicationFilesPreservingData {
    $marker = Read-InstallMarker
    if (-not $marker) {
        throw '직원 PC 설치 표식과 경로를 검증할 수 없어 프로그램 파일 제거를 차단했습니다.'
    }
    if (-not (Test-Path -LiteralPath $script:InstallRoot -PathType Container)) { return }

    $preservedNames = @('data', 'logs', 'backups', 'config', 'chrome-profile')
    foreach ($item in Get-ChildItem -LiteralPath $script:InstallRoot -Force) {
        if ($preservedNames -contains $item.Name) { continue }
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
    Write-UninstallMessage '프로그램 파일을 제거하고 운영 데이터 폴더는 보존했습니다.' 'OK'
}

function Remove-AllInstallationData {
    if (-not $DeleteAllData) { return }
    if ($Confirmation -cne 'DELETE ALL DATA') {
        throw '전체 삭제는 DELETE ALL DATA를 정확히 입력한 경우에만 허용됩니다.'
    }
    $marker = Read-InstallMarker
    if (-not $marker) {
        throw '직원 PC 설치 표식과 경로를 검증할 수 없어 전체 삭제를 차단했습니다.'
    }
    if (-not (Test-Path -LiteralPath $script:InstallRoot -PathType Container)) {
        Write-UninstallMessage '삭제할 설치 폴더가 없습니다.' 'INFO'
        return
    }
    $verifiedRoot = Resolve-SafeInstallPath $script:InstallRoot
    if ($verifiedRoot -ine $script:InstallRoot) { throw '전체 삭제 경로 재검증에 실패했습니다.' }
    Remove-Item -LiteralPath $verifiedRoot -Recurse -Force
    Write-UninstallMessage "전체 설치 파일과 DB, 로그, 백업, 설정, Chrome 프로필을 삭제했습니다: $verifiedRoot" 'OK'
    Write-UninstallMessage '전체 삭제 데이터는 이 스크립트로 복구할 수 없습니다.' 'WARN'
}

function Invoke-WorkerUninstall {
    if (-not $TestMode -and -not (Test-IsAdministrator)) {
        throw '관리자 권한이 필요합니다. 직원PC_제거.bat을 더블클릭해 실행하세요.'
    }
    $script:InstallRoot = Resolve-SafeInstallPath $InstallPath
    Write-UninstallMessage "제거 대상 경로: $script:InstallRoot"

    if ($DeleteAllData -and $Confirmation -cne 'DELETE ALL DATA') {
        throw '전체 삭제 확인 문구가 일치하지 않습니다. 아무 데이터도 삭제하지 않았습니다.'
    }
    if ($DeleteAllData -and -not (Read-InstallMarker)) {
        throw '직원 PC 설치 표식과 경로를 검증할 수 없어 전체 삭제를 시작하지 않습니다.'
    }
    Remove-KreamService
    Remove-KreamFirewallRule
    Remove-ChromeShortcutAndLauncher

    if ($DeleteAllData) {
        Remove-AllInstallationData
    } else {
        Remove-ApplicationFilesPreservingData
        Write-Host ''
        Write-Host '기본 제거 완료: 다음 운영 데이터는 그대로 보존했습니다.' -ForegroundColor Green
        foreach ($relative in @('data', 'logs', 'backups', 'config\system-config.json', 'chrome-profile')) {
            Write-Host "- $(Join-Path $script:InstallRoot $relative)"
        }
        Write-Host '재설치하려면 KREAMBOT_Setup.exe를 다시 실행하세요.'
    }
}

try {
    Invoke-WorkerUninstall
    exit 0
} catch {
    Write-UninstallMessage $_.Exception.Message 'ERROR'
    Write-Host '제거가 안전하게 중단되었습니다.' -ForegroundColor Yellow
    exit 1
}
