@echo off
rem ============================================================
rem  AMADEUS DISCORD : voix + backend Discord + bot, puis la page de
rem  configuration (http://127.0.0.1:8643/admin). Logique : scripts\discord.ps1
rem ============================================================
title Amadeus Discord - demarrage
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\discord.ps1" start %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
ping -n 5 127.0.0.1 >nul
exit /b 0
