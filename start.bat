@echo off
title KREAM BOT START

cd /d C:\Users\tmdal\Desktop\kream-snkr-bot

echo ==============================
echo Starting Chrome...
echo ==============================

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug" https://partner.kream.co.kr/business/ask-sales

timeout /t 5 >nul

echo ==============================
echo Starting Node Server...
echo ==============================

start "KREAM BOT SERVER" cmd /k "cd /d C:\Users\tmdal\Desktop\kream-snkr-bot && node app.js"

timeout /t 5 >nul

echo ==============================
echo Opening Web UI...
echo ==============================

start "" http://localhost:3000

exit