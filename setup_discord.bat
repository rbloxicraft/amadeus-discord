@echo off
rem ============================================================
rem  AMADEUS DISCORD : installation (une fois). Le projet principal
rem  Amadeus doit etre installe juste a cote (..\amadeus).
rem ============================================================
title Amadeus Discord - installation
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\discord-setup.ps1"
echo.
pause
