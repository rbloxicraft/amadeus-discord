"""Réglages du mode Discord (data/discord.json), modifiables depuis la page /admin.

Le client Discord (discord-bot/amadeus-client.mjs) les reçoit par websocket et les applique aussitôt.
"""
import json
import threading

from .config import CONFIG

_FILE = CONFIG.DATA_DIR / "discord.json"
_lock = threading.Lock()

DEFAULTS = {
    # où aller
    "guild_id": "",
    "voice_channel_id": "",
    "auto_join": True,             # rejoindre le salon au démarrage
    # quand répondre : "name" (quand on l'appelle), "everyone", "owner"
    "reply_mode": "name",
    "wake_words": ["amadeus", "kurisu", "makise", "christina"],
    "follow_seconds": 8,           # après sa réponse, la même personne peut enchaîner UNE fois sans la nommer
    "owner_id": "",                # ton compte Discord (mode "owner" + priorité)
    "owner_name": "",
    "ignore_ids": [],              # personnes qu'elle n'écoute jamais
    # écoute
    "stt_language": "fr",          # "auto", "fr", "en"…
    # surnoms et mots à reconnaître, en plus des pseudos des présents (ajoutés tout seuls) :
    # « Max = Maxime_42 (PS5) » (surnom dit à l'oral = pseudo Discord) ou un simple mot
    "stt_words": [],
    "min_speech_s": 0.6,           # plus court = bruit, ignoré
    "end_silence_s": 0.5,          # silence qui marque la fin d'une phrase (plus court = répond plus vite)
    "context_lines": 12,           # ce qui s'est dit récemment, transmis avec chaque question
    "interruptible": True,         # l'appeler pendant qu'elle parle la coupe
    # modération : insultes envers elle → déconnexion du vocal, puis mute (le compte doit
    # avoir les permissions « Déplacer » et « Rendre muet » sur le serveur)
    "moderation": True,
    "mute_seconds": 120,
    "ban_words": [],               # mots interdits dans le vocal (même échelle que les insultes)
    # réponses
    "weather_city": "",            # ville de la météo quand on ne précise pas laquelle
    "max_lines": 2,                # phrases par réponse (vocal à plusieurs : court)
    "voice_volume": 1.0,
    # stream : partage d'écran Discord de la scène (la qualité est gérée par Discord)
    "stream_enabled": True,
    "stream_width": 1280,          # taille de la fenêtre de la scène (au prochain démarrage)
    "stream_height": 720,
    "background": "screen",        # "lab" (grille) ou "screen" (écran Amadeus)
    "stream_subtitles": True,      # sous-titres de ce qu'elle dit, sur le stream
    "subtitle_japanese": True,     # en voix japonaise : la phrase japonaise sous la traduction
    "divergence": True,
    "view_2d": False,
}


def load() -> dict:
    with _lock:
        try:
            data = json.loads(_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
    return {**DEFAULTS, **{k: v for k, v in data.items() if k in DEFAULTS}}


def save(changes: dict) -> dict:
    """Fusionne `changes` (clés connues uniquement, types du défaut) et enregistre."""
    cur = load()
    for k, v in changes.items():
        if k not in DEFAULTS:
            continue
        d = DEFAULTS[k]
        try:
            if isinstance(d, bool):
                v = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "on", "yes")
            elif isinstance(d, int) and not isinstance(d, bool):
                v = int(float(v))
            elif isinstance(d, float):
                v = float(v)
            elif isinstance(d, list):
                if isinstance(v, str):
                    v = [s.strip() for s in v.replace("\n", ",").split(",")]
                v = [str(s).strip().lower() if k == "wake_words" else str(s).strip() for s in v if str(s).strip()]
            else:
                v = str(v).strip()
        except (TypeError, ValueError):
            continue
        cur[k] = v
    with _lock:
        _FILE.write_text(json.dumps(cur, indent=2, ensure_ascii=False), encoding="utf-8")
    return cur
