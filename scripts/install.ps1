# ============================================================
#  AMADEUS : installation complete (Windows 10/11)
#
#    install.bat                 installation interactive (conseille)
#    install.ps1 -NoVoice        sans la voix GPT-SoVITS (voix de secours)
#    install.ps1 -LlmKey ... [-LlmUrl ... -LlmModel ...] [-GroqKey ...] -Yes   sans questions
#
#  Chaque etape est sautee si elle est deja faite : relancer le script
#  repare une installation incomplete sans tout retelecharger.
#  Fichier en ASCII : PowerShell 5.1 lit les scripts sans BOM en ANSI.
# ============================================================
param(
    [switch]$NoVoice,
    [string]$LlmKey = '',
    [string]$LlmUrl = '',
    [string]$LlmModel = '',
    [string]$GroqKey = '',
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest 10x plus rapide sans barre

$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root 'backend'
$Tts = Join-Path $Root 'tts-server'
$Gs = Join-Path $Tts 'GPT-SoVITS'
$BackPy = Join-Path $Backend 'venv\Scripts\python.exe'
$GsPy = Join-Path $Gs 'venv\Scripts\python.exe'
$EnvFile = Join-Path $Backend '.env'

# Version de GPT-SoVITS testee avec Amadeus (le patch s'applique sur celle-ci)
$GsRepo = 'https://github.com/RVC-Boss/GPT-SoVITS.git'
$GsCommit = '6d51ffceafbf240145619af4c92408a6e54b7924'
$TorchIndex = 'https://download.pytorch.org/whl/cu126'
# Modules C++ precompiles pour Windows / Python 3.12 (publication GitHub du projet)
$WheelsUrl = 'https://github.com/rbloxicraft/amadeus/releases/download/deps-win-py312'
$Wheels = @('pyopenjtalk-0.4.1-cp312-cp312-win_amd64.whl', 'jieba_fast-0.53-cp312-cp312-win_amd64.whl')

$Logs = Join-Path $Root 'data'
New-Item -ItemType Directory -Force $Logs | Out-Null
$LogFile = Join-Path $Logs 'install.log'

# ------------------------------------------------------------ affichage

$script:Step = 0
$script:Steps = 7
function Title($msg) {
    $script:Step++
    Write-Host ''
    Write-Host "[$($script:Step)/$($script:Steps)] $msg" -ForegroundColor Cyan
}
function Info($msg) { Write-Host "    $msg" }
function Ok($msg) { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !   $msg" -ForegroundColor Yellow }
function Fail($msg) { throw $msg }

function Ask([string]$question, [bool]$default = $true) {
    if ($Yes) { return $default }
    $hint = if ($default) { '[O/n]' } else { '[o/N]' }
    $a = Read-Host "    $question $hint"
    if ([string]::IsNullOrWhiteSpace($a)) { return $default }
    return $a.Trim().ToLower().StartsWith('o') -or $a.Trim().ToLower().StartsWith('y')
}

# Lance un programme (arguments passes tels quels, chemins avec espaces compris),
# journalise sa sortie et echoue proprement s'il echoue. -Live : affiche aussi la
# sortie (telechargements longs : on voit que ca avance).
function Run([string]$exe, [string[]]$arguments, [string]$what, [string]$cwd = $Root, [switch]$Live) {
    Add-Content -Path $LogFile -Value "`r`n===== $what`r`n> $exe $($arguments -join ' ')" -Encoding UTF8
    Push-Location $cwd
    # PowerShell 5.1 transforme chaque ligne de stderr (avertissements de pip, progression
    # de git) en erreur : avec 'Stop' la premiere ferait echouer l'etape.
    $eap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $env:PYTHONIOENCODING = 'utf-8'
        & $exe @arguments 2>&1 | ForEach-Object {
            $line = "$_"
            Add-Content -Path $LogFile -Value $line -Encoding UTF8
            if ($Live) { Write-Host "      $line" }
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $eap
        Pop-Location
    }
    if ($code -ne 0) { Fail "$what a echoue (code $code). Details : data\install.log" }
}

# ------------------------------------------------------------ prerequis

function Find-Python312 {
    $ErrorActionPreference = 'Continue'
    foreach ($cand in @(@('py', '-3.12'), @('python'), @('python3'))) {
        $exe = $cand[0]
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        $args2 = @($cand | Select-Object -Skip 1) + @('-c', 'import sys;print(sys.executable);print(sys.version_info[:2]==(3,12))')
        try {
            $out = & $exe @args2 2>$null
            if ($LASTEXITCODE -eq 0 -and $out.Count -ge 2 -and $out[1] -eq 'True') { return $out[0] }
        } catch { }
    }
    return $null
}

function Install-WithWinget([string]$id, [string]$name) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Fail "$name est introuvable et winget n'est pas disponible. Installe $name a la main (voir README), puis relance install.bat."
    }
    if (-not (Ask "$name est introuvable. L'installer maintenant avec winget ?")) {
        Fail "$name est necessaire. Installe-le (voir README), puis relance install.bat."
    }
    Info "Installation de $name (une fenetre d'autorisation peut s'ouvrir)..."
    & winget install --id $id -e --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -ne 0) { Fail "L'installation de $name a echoue. Installe-le a la main, puis relance install.bat." }
    # rend les nouveaux programmes visibles dans cette fenetre
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Check-Prereqs {
    Title 'Verification de la machine'
    $script:Python = Find-Python312
    if (-not $script:Python) {
        Install-WithWinget 'Python.Python.3.12' 'Python 3.12'
        $script:Python = Find-Python312
        if (-not $script:Python) { Fail "Python 3.12 installe mais introuvable : ferme cette fenetre et relance install.bat." }
    }
    Ok "Python 3.12 : $($script:Python)"

    if (-not $NoVoice -and -not (Get-Command git -ErrorAction SilentlyContinue)) {
        Install-WithWinget 'Git.Git' 'Git'
        if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "Git installe mais introuvable : ferme cette fenetre et relance install.bat." }
    }
    if (-not $NoVoice) { Ok 'Git' }

    $script:Voice = -not $NoVoice
    if ($script:Voice) {
        $gpu = $null
        if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
            try { $gpu = (& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>$null | Select-Object -First 1) } catch { }
        }
        if ($gpu) {
            Ok "Carte graphique NVIDIA : $gpu"
        } else {
            Warn 'Aucune carte graphique NVIDIA detectee.'
            Warn 'La vraie voix de Kurisu (GPT-SoVITS) en a besoin ; sans elle, une voix de secours est utilisee.'
            $script:Voice = Ask 'Installer quand meme la voix GPT-SoVITS ?' $false
        }
    }

    $drive = (Get-Item $Root).PSDrive
    $freeGb = [math]::Round($drive.Free / 1GB)
    $needGb = if ($script:Voice) { 15 } else { 5 }
    if ($freeGb -lt $needGb) {
        Warn "Seulement $freeGb Go libres sur $($drive.Name): (environ $needGb Go necessaires)."
        if (-not (Ask 'Continuer quand meme ?' $false)) { Fail 'Installation annulee : libere de la place puis relance install.bat.' }
    } else { Ok "Espace disque : $freeGb Go libres" }
}

