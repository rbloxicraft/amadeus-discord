# ============================================================
#  AMADEUS : demarrage / arret des services
#    amadeus.ps1 start  : voix (GPT-SoVITS) + backend, attend qu'ils
#                         repondent, puis ouvre l'interface
#    amadeus.ps1 stop   : arrete tout
#  Les processus sont reperes par leur chemin et leur port, jamais par le
#  titre de fenetre (sous Windows Terminal, le titre appartient au terminal
#  entier : le tuer fermerait aussi tes autres onglets).
#  Fichier en ASCII : PowerShell 5.1 lit les scripts sans BOM en ANSI.
# ============================================================
param(
    [ValidateSet('start', 'stop')][string]$Action = 'start',
    [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Services = @(
    [pscustomobject]@{
        Key = 'voice'; Name = 'Voix de Kurisu (GPT-SoVITS)'; Port = 9880
        Url = 'http://127.0.0.1:9880/docs'
        Python = Join-Path $Root 'tts-server\GPT-SoVITS\venv\Scripts\python.exe'
        Marker = 'api_v2.py'; Required = $false; MaxWait = 240
    },
    [pscustomobject]@{
        Key = 'backend'; Name = 'Backend Amadeus'; Port = 8642
        Url = 'http://127.0.0.1:8642/api/health'
        Python = Join-Path $Root 'backend\venv\Scripts\python.exe'
        Marker = 'app.main'; Required = $true; MaxWait = 150
    }
)

function Say($msg, $color = 'Gray') { Write-Host "[AMADEUS] $msg" -ForegroundColor $color }

# Le serveur repond-il ? (toute reponse HTTP compte, meme 404 ; pas de proxy)
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

# Processus du service : le python du venv (et son enfant) + la fenetre cmd qui l'heberge
function Get-ServiceProcs($svc) {
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $launchers = @($all | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $svc.Python })
    $hosts = @($all | Where-Object {
        $_.Name -ieq 'cmd.exe' -and $_.CommandLine -and
        $_.CommandLine.IndexOf($Root, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        ($_.CommandLine -match [regex]::Escape($(if ($svc.Key -eq 'voice') { 'start_tts.bat' } else { 'app.main' })))
    })
    $children = @($all | Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($svc.Marker) -and
        ($launchers.ProcessId -contains $_.ParentProcessId) })
    [pscustomobject]@{ Launchers = $launchers; Hosts = $hosts; Children = $children }
}

# Arrete les processus et tous leurs descendants (un processus deja parti n'est pas une erreur)
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
    # les enfants d'abord : le python qui tient le port avant sa fenetre
    for ($i = $kill.Count - 1; $i -ge 0; $i--) {
        Stop-Process -Id $kill[$i] -Force -ErrorAction SilentlyContinue
    }
}

function Stop-AmadeusService($svc) {
    $p = Get-ServiceProcs $svc
    $ids = @($p.Hosts.ProcessId) + @($p.Launchers.ProcessId) + @($p.Children.ProcessId) + @(Get-PortOwners $svc.Port)
    $ids = @($ids | Where-Object { $_ } | Select-Object -Unique)
    if ($ids.Count -eq 0) { Say "  - $($svc.Name) : deja arrete"; return }
    Stop-Tree $ids
    for ($i = 0; $i -lt 20 -and (Get-PortOwners $svc.Port).Count -gt 0; $i++) { Start-Sleep -Milliseconds 250 }
    Say "  - $($svc.Name) : arrete"
}

