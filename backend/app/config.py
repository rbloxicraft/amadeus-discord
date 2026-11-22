"""Configuration du système Amadeus — chargée depuis backend/.env"""
import os
from pathlib import Path

from dotenv import load_dotenv

# backend/.env
BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")

ROOT_DIR = BACKEND_DIR.parent


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default).strip()


def _env_bool(key: str, default: bool) -> bool:
    return _env(key, "1" if default else "0").lower() in ("1", "true", "yes", "on")


def _path(key: str, default: Path) -> Path:
    """Chemin depuis .env : relatif → résolu depuis backend/. S'il n'existe pas
    (projet déplacé, vieux chemin absolu), on retombe sur le défaut."""
    raw = _env(key, "")
    if raw:
        p = Path(raw)
        if not p.is_absolute():
            p = BACKEND_DIR / p
        p = p.resolve()
        if p.exists():
            return p
    return default.resolve()


def _env_any(keys: tuple[str, ...], default: str) -> str:
    """Première variable définie parmi `keys` (les anciens noms GLM_* restent acceptés)."""
    for k in keys:
        v = os.environ.get(k, "").strip()
        if v:
            return v
    return default


class Config:
    # --- Cerveau principal : n'importe quelle API compatible OpenAI ---
    API_KEY = _env_any(("LLM_API_KEY", "GLM_API_KEY"), "")
    BASE_URL = _env_any(("LLM_BASE_URL", "GLM_BASE_URL"), "https://api.z.ai/api/paas/v4")
    MODEL = _env_any(("LLM_MODEL", "GLM_MODEL"), "glm-5.3")
    # La « réflexion » de certains modèles ajoute plusieurs secondes avant le 1er mot :
    # inutile pour du dialogue court → désactivée (paramètre ignoré si l'API ne le connaît pas).
    DISABLE_THINKING = _env_any(("LLM_DISABLE_THINKING", "GLM_DISABLE_THINKING"), "true").lower() in ("1", "true", "yes", "on")
    # --- Cerveau rapide : GPT-OSS 120B chez Groq (gratuit, ~1 s de moins avant la voix) ---
    GROQ_API_KEY = _env("GROQ_API_KEY", "")
    GROQ_BASE_URL = _env("GROQ_BASE_URL", "https://api.groq.com/openai/v1")
    GROQ_MODEL = _env("GROQ_MODEL", "openai/gpt-oss-120b")
    # DeepSeek (payant, très peu cher) : rapide et régulier, sans quota par minute
    DEEPSEEK_API_KEY = _env("DEEPSEEK_API_KEY", "")
    DEEPSEEK_BASE_URL = _env("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    DEEPSEEK_MODEL = _env("DEEPSEEK_MODEL", "deepseek-flash")
    # Cerveau au premier démarrage : glm ou gptoss (ensuite, choix fait dans l'interface)
    BRAIN = _env("BRAIN", "glm")

    # --- Voix ---
    TTS_URL = _env("TTS_GPTSOVITS_URL", "http://127.0.0.1:9880").rstrip("/")
    TTS_FALLBACK_VOICE = _env("TTS_FALLBACK_VOICE", "ja-JP-NanamiNeural")
    # Audio de référence Kurisu pour GPT-SoVITS (voix clonée)
    TTS_REF_AUDIO = str(_path("TTS_REF_AUDIO", ROOT_DIR / "tts-server" / "kurisu" / "ref.wav"))
    TTS_REF_TEXT = _env("TTS_REF_TEXT", "")
    # Streaming GPT-SoVITS : 3 = petits morceaux réguliers, plus rapides que la lecture
    # (aucun blanc en pleine phrase) ; 2 et 1 = gros blocs espacés, la lecture les
    # rattrape et coupe la phrase ; 0 = désactivé (attend la phrase entière, ~2-4 s)
    TTS_STREAMING_MODE = int(_env("TTS_STREAMING_MODE", "3"))
    # Échantillonnage : les valeurs par défaut de GPT-SoVITS (1.0 / 15 / 1.0) avalent ou
    # bredouillent ~1 phrase sur 7 ; celles-ci : 0 ratée sur 60 (vérifié par Whisper)
    TTS_TEMPERATURE = float(_env("TTS_TEMPERATURE", "0.7"))
    TTS_TOP_K = int(_env("TTS_TOP_K", "5"))
    TTS_TOP_P = float(_env("TTS_TOP_P", "0.9"))
    # Volume cible de la voix (dB RMS) : chaque émotion est ramenée à ce niveau
    TTS_LOUDNESS_DB = float(_env("TTS_LOUDNESS_DB", "-16"))

    # --- Oreilles ---
    STT_MODEL = _env("STT_MODEL", "large-v3-turbo")
    STT_DEVICE = _env("STT_DEVICE", "auto")
    # "auto" = détection ; "fr" fiabilise les phrases courtes si tu parles toujours français
    STT_LANGUAGE = _env("STT_LANGUAGE", "auto")
    # Charge Whisper au démarrage (sinon ~10 s au premier appui micro)
    STT_PRELOAD = _env_bool("STT_PRELOAD", True)

    # --- Divers ---
    DATA_DIR = (BACKEND_DIR / _env("DATA_DIR", "../data")).resolve()
    PORT = int(_env("BACKEND_PORT", "8643"))

    FRONTEND_DIR = ROOT_DIR / "frontend"

    # Modèle d'embedding local multilingue (mémoire Amadeus)
    EMBED_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"
    # Résumé de mémoire tous les N échanges
    MEMORY_SUMMARY_EVERY = 6
    # Nb de souvenirs pertinents injectés par message
    MEMORY_RETRIEVE_K = 4
    # Historique conservé pour le LLM (messages)
    HISTORY_MAX_MESSAGES = 24


CONFIG = Config()

CONFIG.DATA_DIR.mkdir(parents=True, exist_ok=True)