# ------------------------------------------------------------ backend

function Install-Backend {
    Title 'Backend (cerveau, oreilles, memoire)'
    if (-not (Test-Path $BackPy)) {
        Info 'Creation de l environnement Python...'
        Run $script:Python @('-m', 'venv', (Join-Path $Backend 'venv')) 'Creation du venv backend'
    }
    Info 'Installation des paquets (quelques minutes la premiere fois)...'
    Run $BackPy @('-m', 'pip', 'install', '--upgrade', 'pip') 'Mise a jour de pip (backend)'
    Run $BackPy @('-m', 'pip', 'install', '--progress-bar', 'off', '-r', 'requirements.txt', '-c', 'constraints.txt') 'Paquets du backend' $Backend -Live
    Ok 'Backend installe'
}

# ------------------------------------------------------------ voix

function Install-GptSovits {
    Title 'Voix de Kurisu : moteur GPT-SoVITS'
    if (-not (Test-Path (Join-Path $Gs '.git'))) {
        Info 'Telechargement de GPT-SoVITS...'
        Run 'git' @('clone', '--quiet', $GsRepo, $Gs) 'Clonage de GPT-SoVITS' -Live
    }
    Run 'git' @('-c', 'advice.detachedHead=false', 'checkout', '--quiet', $GsCommit) 'Version de GPT-SoVITS' $Gs

    # correctifs d'Amadeus (cache des voix par emotion, arret propre des phrases interrompues)
    $patch = Join-Path $Tts 'patches\gpt-sovits-amadeus.patch'
    $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & git -C $Gs apply --reverse --check $patch 2>&1 | Out-Null
    $applied = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $eap
    if ($applied) {
        Ok 'Correctifs Amadeus deja appliques'
    } else {
        Run 'git' @('apply', '--whitespace=nowarn', $patch) 'Correctifs Amadeus pour GPT-SoVITS' $Gs
        Ok 'Correctifs Amadeus appliques'
    }

    if (-not (Test-Path $GsPy)) {
        Info 'Creation de l environnement Python de la voix...'
        Run $script:Python @('-m', 'venv', (Join-Path $Gs 'venv')) 'Creation du venv GPT-SoVITS'
    }
    Run $GsPy @('-m', 'pip', 'install', '--upgrade', 'pip') 'Mise a jour de pip (voix)'
    Info 'Installation de PyTorch pour carte graphique (~2,5 Go, patience)...'
    $cons = Join-Path $Tts 'constraints-gpt-sovits.txt'
    Run $GsPy @('-m', 'pip', 'install', '--progress-bar', 'off', 'torch', 'torchaudio', 'torchcodec',
        '--extra-index-url', $TorchIndex, '-c', $cons) 'PyTorch CUDA' -Live
    # pyopenjtalk (lecture du japonais) et jieba_fast n'existent qu'en code C++ a compiler :
    # versions deja compilees pour Windows, jointes a la publication GitHub du projet
    Info 'Installation des modules compiles (japonais)...'
    foreach ($whl in $Wheels) {
        Run $GsPy @('-m', 'pip', 'install', '--progress-bar', 'off', '--no-deps', "$WheelsUrl/$whl") "Module $whl"
    }
    Info 'Installation des paquets de la voix...'
    Run $GsPy @('-m', 'pip', 'install', '--progress-bar', 'off', '-r', (Join-Path $Tts 'requirements-gpt-sovits.txt'),
        '-c', $cons, '--extra-index-url', $TorchIndex) 'Paquets de GPT-SoVITS' -Live
    Ok 'Moteur de voix installe'
}

