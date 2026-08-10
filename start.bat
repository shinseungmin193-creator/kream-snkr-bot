@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title KREAM BOT SERVER

cd /d "%~dp0"
if errorlevel 1 goto project_path_error

set "KREAM_PROJECT_ROOT=%CD%"
set "KREAM_PORT=3000"
set "KREAM_NODE_EXE="
set "KREAM_NPM_CMD="
set "KREAM_CHROME_EXE="

for /f "delims=" %%I in ('where.exe node.exe 2^>nul') do if not defined KREAM_NODE_EXE set "KREAM_NODE_EXE=%%~fI"
if not defined KREAM_NODE_EXE goto node_missing
if not exist "%KREAM_NODE_EXE%" goto node_missing

echo ========================================
echo KREAM BOT SERVER
echo 프로젝트 경로: %KREAM_PROJECT_ROOT%
echo Node 경로: %KREAM_NODE_EXE%
echo 포트: %KREAM_PORT%
echo ========================================
echo.

if not exist "%KREAM_PROJECT_ROOT%\package.json" goto package_missing
if not exist "%KREAM_PROJECT_ROOT%\app.js" goto app_missing

if exist "%KREAM_PROJECT_ROOT%\node_modules\" goto dependencies_ready

echo node_modules가 없어 의존성 설치를 시작합니다.
for %%I in ("%KREAM_NODE_EXE%") do set "KREAM_NODE_DIR=%%~dpI"
if exist "%KREAM_NODE_DIR%npm.cmd" set "KREAM_NPM_CMD=%KREAM_NODE_DIR%npm.cmd"
for /f "delims=" %%I in ('where.exe npm.cmd 2^>nul') do if not defined KREAM_NPM_CMD set "KREAM_NPM_CMD=%%~fI"
if not defined KREAM_NPM_CMD goto npm_missing

if exist "%KREAM_PROJECT_ROOT%\package-lock.json" goto npm_ci
echo package-lock.json이 없어 npm install을 실행합니다.
call "%KREAM_NPM_CMD%" install --no-audit --no-fund
if errorlevel 1 goto npm_install_failed
goto dependencies_ready

:npm_ci
echo package-lock.json 기준으로 npm ci를 실행합니다.
call "%KREAM_NPM_CMD%" ci --no-audit --no-fund
if errorlevel 1 goto npm_ci_failed

:dependencies_ready
if /i "%KREAM_START_SKIP_CHROME%"=="1" goto chrome_ready
call :start_login_chrome
:chrome_ready

echo.
echo KREAM BOT 서버를 시작합니다.
echo 종료하려면 이 창에서 Ctrl+C를 누르세요.
echo.
if /i not "%KREAM_START_SKIP_BROWSER%"=="1" start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://localhost:3000'"
"%KREAM_NODE_EXE%" "%KREAM_PROJECT_ROOT%\app.js"
set "KREAM_SERVER_EXIT=%ERRORLEVEL%"

echo.
echo [오류] KREAM BOT 서버가 종료되었습니다. 종료 코드: %KREAM_SERVER_EXIT%
echo 위에 표시된 Node.js 오류 내용을 확인하세요.
pause
exit /b %KREAM_SERVER_EXIT%

:start_login_chrome
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "KREAM_CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined KREAM_CHROME_EXE if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "KREAM_CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined KREAM_CHROME_EXE if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "KREAM_CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"
for /f "delims=" %%I in ('where.exe chrome.exe 2^>nul') do if not defined KREAM_CHROME_EXE set "KREAM_CHROME_EXE=%%~fI"
if not defined KREAM_CHROME_EXE goto chrome_not_found

echo Chrome 경로: %KREAM_CHROME_EXE%
start "" "%KREAM_CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%KREAM_PROJECT_ROOT%\chrome-profile" --no-first-run --no-default-browser-check "https://partner.kream.co.kr/business/ask-sales"
exit /b 0

:chrome_not_found
echo [경고] Google Chrome을 찾지 못했습니다.
echo 서버는 실행하지만 Playwright 기능을 사용하려면 Chrome을 설치하고 CDP 9222로 실행해야 합니다.
exit /b 0

:project_path_error
echo [오류] start.bat 파일이 있는 프로젝트 폴더로 이동하지 못했습니다.
goto fail

:node_missing
echo [오류] Node.js를 찾을 수 없습니다.
echo Node.js LTS를 설치한 뒤 새 CMD 창에서 다시 실행하세요.
goto fail

:package_missing
echo [오류] 프로젝트 경로에 package.json이 없습니다.
echo 현재 경로: %KREAM_PROJECT_ROOT%
goto fail

:app_missing
echo [오류] 프로젝트 경로에 app.js가 없습니다.
echo 현재 경로: %KREAM_PROJECT_ROOT%
goto fail

:npm_missing
echo [오류] npm.cmd를 찾을 수 없습니다.
echo Node.js LTS 설치를 복구한 뒤 다시 실행하세요.
goto fail

:npm_install_failed
echo [오류] npm install 실행에 실패했습니다.
goto fail

:npm_ci_failed
echo [오류] npm ci 실행에 실패했습니다.
goto fail

:fail
echo.
echo 설치 경로, Node.js 설치 상태와 위 오류 메시지를 확인하세요.
pause
exit /b 1
