@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo KREAM BOT Installer Builder
echo ========================================
echo.

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if not exist "%PS_EXE%" (
    echo ERROR: Windows PowerShell was not found.
    echo Path: %PS_EXE%
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0scripts\build-installer.ps1" (
    echo ERROR: build-installer.ps1 was not found.
    echo Path: %~dp0scripts\build-installer.ps1
    echo.
    pause
    exit /b 1
)

echo Project:
echo %~dp0
echo.
echo Building installer...
echo.

"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-installer.ps1"

set "KREAM_BUILD_EXIT=%ERRORLEVEL%"

echo.

if "%KREAM_BUILD_EXIT%"=="0" (
    echo ========================================
    echo BUILD SUCCESS
    echo ========================================
    echo.
    echo Installer:
    echo %~dp0dist\KREAMBOT_Setup.exe
    echo.
) else (
    echo ========================================
    echo BUILD FAILED
    echo ========================================
    echo.
    echo Exit code: %KREAM_BUILD_EXIT%
    echo Check the error message above.
    echo.
)

pause
exit /b %KREAM_BUILD_EXIT%