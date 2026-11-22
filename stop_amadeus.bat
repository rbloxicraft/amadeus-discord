@echo off
rem ============================================================
rem  AMADEUS : arrete la voix de Kurisu et le backend
rem  (par chemin et par port, sans fermer tes autres terminaux)
rem ============================================================
title Amadeus - arret
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\amadeus.ps1" stop
ping -n 4 127.0.0.1 >nul
exit /b 0
