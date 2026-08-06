@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\github-save.ps1"
set "KREAM_SAVE_EXIT=%ERRORLEVEL%"

echo.
if not "%KREAM_SAVE_EXIT%"=="0" echo GitHub save did not complete. Exit code: %KREAM_SAVE_EXIT%
pause
exit /b %KREAM_SAVE_EXIT%