function Install-FFmpeg {
    $dest = Join-Path $Tts 'ffmpeg-shared'
    if (Test-Path (Join-Path $dest 'bin\ffmpeg.exe')) { Ok 'FFmpeg deja present'; return }
    Info 'Telechargement de FFmpeg (bibliotheques audio)...'
    # build public BtbN, version 8.x "shared" (DLL dont torchcodec a besoin)
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest' -Headers @{ 'User-Agent' = 'amadeus-installer' }
    $asset = $rel.assets | Where-Object { $_.name -match '^ffmpeg-n(\d+)\.(\d+)-latest-win64-gpl-shared-.*\.zip$' -and [int]$Matches[1] -le 8 } |
        Sort-Object { [version]($_.name -replace '^ffmpeg-n(\d+\.\d+).*$', '$1') } -Descending | Select-Object -First 1
    if (-not $asset) { Fail "Archive FFmpeg introuvable. Telecharge une version 'win64-gpl-shared' 8.x sur github.com/BtbN/FFmpeg-Builds et extrais-la dans tts-server\ffmpeg-shared." }
    $zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $tmp = Join-Path $env:TEMP 'amadeus-ffmpeg'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $inner = Get-ChildItem $tmp -Directory | Select-Object -First 1
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item $inner.FullName $dest
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Ok "FFmpeg installe ($($asset.name))"
}

