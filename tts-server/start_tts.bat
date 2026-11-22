@echo off
rem ============================================================
rem  AMADEUS TTS : serveur de voix Kurisu (GPT-SoVITS api_v2)
rem  Ecoute sur http://127.0.0.1:9880
rem ============================================================
cd /d "%~dp0GPT-SoVITS"

rem DLLs FFmpeg partagees requises par torchcodec (torchaudio)
set "PATH=%~dp0ffmpeg-shared\bin;%PATH%"

title Amadeus-Voix
echo [AMADEUS-TTS] Chargement du modele Kurisu (premiere fois : ~30 s)...
venv\Scripts\python api_v2.py -a 127.0.0.1 -p 9880
pause
