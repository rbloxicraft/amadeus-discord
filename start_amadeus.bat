@echo off
rem ============================================================
rem  AMADEUS : demarre la voix de Kurisu (GPT-SoVITS) et le backend,
rem  attend qu'ils repondent, puis ouvre l'interface.
rem  Toute la logique est dans scripts\amadeus.ps1
rem  (fichier en ASCII + fins de ligne Windows : cmd l'exige)
rem ============================================================
title Amadeus - demarrage
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\amadeus.ps1" start %*
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
ping -n 5 127.0.0.1 >nul
exit /b 0
