@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

if /i "%~1"=="--confirmed" goto :run_uninstaller
if /i "%~1"=="--confirmed-delete-all" goto :run_uninstaller_delete_all

echo KREAM BOT 직원 PC 제거를 시작합니다.
echo 기본 제거는 DB, 로그, 백업, 설정, Chrome 로그인 프로필을 보존합니다.
echo.
powershell.exe -NoProfile -Command "$value = Read-Host '계속하려면 UNINSTALL을 입력하세요'; if ($value -ceq 'UNINSTALL') { exit 0 } else { exit 1 }"
if not "%ERRORLEVEL%"=="0" (
    echo UNINSTALL이 정확히 입력되지 않아 제거를 종료합니다.
    pause
    exit /b 1
)

echo.
echo 모든 설치 파일과 운영 데이터를 완전히 삭제하려면 DELETE ALL DATA를 입력하세요.
echo 데이터를 보존하는 기본 제거는 Enter를 누르세요.
set "KREAM_UNINSTALL_MODE=--confirmed"
powershell.exe -NoProfile -Command "$value = Read-Host '선택'; if ($value -ceq 'DELETE ALL DATA') { exit 2 } else { exit 0 }"
if "%ERRORLEVEL%"=="2" set "KREAM_UNINSTALL_MODE=--confirmed-delete-all"

net session >nul 2>&1
if not "%ERRORLEVEL%"=="0" (
    echo 관리자 권한으로 제거 창을 다시 엽니다.
    set "KREAM_UNINSTALL_BAT=%~f0"
    set "KREAM_UNINSTALL_ARG=%KREAM_UNINSTALL_MODE%"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:KREAM_UNINSTALL_BAT -ArgumentList $env:KREAM_UNINSTALL_ARG -Verb RunAs"
    if not "%ERRORLEVEL%"=="0" (
        echo 관리자 권한 요청을 시작하지 못했습니다.
        pause
        exit /b 1
    )
    exit /b 0
)

if "%KREAM_UNINSTALL_MODE%"=="--confirmed-delete-all" goto :run_uninstaller_delete_all
goto :run_uninstaller

:run_uninstaller
set "KREAM_DELETE_ALL=0"
goto :invoke_uninstaller

:run_uninstaller_delete_all
set "KREAM_DELETE_ALL=1"

:invoke_uninstaller
set "KREAM_UNINSTALL_PATH=C:\KREAMBOT"
if exist "%~dp0data\worker-install.json" set "KREAM_UNINSTALL_PATH=%~dp0"
set "KREAM_UNINSTALL_TEMP=%TEMP%\KREAMBOT-uninstall-worker-pc-%RANDOM%-%RANDOM%.ps1"
copy /y "%~dp0scripts\uninstall-worker-pc.ps1" "%KREAM_UNINSTALL_TEMP%" >nul
if not "%ERRORLEVEL%"=="0" (
    echo 제거 스크립트를 임시 폴더에 준비하지 못했습니다.
    pause
    exit /b 1
)

if "%KREAM_DELETE_ALL%"=="1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%KREAM_UNINSTALL_TEMP%" -InstallPath "%KREAM_UNINSTALL_PATH%" -DeleteAllData -Confirmation "DELETE ALL DATA"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%KREAM_UNINSTALL_TEMP%" -InstallPath "%KREAM_UNINSTALL_PATH%"
)
set "KREAM_UNINSTALL_EXIT=%ERRORLEVEL%"
del /q "%KREAM_UNINSTALL_TEMP%" >nul 2>&1

echo.
if "%KREAM_UNINSTALL_EXIT%"=="0" (
    echo KREAM BOT 직원 PC 제거 작업이 완료되었습니다.
) else (
    echo KREAM BOT 직원 PC 제거가 완료되지 않았습니다. 종료 코드: %KREAM_UNINSTALL_EXIT%
)
pause
exit /b %KREAM_UNINSTALL_EXIT%
