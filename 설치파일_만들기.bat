@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

echo KREAM BOT Windows 설치 파일을 생성합니다.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-installer.ps1"
set "KREAM_BUILD_EXIT=%ERRORLEVEL%"

echo.
if "%KREAM_BUILD_EXIT%"=="0" (
    echo dist\KREAMBOT_Setup.exe 생성이 완료되었습니다.
) else (
    echo 설치 파일 생성에 실패했습니다. 위 오류를 확인하세요.
)
pause
exit /b %KREAM_BUILD_EXIT%
