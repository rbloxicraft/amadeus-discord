# ============================================================
#  AMADEUS DISCORD : demarrage / arret
#    discord.ps1 start : voix (partagee avec ton Amadeus perso), backend Discord
#                        (port 8643, sa propre memoire), Amadeus dans Discord
#                        (Edge pilote : vocal + partage de la scene), puis la page
#                        de configuration
#    discord.ps1 stop  : arrete Amadeus et le backend Discord. La voix reste
#                        allumee (ton Amadeus perso l'utilise aussi) ; -All l'arrete.
#  Processus reperes par port et par chemin du fork, jamais par titre de fenetre.
#  Fichier en ASCII : PowerShell 5.1 lit les scripts sans BOM en ANSI.
# ============================================================
param(
    [ValidateSet('start', 'stop')][string]$Action = 'start',
    [switch]$NoBrowser,
    [switch]$All
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Py = Join-Path $Root 'backend\venv\Scripts\python.exe'
$Bot = Join-Path $Root 'discord-bot\amadeus-client.mjs'
$VoiceBat = Join-Path $Root 'tts-server\start_tts.bat'
$VoiceUrl = 'http://127.0.0.1:9880/docs'
$ApiUrl = 'http://127.0.0.1:8643/api/health'
$StatusUrl = 'http://127.0.0.1:8643/api/discord/status'

function Say($msg, $color = 'Gray') { Write-Host "[AMADEUS-DISCORD] $msg" -ForegroundColor $color }

function Test-Url([string]$url, [int]$timeoutMs = 2500) {
    try {
        $req = [System.Net.HttpWebRequest]::Create($url)
        $req.Proxy = $null
        $req.Timeout = $timeoutMs
        $req.GetResponse().Close()
        return $true
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) { $_.Exception.Response.Close(); return $true }
        return $false
    }
}

function Get-PortOwners([int]$port) {
    @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
}

# fenetres cmd lancees par ce script pour un service du fork (marqueur dans la ligne de commande)
function Get-Hosts([string]$marker) {
    @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -ieq 'cmd.exe' -and $_.CommandLine -and
        $_.CommandLine.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine.Contains($marker)
    } | Select-Object -ExpandProperty ProcessId)
}

function Stop-Tree([int[]]$ids) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $kill = New-Object System.Collections.Generic.List[int]
    $queue = New-Object System.Collections.Generic.Queue[int]
    foreach ($id in $ids) { if ($id -gt 0 -and -not $kill.Contains($id)) { $kill.Add($id); $queue.Enqueue($id) } }
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        foreach ($c in $all) {
            $cid = [int]$c.ProcessId
            if ($c.ParentProcessId -eq $parent -and -not $kill.Contains($cid)) { $kill.Add($cid); $queue.Enqueue($cid) }
        }
    }
    for ($i = $kill.Count - 1; $i -ge 0; $i--) { Stop-Process -Id $kill[$i] -Force -ErrorAction SilentlyContinue }
}

function Bot-Connected {
    try {
        $r = Invoke-RestMethod -Uri $StatusUrl -TimeoutSec 3
        return [bool]$r.bot_connected
    } catch { return $false }
}

function Start-All {
    if (-not (Test-Path $Py)) { throw "Environnement Python introuvable ($Py) : installe d'abord Amadeus (install.bat du projet principal)." }
    if (-not (Test-Path (Join-Path $Root 'discord-bot\node_modules'))) { throw "Modules du bot absents : lance npm install dans discord-bot." }
    if (-not (Select-String -Path (Join-Path $Root 'discord-bot\.env') -Pattern '^DISCORD_USER_TOKEN=.+' -Quiet)) {
        throw "Token du compte Amadeus absent de discord-bot\.env (DISCORD_USER_TOKEN=...)."
    }

    # 1. voix (partagee)
    if (Test-Url $VoiceUrl) { Say 'Voix de Kurisu : deja en ligne.' Green }
    elseif ((Get-PortOwners 9880).Count -gt 0) { Say 'Voix de Kurisu : en cours de demarrage.' }
    else {
        Say 'Demarrage : voix de Kurisu...'
        Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$VoiceBat`"" -WindowStyle Minimized | Out-Null
    }

    # 2. backend Discord (port 8643)
    if (Test-Url $ApiUrl) { Say 'Backend Discord : deja en ligne.' Green }
    else {
        $stale = Get-Hosts 'amadeus-discord-backend'
        if ($stale.Count) { Stop-Tree $stale }
        Say 'Demarrage : backend Discord...'
        Start-Process -FilePath 'cmd.exe' -WorkingDirectory (Join-Path $Root 'backend') `
            -ArgumentList '/k', "title Amadeus-Discord-Backend & set AMADEUS_ROLE=amadeus-discord-backend& `"$Py`" -m app.main" | Out-Null
    }
    $t0 = Get-Date
    while (-not (Test-Url $ApiUrl)) {
        if (((Get-Date) - $t0).TotalSeconds -gt 150) { throw 'Le backend Discord ne repond pas : regarde la fenetre Amadeus-Discord-Backend.' }
        Start-Sleep -Milliseconds 700
    }
    Say "Backend Discord : en ligne ($([int]((Get-Date) - $t0).TotalSeconds) s)." Green

    # 3. bot
    if (Bot-Connected) { Say 'Amadeus (Discord) : deja lancee.' Green }
    else {
        $stale = Get-Hosts 'amadeus-discord-bot'
        if ($stale.Count) { Stop-Tree $stale }
        Say 'Demarrage : Amadeus dans Discord (fenetres Edge : scene + Discord)...'
        Start-Process -FilePath 'cmd.exe' -WorkingDirectory (Join-Path $Root 'discord-bot') `
            -ArgumentList '/k', "title Amadeus-Discord-Bot & set AMADEUS_ROLE=amadeus-discord-bot& node `"$Bot`"" | Out-Null
        $t0 = Get-Date
        while (-not (Bot-Connected)) {
            if (((Get-Date) - $t0).TotalSeconds -gt 90) { throw 'Amadeus ne se connecte pas : regarde la fenetre Amadeus-Discord-Bot et data\amadeus-client.log.' }
            Start-Sleep -Milliseconds 700
        }
        Say 'Amadeus (Discord) : connectee.' Green
    }

    if (-not (Test-Url $VoiceUrl)) { Say 'La voix finit de charger : Amadeus parlera des qu elle sera prete.' Yellow }
    if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8643/admin' | Out-Null }
    Say 'Configuration : http://127.0.0.1:8643/admin' Green
    Say 'Pour arreter : stop_discord.bat'
}

function Stop-All {
    Say 'Arret...'
    $bot = Get-Hosts 'amadeus-discord-bot'
    if ($bot.Count) { Stop-Tree $bot; Say '  - Amadeus (Discord) : arretee' } else { Say '  - Amadeus (Discord) : deja arretee' }
    $back = @(Get-Hosts 'amadeus-discord-backend') + @(Get-PortOwners 8643)
    $back = @($back | Where-Object { $_ } | Select-Object -Unique)
    if ($back.Count) { Stop-Tree $back; Say '  - backend Discord : arrete' } else { Say '  - backend Discord : deja arrete' }
    if ($All) {
        $voice = Get-PortOwners 9880
        if ($voice.Count) { Stop-Tree $voice; Say '  - voix : arretee' }
    } else {
        Say '  - voix : laissee allumee (partagee avec ton Amadeus perso ; -All pour l arreter)'
    }
    Say 'Termine.' Green
}

try {
    if ($Action -eq 'stop') { Stop-All } else { Start-All }
    exit 0
} catch {
    Say $_.Exception.Message Red
    exit 1
}