function Start-Voice($svc) {
    $bat = Join-Path $Root 'tts-server\start_tts.bat'
    # fenetre reduite ; elle reste ouverte en cas d'erreur (pause dans start_tts.bat)
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$bat`"" -WindowStyle Minimized | Out-Null
}

function Start-Backend($svc) {
    $dir = Join-Path $Root 'backend'
    Start-Process -FilePath 'cmd.exe' -WorkingDirectory $dir `
        -ArgumentList '/k', "title Amadeus-Backend & `"$($svc.Python)`" -m app.main" | Out-Null
}

# Lance le service s'il ne tourne pas ; nettoie une instance plantee ou bloquee.
# Renvoie 'ready', 'starting' ou 'absent'.
function Start-AmadeusService($svc) {
    if (-not (Test-Path $svc.Python)) {
        if ($svc.Required) { throw "$($svc.Python) introuvable : lance d'abord install.bat." }
        Say "$($svc.Name) non installee : voix de secours (edge-tts)." Yellow
        return 'absent'
    }
    if (Test-Url $svc.Url) { Say "$($svc.Name) : deja en ligne." Green; return 'ready' }

    $owners = Get-PortOwners $svc.Port
    $p = Get-ServiceProcs $svc
    if ($owners.Count -gt 0) {
        # le port est pris mais rien ne repond : occupe (synthese en cours) ou bloque
        Say "$($svc.Name) : le port $($svc.Port) est pris mais ne repond pas, verification..." Yellow
        for ($i = 0; $i -lt 8; $i++) {
            Start-Sleep -Seconds 2
            if (Test-Url $svc.Url 4000) { Say "$($svc.Name) : en ligne." Green; return 'ready' }
        }
        Say "$($svc.Name) bloque : redemarrage." Yellow
        Stop-AmadeusService $svc
    } elseif ($p.Children.Count -gt 0 -or $p.Launchers.Count -gt 0) {
        Say "$($svc.Name) : deja en cours de demarrage."
        return 'starting'
    } elseif ($p.Hosts.Count -gt 0) {
        # fenetre restee ouverte apres un plantage (pause) : on la ferme
        Stop-Tree @($p.Hosts.ProcessId)
    }

    Say "Demarrage : $($svc.Name)..."
    if ($svc.Key -eq 'voice') { Start-Voice $svc } else { Start-Backend $svc }
    return 'starting'
}

function Start-All {
    $state = @{}
    foreach ($svc in $Services) { $state[$svc.Key] = Start-AmadeusService $svc }

    # Attend que chaque service reponde. Le backend est indispensable ; la voix
    # peut manquer (voix de secours) mais on l'attend pour que Kurisu parle avec
    # sa vraie voix des la premiere phrase.
    $t0 = Get-Date
    $lastLine = ''
    while ($true) {
        $elapsed = [int]((Get-Date) - $t0).TotalSeconds
        foreach ($svc in $Services) {
            if ($state[$svc.Key] -ne 'starting') { continue }
            if (Test-Url $svc.Url) {
                $state[$svc.Key] = 'ready'
                Write-Host ''
                Say "$($svc.Name) : en ligne ($elapsed s)." Green
                continue
            }
            $p = Get-ServiceProcs $svc
            if ($elapsed -gt 3 -and $p.Children.Count -eq 0 -and $p.Launchers.Count -eq 0 -and (Get-PortOwners $svc.Port).Count -eq 0) {
                $state[$svc.Key] = 'failed'
                Write-Host ''
                Say "$($svc.Name) s'est arrete pendant le demarrage : regarde sa fenetre pour l'erreur." Red
            } elseif ($elapsed -ge $svc.MaxWait) {
                $state[$svc.Key] = 'failed'
                Write-Host ''
                Say "$($svc.Name) ne repond toujours pas apres $elapsed s." Red
            }
        }
        if (-not ($state.Values -contains 'starting')) { break }
        $waiting = ($Services | Where-Object { $state[$_.Key] -eq 'starting' } | ForEach-Object { $_.Name }) -join ', '
        $line = "Chargement : $waiting ... $elapsed s"
        if ($line -ne $lastLine) { Write-Host "`r$line   " -NoNewline; $lastLine = $line }
        Start-Sleep -Milliseconds 700
    }

    if ($state['backend'] -ne 'ready') {
        Say "Le backend ne demarre pas : regarde la fenetre Amadeus-Backend." Red
        return 1
    }
    if ($state['voice'] -ne 'ready') {
        Say "Kurisu utilisera la voix de secours. Pour la vraie voix : tts-server\start_tts.bat" Yellow
    }
    $url = 'http://127.0.0.1:8642'
    if (-not $NoBrowser) { Start-Process $url | Out-Null }
    Say "Tout est pret : $url" Green
    Say "Pour tout arreter : stop_amadeus.bat"
    return 0
}

try {
    if ($Action -eq 'stop') {
        Say 'Arret des services...'
        foreach ($svc in $Services) { Stop-AmadeusService $svc }
        Say 'Termine.' Green
        exit 0
    }
    exit (Start-All)
} catch {
    Say $_.Exception.Message Red
    exit 1
}
