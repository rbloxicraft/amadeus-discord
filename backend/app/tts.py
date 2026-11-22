"""Synthèse vocale : GPT-SoVITS (voix Kurisu japonaise) + fallback edge-tts.

- Streaming : GPT-SoVITS renvoie un en-tête WAV puis du PCM 16 bits au fil
  de la génération → le premier son arrive en ~0,4 s au lieu de ~3,5 s.
- Émotions : une réplique de référence de Kurisu par émotion
  (tts-server/kurisu/emotions/refs.json), pour que l'intonation suive l'humeur.
"""
import json
import logging
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import wave
from collections import OrderedDict
from pathlib import Path

import httpx
import numpy as np

from .config import CONFIG, ROOT_DIR

log = logging.getLogger("amadeus.tts")

# GPT-SoVITS n'accepte que ces langues
_GS_LANGS = {"ja", "zh", "en", "zh_cn"}

_TAG_RE = re.compile(r"\[[^\]]*\]")
_MD_RE = re.compile(r"[*_~`#>|]+")
_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF←-⇿]+", flags=re.UNICODE
)
_KANA_RE = re.compile(r"[぀-ヿ]")
_CJK_RE = re.compile(r"[一-鿿]")

# Client HTTP partagé : connexion keep-alive vers GPT-SoVITS
_http = httpx.Client(timeout=httpx.Timeout(120.0, connect=2.0))

# Si GPT-SoVITS ne répond pas, on ne le retente pas à chaque phrase
_GS_RETRY_AFTER = 20.0
_gs_down_until = 0.0

_CACHE_MAX = 200
_tts_cache: "OrderedDict[tuple[str, str], tuple[bytes, str, str]]" = OrderedDict()
_cache_lock = threading.Lock()


# ---------------------------------------------------------------- références

def _load_refs() -> dict[str, dict]:
    """émotion → {audio: chemin absolu, text: transcription}. neutral = référence de base.

    Source : tts-server/kurisu/emotions/refs.json (écrit à l'installation par
    backend/tools/transcribe_refs.py). TTS_REF_AUDIO / TTS_REF_TEXT dans .env
    remplacent la référence neutre si on veut en essayer une autre."""
    refs = {"neutral": {"audio": CONFIG.TTS_REF_AUDIO, "text": ""}}
    kurisu = ROOT_DIR / "tts-server" / "kurisu"
    f = kurisu / "emotions" / "refs.json"
    if f.exists():
        try:
            for emo, r in json.loads(f.read_text(encoding="utf-8")).items():
                p = (kurisu / r["audio"]).resolve()
                if p.exists() and r.get("text"):
                    refs[emo] = {"audio": str(p), "text": r["text"]}
        except Exception:
            log.exception("refs.json illisible — seule la référence neutre sera utilisée")
    if CONFIG.TTS_REF_TEXT:
        refs["neutral"] = {"audio": CONFIG.TTS_REF_AUDIO, "text": CONFIG.TTS_REF_TEXT}
    if not refs["neutral"]["text"]:
        log.warning("Référence vocale sans transcription : lance backend\\tools\\transcribe_refs.py "
                    "(voir README) — GPT-SoVITS risque de refuser les phrases")
    for r in refs.values():
        r["gain"] = _ref_gain(r["audio"])
    log.info("Références vocales : %s", ", ".join(
        f"{e} ({20 * np.log10(r['gain']):+.1f} dB)" for e, r in refs.items()))
    return refs


