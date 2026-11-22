# ============================================================
#  AMADEUS DISCORD : installation (une fois)
#    - relie ce dossier au projet principal Amadeus, installe juste a cote
#      (..\amadeus) : environnement Python, moteur de voix, voix de Kurisu
#    - cree backend\.env (cles reprises du projet principal, port 8643,
#      memoire separee) et discord-bot\.env (token du compte Amadeus)
#    - installe les modules du bot (npm install)
# ============================================================
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Main = Join-Path (Split-Path -Parent $Root) 'amadeus'

function Say($msg, $color = 'Cyan') { Write-Host "[AMADEUS-DISCORD] $msg" -ForegroundColor $color }

if (-not (Test-Path (Join-Path $Main 'backend\venv\Scripts\python.exe'))) {
    throw "Projet principal introuvable ou pas installe : clone https://github.com/rbloxicraft/amadeus dans $Main et lance son install.bat d'abord."
}

# 1. liens vers le projet principal (rien n'est copie ni telecharge deux fois)
$links = @{
    'backend\venv'             = 'backend\venv'
    'tts-server\GPT-SoVITS'    = 'tts-server\GPT-SoVITS'
    'tts-server\ffmpeg-shared' = 'tts-server\ffmpeg-shared'
    'tts-server\kurisu'        = 'tts-server\kurisu'
}
foreach ($rel in $links.Keys) {
    $link = Join-Path $Root $rel
    $target = Join-Path $Main $links[$rel]
    if (Test-Path $link) { Say "  - $rel : deja present"; continue }
    if (-not (Test-Path $target)) { throw "Absent du projet principal : $target (relance son install.bat)" }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Say "  - $rel : relie au projet principal"
}

# 2. backend\.env : cles du projet principal, port et memoire du fork
$envFile = Join-Path $Root 'backend\.env'
if (-not (Test-Path $envFile)) {
    $src = Join-Path $Main 'backend\.env'
    if (-not (Test-Path $src)) { $src = Join-Path $Root 'backend\.env.example' }
    $override = @{ 'BACKEND_PORT' = '8643'; 'DATA_DIR' = '../data'; 'STT_LANGUAGE' = 'fr' }
    $lines = Get-Content $src | Where-Object { $_ -notmatch '^(BACKEND_PORT|DATA_DIR|STT_LANGUAGE)=' }
    $lines += $override.Keys | ForEach-Object { "$_=$($override[$_])" }
    Set-Content -Path $envFile -Value $lines -Encoding utf8
    Say '  - backend\.env cree (cles du projet principal, port 8643, memoire a part)'
} else { Say '  - backend\.env : deja present' }

# 3. discord-bot\.env : token du compte Discord DEDIE a Amadeus
$botEnv = Join-Path $Root 'discord-bot\.env'
if (-not (Test-Path $botEnv)) {
    Copy-Item (Join-Path $Root 'discord-bot\.env.example') $botEnv
    Say '  - discord-bot\.env cree : mets-y le token du compte Amadeus (voir README)' Yellow
} else { Say '  - discord-bot\.env : deja present' }

# 4. modules du bot
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'Node.js introuvable : installe-le (https://nodejs.org), puis relance.' }
Push-Location (Join-Path $Root 'discord-bot')
try { npm install --no-fund --no-audit; if ($LASTEXITCODE) { throw 'npm install a echoue' } } finally { Pop-Location }

Say 'Installation terminee. Lance start_discord.bat.' Green
