Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-KreamProjectRoot {
    return [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Test-KreamAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-KreamAdministrator {
    if (-not (Test-KreamAdministrator)) {
        throw '관리자 권한이 필요합니다. PowerShell을 관리자 권한으로 실행하세요.'
    }
}

function Get-KreamNodePath {
    $candidates = @(@(
        $env:KREAM_NODE_PATH,
        'C:\Program Files\nodejs\node.exe',
        (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    if (-not $candidates) { throw 'node.exe를 찾을 수 없습니다. Node.js를 설치하거나 KREAM_NODE_PATH를 설정하세요.' }
    return [IO.Path]::GetFullPath($candidates[0])
}

function Get-KreamNssmPath {
    param([string]$ProjectRoot = (Get-KreamProjectRoot))
    $configured = $null
    $configFile = Join-Path $ProjectRoot 'data\system-config.json'
    if (Test-Path -LiteralPath $configFile) {
        try { $configured = (Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json).nssmPath } catch {}
    }
    $candidates = @(@(
        $env:KREAM_NSSM_PATH,
        $configured,
        (Join-Path $ProjectRoot 'tools\nssm\win64\nssm.exe'),
        'C:\Tools\nssm\nssm.exe',
        (Get-Command nssm.exe -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source)
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })
    if (-not $candidates) { throw 'nssm.exe를 찾을 수 없습니다. KREAM_NSSM_PATH 또는 data\system-config.json의 nssmPath를 설정하세요.' }
    return [IO.Path]::GetFullPath($candidates[0])
}

function Write-KreamLog {
    param(
        [ValidateSet('app','error','update','inventory','compare')][string]$Type,
        [string]$Message,
        [string]$ProjectRoot = (Get-KreamProjectRoot)
    )
    $logDirectory = Join-Path $ProjectRoot 'logs'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $logFile = Join-Path $logDirectory "$Type.log"
    if ((Test-Path -LiteralPath $logFile) -and (Get-Item -LiteralPath $logFile).Length -ge 10MB) {
        if (Test-Path -LiteralPath "$logFile.5") { Remove-Item -LiteralPath "$logFile.5" -Force }
        for ($index = 4; $index -ge 1; $index--) {
            if (Test-Path -LiteralPath "$logFile.$index") { Move-Item -LiteralPath "$logFile.$index" -Destination "$logFile.$($index + 1)" -Force }
        }
        Move-Item -LiteralPath $logFile -Destination "$logFile.1" -Force
    }
    Add-Content -LiteralPath $logFile -Value "[$([DateTime]::UtcNow.ToString('o'))] $Message" -Encoding UTF8
}

function Wait-KreamServiceState {
    param(
        [string]$ServiceName,
        [ValidateSet('Running','Stopped')][string]$DesiredState,
        [int]$TimeoutSeconds = 45
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $service = Get-Service -Name $ServiceName -ErrorAction Stop
        if ($service.Status.ToString() -eq $DesiredState) { return }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "$ServiceName 서비스가 제한 시간 내에 $DesiredState 상태가 되지 않았습니다."
}

function Invoke-KreamNssm {
    param(
        [string]$NssmPath,
        [string[]]$NssmArguments
    )
    & $NssmPath @NssmArguments
    if ($LASTEXITCODE -ne 0) { throw "NSSM 명령이 실패했습니다. 종료 코드: $LASTEXITCODE" }
}