def _level_db(x: np.ndarray, sr: int) -> float | None:
    """Niveau RMS (dB) des passages parlés uniquement (fenêtres de 20 ms au-dessus du silence)."""
    w = max(1, sr // 50)
    n = len(x) // w
    if not n:
        return None
    e = np.sqrt((x[: n * w].reshape(n, w) ** 2).mean(axis=1))
    voiced = e[e > 0.01]
    return float(20 * np.log10(np.sqrt((voiced ** 2).mean()))) if len(voiced) else None


def _ref_gain(path: str) -> float:
    """La voix générée reprend le volume de sa référence (~1,5 dB en dessous) : les
    répliques de Kurisu étant enregistrées à des niveaux différents, "surprised" sortait
    8 dB plus bas que "joy". Gain qui ramène chaque émotion au niveau cible."""
    try:
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2:
                return 1.0
            x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
            if w.getnchannels() > 1:
                x = x.reshape(-1, w.getnchannels()).mean(axis=1)
            level = _level_db(x, w.getframerate())
    except Exception:
        log.warning("Niveau de %s illisible : volume laissé tel quel", path)
        return 1.0
    if level is None:
        return 1.0
    gain_db = max(-9.0, min(9.0, CONFIG.TTS_LOUDNESS_DB - (level - 1.5)))
    return float(10 ** (gain_db / 20))


_REFS = _load_refs()


def _ref(emotion: str | None) -> dict:
    return _REFS.get(emotion or "neutral", _REFS["neutral"])


# ---------------------------------------------------------------- texte

def clean_text(text: str) -> str:
    """Retire balises, emojis et annotations parasites avant synthèse."""
    text = _TAG_RE.sub("", text)
    text = _MD_RE.sub("", text)
    text = _EMOJI_RE.sub("", text)
    return text.strip()


def detect_lang(text: str) -> str:
    """ja si kana présent, zh si CJK sans kana, sinon 'other'."""
    if _KANA_RE.search(text):
        return "ja"
    if _CJK_RE.search(text):
        return "zh"
    return "other"


def gptsovits_reachable() -> bool:
    try:
        _http.get(CONFIG.TTS_URL, timeout=2.0)
        return True
    except httpx.HTTPError:
        return False


def _gs_payload(text: str, emotion: str | None, streaming: bool) -> dict:
    lang = detect_lang(text)
    ref = _ref(emotion)
    return {
        "text": text,
        "text_lang": lang if lang in _GS_LANGS else "ja",
        "ref_audio_path": ref["audio"],
        "prompt_text": ref["text"],
        "prompt_lang": "ja",
        "text_split_method": "cut5",
        "speed_factor": 1.0,
        "media_type": "wav",
        "parallel_infer": True,
        "streaming_mode": CONFIG.TTS_STREAMING_MODE if streaming else False,
        "temperature": CONFIG.TTS_TEMPERATURE,
        "top_k": CONFIG.TTS_TOP_K,
        "top_p": CONFIG.TTS_TOP_P,
    }


# ---------------------------------------------------------------- cache

def cached(text: str, emotion: str | None) -> tuple[bytes, str, str] | None:
    with _cache_lock:
        key = (text, emotion or "neutral")
        if key in _tts_cache:
            _tts_cache.move_to_end(key)
            return _tts_cache[key]
    return None


def _store(text: str, emotion: str | None, result: tuple[bytes, str, str]) -> None:
    with _cache_lock:
        _tts_cache[(text, emotion or "neutral")] = result
        while len(_tts_cache) > _CACHE_MAX:
            _tts_cache.popitem(last=False)


# ---------------------------------------------------------------- GPT-SoVITS

def _gs_available() -> bool:
    return time.monotonic() >= _gs_down_until


def _mark_down(e: Exception) -> None:
    global _gs_down_until
    if isinstance(e, httpx.ConnectError):
        _gs_down_until = time.monotonic() + _GS_RETRY_AFTER
        log.warning("GPT-SoVITS éteint → edge-tts (nouvel essai dans %ds)", _GS_RETRY_AFTER)
    else:
        log.warning("GPT-SoVITS en erreur (%s) → edge-tts", e)


class GsStream:
    """Flux GPT-SoVITS en cours. `close()` coupe la connexion tout de suite : GPT-SoVITS
    arrête alors de générer une phrase que plus personne n'écoutera (Kurisu interrompue),
    et libère le GPU pour la suivante."""

    def __init__(self, response: httpx.Response, chunks):
        self._r = response
        self._chunks = chunks

    def __iter__(self):
        return self._chunks

    def close(self) -> None:
        try:
            self._r.close()
        except Exception:
            pass


def open_stream(text: str, emotion: str | None) -> "GsStream | None":
    """Ouvre un flux GPT-SoVITS (WAV en-tête + PCM), ou None si indisponible.

    Le résultat complet est mis en cache s'il arrive jusqu'au bout.
    """
    if not _gs_available():
        return None
    try:
        req = _http.build_request("POST", f"{CONFIG.TTS_URL}/tts", json=_gs_payload(text, emotion, True))
        r = _http.send(req, stream=True)
    except Exception as e:
        _mark_down(e)
        return None
    if r.status_code != 200 or r.headers.get("content-type", "").startswith("application/json"):
        detail = r.read()[:300]
        r.close()
        _mark_down(RuntimeError(f"{r.status_code}: {detail!r}"))
        return None

    gain = _Gain(_ref(emotion)["gain"])

    def chunks():
        buf = bytearray()
        complete = False
        try:
            for ch in r.iter_bytes():
                ch = gain.feed(ch)
                if ch:
                    buf += ch
                    yield ch
            complete = True
        except httpx.HTTPError:
            pass  # connexion coupée volontairement (interruption)
        finally:
            r.close()
            if complete and len(buf) > 44:
                _store(text, emotion, (bytes(_fix_wav_sizes(buf)), "audio/wav", "gpt-sovits"))

    return GsStream(r, chunks())


class _Gain:
    """Applique un gain au PCM 16 bits d'un flux WAV, morceau par morceau (l'en-tête
    passe tel quel ; un octet orphelin est gardé pour le morceau suivant)."""

    def __init__(self, gain: float):
        self.gain = gain
        self._head = bytearray()   # tant que l'en-tête n'est pas complet
        self._in_data = False
        self._carry = b""

    def feed(self, ch: bytes) -> bytes:
        if abs(self.gain - 1.0) < 0.02:
            return ch
        out = b""
        if not self._in_data:
            self._head += ch
            i = self._head.find(b"data")
            if i < 0 or len(self._head) < i + 8:
                return b""
            out = bytes(self._head[: i + 8])
            ch = bytes(self._head[i + 8:])
            self._in_data = True
        ch = self._carry + ch
        n = len(ch) - len(ch) % 2
        self._carry = ch[n:]
        if n:
            pcm = np.frombuffer(ch[:n], dtype=np.int16).astype(np.float32) * (self.gain / 32768)
            out += (_soft_limit(pcm) * 32767).astype(np.int16).tobytes()
        return out


def _soft_limit(x: np.ndarray, knee: float = 0.8) -> np.ndarray:
    """Linéaire jusqu'à `knee`, puis s'arrondit vers 1 sans jamais saturer (pas de grésillement)."""
    a = np.abs(x)
    over = a > knee
    if over.any():
        x = x.copy()
        x[over] = np.sign(x[over]) * (knee + (1 - knee) * np.tanh((a[over] - knee) / (1 - knee)))
    return x


def _fix_wav_sizes(buf: bytearray) -> bytearray:
    """L'en-tête WAV d'un flux a des tailles inconnues : on les corrige pour le cache."""
    if buf[:4] == b"RIFF" and buf[36:40] == b"data":
        buf[4:8] = (len(buf) - 8).to_bytes(4, "little")
        buf[40:44] = (len(buf) - 44).to_bytes(4, "little")
    return buf


# ---------------------------------------------------------------- edge-tts

def synth_edge(text: str, emotion: str | None = None, voice: str | None = None) -> tuple[bytes, str, str]:
    """Synthèse de secours via edge-tts en sous-processus (`python -m edge_tts`).

    Sous-processus : l'event loop d'uvicorn fait échouer le websocket aiohttp
    dans un thread. `python -m` : le lanceur .exe du venv garde le chemin
    absolu d'origine et casse si le projet est déplacé.
    """
    voice = voice or ("zh-CN-XiaoxiaoNeural" if detect_lang(text) == "zh" else CONFIG.TTS_FALLBACK_VOICE)
    fd, out = tempfile.mkstemp(suffix=".mp3")
    os.close(fd)
    cmd = [sys.executable, "-m", "edge_tts", "--voice", voice, "--text", text, "--write-media", out]
    try:
        # stdout/stderr vers fichiers/DEVNULL, pas de pipes (fait échouer le websocket edge-tts)
        with tempfile.TemporaryFile() as errf:
            r = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=errf, timeout=45,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if r.returncode != 0:
                errf.seek(0)
                raise RuntimeError(f"edge-tts exit {r.returncode}: {errf.read().decode('utf-8', 'replace')[-500:]}")
        data = Path(out).read_bytes()
        if len(data) < 200:
            raise RuntimeError("edge-tts: fichier audio vide")
        # pas de mise en cache : quand GPT-SoVITS revient, on veut sa vraie voix
        return data, "audio/mpeg", "edge-tts"
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


# ---------------------------------------------------------------- préchauffage

def warmup(wait_s: float = 180.0) -> None:
    """Attend GPT-SoVITS puis synthétise un mot avec chaque référence d'émotion :
    le GPU est chaud et toutes les voix sont en cache avant la 1re vraie phrase."""
    deadline = time.monotonic() + wait_s
    while not gptsovits_reachable():
        if time.monotonic() > deadline:
            log.info("GPT-SoVITS absent : préchauffage de la voix ignoré")
            return
        time.sleep(3)
    t0 = time.monotonic()
    for emo in _REFS:
        try:
            _http.post(f"{CONFIG.TTS_URL}/tts", json=_gs_payload("はい。", emo, False), timeout=60)
        except Exception as e:
            log.warning("Préchauffage voix %s impossible (%s)", emo, e)
            return
    log.info("Voix préchauffée (%d références, %.1f s)", len(_REFS), time.monotonic() - t0)
