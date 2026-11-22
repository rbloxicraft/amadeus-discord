@echo off
rem ============================================================
rem  AMADEUS DISCORD : arrete le bot et le backend Discord.
rem  La voix reste allumee (partagee) ; stop_discord.bat -All l'arrete aussi.
rem ============================================================
title Amadeus Discord - arret
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\discord.ps1" stop %*
ping -n 4 127.0.0.1 >nul
exit /b 0
