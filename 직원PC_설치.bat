@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="--confirmed" goto :run_installer

echo KREAM BOT 직원 PC 설치를 시작합니다.
echo 이 PC에는 KREAM 로그인용 Chrome과 KREAMBOT 서비스가 설치됩니다.
echo.
powershell.exe -NoProfile -Command "$value = Read-Host '계속하려면 INSTALL을 입력하세요'; if ($value -ceq 'INSTALL') { exit 0 } else { exit 1 }"
if not "%ERRORLEVEL%"=="0" (
    echo INSTALL이 정확히 입력되지 않아 설치를 종료합니다.
    pause
    exit /b 1
)

net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
    echo 관리자 권한으로 설치 창을 다시 엽니다.
    set "KREAM_INSTALL_BAT=%~f0"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:KREAM_INSTALL_BAT -ArgumentList '--confirmed' -Verb RunAs"
    if not "%ERRORLEVEL%"=="0" (
        echo 관리자 권한 요청을 시작하지 못했습니다.
        pause
        exit /b 1
    )
    exit /b 0
)

:run_installer
echo.
echo 설치 경로: C:\KREAMBOT

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-worker-pc.ps1" -InstallPath "C:\KREAMBOT" -SourceRoot "%~dp0"
set "KREAM_INSTALL_EXIT=%ERRORLEVEL%"

echo.
if "%KREAM_INSTALL_EXIT%"=="0" (
    echo KREAM BOT 직원 PC 설치 작업이 완료되었습니다.
) else (
    echo KREAM BOT 직원 PC 설치가 완료되지 않았습니다. 종료 코드: %KREAM_INSTALL_EXIT%
)
pause
exit /b %KREAM_INSTALL_EXIT%