function Install-VoiceModel {
    Title 'Voix de Kurisu : modele et extraits de reference'
    Install-FFmpeg
    Info 'Telechargement depuis Hugging Face (~1,5 Go la premiere fois)...'
    Run $GsPy @('download_models.py') 'Telechargement des modeles de voix' $Tts -Live
    Info 'Transcription des extraits de reference (Whisper, ~1 min la premiere fois)...'
    Run $BackPy @('-m', 'tools.transcribe_refs') 'Transcription des extraits' $Backend -Live
    Ok 'Voix de Kurisu prete'
}

# ------------------------------------------------------------ cles API

function Set-EnvValue([string]$key, [string]$value) {
    $lines = @(Get-Content $EnvFile -Encoding UTF8)
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^\s*#?\s*$key=") { $lines[$i] = "$key=$value"; $found = $true; break }
    }
    if (-not $found) { $lines += "$key=$value" }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllLines($EnvFile, $lines, $utf8)
}

function Get-EnvValue([string]$key) {
    if (-not (Test-Path $EnvFile)) { return '' }
    $m = Select-String -Path $EnvFile -Pattern "^\s*$key=(.*)$" -Encoding UTF8 | Select-Object -First 1
    if ($m) { return $m.Matches[0].Groups[1].Value.Trim() } else { return '' }
}

function Read-Secret([string]$prompt) {
    $s = Read-Host "    $prompt" -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b).Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Configure-Keys {
    Title 'Cle d API d IA (le cerveau de Kurisu)'
    if (-not (Test-Path $EnvFile)) {
        Copy-Item (Join-Path $Backend '.env.example') $EnvFile
        Info 'Fichier backend\.env cree.'
    }
    $mainKey = Get-EnvValue 'LLM_API_KEY'
    if (-not $mainKey) { $mainKey = Get-EnvValue 'GLM_API_KEY' }   # ancien nom
    $hasMain = $mainKey -notin @('', 'colle-ta-cle-ici')
    $hasGroq = (Get-EnvValue 'GROQ_API_KEY') -ne ''

    # mode sans questions (parametres)
    if ($LlmKey) { Set-EnvValue 'LLM_API_KEY' $LlmKey; $hasMain = $true }
    if ($LlmUrl) { Set-EnvValue 'LLM_BASE_URL' $LlmUrl }
    if ($LlmModel) { Set-EnvValue 'LLM_MODEL' $LlmModel }
    if ($GroqKey) { Set-EnvValue 'GROQ_API_KEY' $GroqKey; $hasGroq = $true }
    if ($LlmKey -or $GroqKey -or $Yes) {
        if (-not $hasMain -and $hasGroq) { Set-EnvValue 'BRAIN' 'gptoss' }
        if ($hasMain -or $hasGroq) { Ok 'Cles enregistrees dans backend\.env' } else { Warn 'Aucune cle d API : ajoute-la dans backend\.env' }
        return
    }

    if (($hasMain -or $hasGroq) -and -not (Ask 'Une cle d API est deja configuree. La changer ?' $false)) {
        Ok 'Cles conservees'
        return
    }
    Info 'Kurisu a besoin d une cle d API d IA (compatible OpenAI). Recommandations :'
    Info '  1) Z.ai     -> https://z.ai              le plus fidele au personnage (payant, peu cher)'
    Info '  2) Groq     -> https://console.groq.com  gratuit et tres rapide, japonais un peu moins naturel'
    Info '  3) Autre fournisseur compatible OpenAI (adresse et modele a saisir)'
    $choice = (Read-Host '    Ton choix (1, 2 ou 3) [1]').Trim()

    if ($choice -eq '2') {
        $key = Read-Secret 'Colle ta cle Groq (elle ne s affiche pas) puis Entree'
        if ($key) {
            Set-EnvValue 'GROQ_API_KEY' $key
            Set-EnvValue 'BRAIN' 'gptoss'
            Ok 'Cle Groq enregistree (cerveau rapide)'
        } else { Warn 'Pas de cle : Kurisu ne pourra pas repondre. Relance install.bat plus tard.' }
        Info 'Plus tard, tu pourras ajouter une 2e cle (Z.ai...) et choisir le cerveau dans Reglages.'
        return
    }

    if ($choice -eq '3') {
        Info 'Exemple d adresse : https://api.fournisseur.com/v1 (voir la documentation du fournisseur).'
        $url = (Read-Host '    Adresse de l API (base URL)').Trim()
        $model = (Read-Host '    Nom du modele').Trim()
        if ($url) { Set-EnvValue 'LLM_BASE_URL' $url }
        if ($model) { Set-EnvValue 'LLM_MODEL' $model }
    } else {
        Set-EnvValue 'LLM_BASE_URL' 'https://api.z.ai/api/paas/v4'
        Set-EnvValue 'LLM_MODEL' 'glm-5.3'
    }
    $key = Read-Secret 'Colle ta cle d API (elle ne s affiche pas) puis Entree'
    if ($key) {
        Set-EnvValue 'LLM_API_KEY' $key
        Ok 'Cle d API enregistree'
    } else {
        Warn 'Pas de cle : Kurisu ne pourra pas repondre. Relance install.bat ou edite backend\.env plus tard.'
    }

    if (-not $hasGroq -and (Ask 'Ajouter aussi une cle Groq (gratuite, cerveau ~1 s plus rapide, facultatif) ?' $false)) {
        Info 'Cree-la sur https://console.groq.com (menu API Keys).'
        $key = Read-Secret 'Colle ta cle Groq (elle ne s affiche pas) puis Entree'
        if ($key) { Set-EnvValue 'GROQ_API_KEY' $key; Ok 'Cle Groq enregistree' }
    }
    Info 'Tes cles restent sur ta machine, dans backend\.env (jamais envoye sur GitHub).'
}

