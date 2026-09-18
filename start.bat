@echo off
title Unimote TestTV
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Get it from https://nodejs.org
  pause
  exit /b 1
)
echo Starting Unimote TestTV... (close this window to stop)
node tv.js
pause
