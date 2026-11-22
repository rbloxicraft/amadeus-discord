@echo off
rem ============================================================
rem  AMADEUS : installation (double-clic). Toute la logique est
rem  dans scripts\install.ps1 ; relancer repare une installation
rem  incomplete sans tout retelecharger.
rem ============================================================
title Amadeus - installation
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