# ------------------------------------------------------------ avatar

function Check-Assets {
    Title 'Avatar et logo (facultatifs)'
    $vrm = Join-Path $Root 'frontend\vendor\models\kurisu.vrm'
    if (Test-Path $vrm) { Ok 'Modele 3D present (frontend\vendor\models\kurisu.vrm)' }
    else {
        Info 'Aucun modele 3D : un noyau holographique s affiche a la place.'
        Info 'Pour un avatar : depose un fichier .vrm sur la fenetre d Amadeus,'
        Info 'ou copie-le en frontend\vendor\models\kurisu.vrm (voir README).'
    }
    $logo = Join-Path $Root 'frontend\vendor\brand\amadeus-logo.png'
    if (Test-Path $logo) { Ok 'Logo present' } else { Info 'Pas de logo image : le nom AMADEUS s affiche en texte.' }
}

# ------------------------------------------------------------ main

try {
    Set-Content -Path $LogFile -Value "Installation Amadeus $(Get-Date -Format s)" -Encoding UTF8
    Write-Host ''
    Write-Host '  AMADEUS : installation' -ForegroundColor Cyan
    Write-Host '  Journal detaille : data\install.log'

    Check-Prereqs
    if (-not $script:Voice) { $script:Steps = 5 }
    Install-Backend
    if ($script:Voice) {
        Install-GptSovits
        Install-VoiceModel
    } else {
        Warn 'Voix GPT-SoVITS non installee : Kurisu parlera avec la voix de secours (edge-tts).'
    }
    Configure-Keys
    Check-Assets

    Title 'Termine'
    Ok 'Amadeus est installe.'
    Info 'Lance start_amadeus.bat (double-clic) pour demarrer.'
    Info 'Au premier lancement, Whisper et la memoire telechargent leurs modeles (~2 Go) : compte 1 a 3 min.'
    exit 0
} catch {
    Write-Host ''
    Write-Host "  ERREUR : $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Corrige le probleme puis relance install.bat : les etapes deja faites seront sautees.'
    exit 1
}
