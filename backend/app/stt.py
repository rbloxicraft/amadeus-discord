"""Reconnaissance vocale via faster-whisper (GPU si possible, sinon CPU)."""
import io
import logging
import os
import re
import sys
import threading
import time
from pathlib import Path

from .config import CONFIG

log = logging.getLogger("amadeus.stt")

_model = None
# Indice de vocabulaire : sans lui, Whisper entend « Curissu » au lieu de « Kurisu »
_VOCAB = "Kurisu, Amadeus, Christina, Okabe, Mayuri, Daru, Suzuha, Steins;Gate."
_VOCAB_FR = ("Discussion entre amis sur Discord, en français familier, avec des anglicismes "
             "(stream, build, gaming, GG, live). On parle à Amadeus : Makise Kurisu, Kurisu, "
             "Makise, Christina, Okabe.")
_model_device = None
_load_lock = threading.Lock()


def _add_cuda_dll_dirs() -> None:
    """Rend les DLL cuBLAS/cuDNN utilisables par ctranslate2 (GPU).

    CTranslate2 ne trouve pas les DLL via add_dll_directory seul : il faut les
    PRÉ-CHARGER avec ctypes. Sources : wheels nvidia-* du venv backend, sinon
    torch/lib du venv GPT-SoVITS (torch CUDA déjà installé là-bas).
    """
    import ctypes

    candidates = list(Path(sys.prefix).glob("Lib/site-packages/nvidia/*/bin"))
    torch_lib = (CONFIG.DATA_DIR.parent / "tts-server" / "GPT-SoVITS" / "venv"
                 / "Lib" / "site-packages" / "torch" / "lib")
    if torch_lib.exists():
        candidates.append(torch_lib)
    for base in candidates:
        os.add_dll_directory(str(base))
    for base in candidates:
        for dll in ["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll",
                    "cudnn64_9.dll"]:
            p = base / dll
            if p.exists():
                try:
                    ctypes.WinDLL(str(p))
                except OSError:
                    pass


def _load(device: str):
    from faster_whisper import WhisperModel

    if device == "cuda":
        return WhisperModel(CONFIG.STT_MODEL, device="cuda", compute_type="float16")
    return WhisperModel(CONFIG.STT_MODEL, device="cpu", compute_type="int8")


def get_model():
    global _model, _model_device
    with _load_lock:
        if _model is not None:
            return _model
        if CONFIG.STT_DEVICE in ("auto", "cuda"):
            try:
                _add_cuda_dll_dirs()
                _model, _model_device = _load("cuda"), "cuda"
                log.info("Whisper %s chargé sur GPU (cuda/float16)", CONFIG.STT_MODEL)
                return _model
            except Exception as e:
                log.warning("Whisper GPU impossible (%s) → fallback CPU int8", e)
        _model, _model_device = _load("cpu"), "cpu"
        log.info("Whisper %s chargé sur CPU (int8)", CONFIG.STT_MODEL)
        return _model


def _cpu_fallback():
    """Recharge en CPU après une erreur GPU au moment de la transcription."""
    global _model, _model_device
    with _load_lock:
        if _model_device != "cpu":
            log.warning("Erreur GPU en transcription → bascule Whisper sur CPU")
            _model, _model_device = _load("cpu"), "cpu"
        return _model


def _transcribe(model, audio_bytes: bytes, language: str | None = None, names: str = "") -> dict:
    language = language or CONFIG.STT_LANGUAGE
    lang = None if language in ("", "auto") else language
    prompt = _VOCAB_FR if lang == "fr" else _VOCAB
    if names.strip():
        # les pseudos des gens présents : sans eux, Whisper écrit ce qu'il croit entendre
        prompt += (" Dans le vocal : " if lang == "fr" else " Names: ") + names.strip() + "."
    segments, info = model.transcribe(
        io.BytesIO(audio_bytes),          # décodé en mémoire par PyAV, pas de fichier temporaire
        language=lang,
        vad_filter=True,
        beam_size=1,
        condition_on_previous_text=False,
        # temps réel : un seul passage. Par défaut, Whisper recommence jusqu'à 5 fois quand
        # il doute (bruit, musique, langue incertaine) : jusqu'à 30 s pour un bout de phrase,
        # pendant lesquelles plus personne n'est compris
        temperature=0.0,
        max_new_tokens=160,               # ~25 s de parole ; coupe une hallucination qui boucle
        without_timestamps=True,
        # en français : contexte « conversation entre amis », qui garde les anglicismes
        # au lieu de basculer vers une autre langue
        initial_prompt=prompt,
    )
    text = _unloop("".join(seg.text for seg in segments).strip())
    return {"text": text, "language": info.language}


# Whisper part parfois en boucle sur du bruit (« c'est bon, c'est bon, c'est bon… ») : un
# même bout de phrase répété au moins 3 fois d'affilée est ramené à une seule fois
_LOOP_RE = re.compile(r"(\S.{3,80}?)(?:[\s,.!?…-]*\1){2,}", re.S | re.I)
_SEP = " ,.!?…-"


def _unloop(text: str) -> str:
    for _ in range(5):
        m = _LOOP_RE.search(text)
        if not m:
            break
        unit, rest = m.group(1), text[m.end():]
        tail = rest.strip(_SEP)
        if tail and unit.lower().startswith(tail.lower()):   # dernière répétition coupée
            rest = ""
        log.info("Whisper : boucle supprimée (%d → %d caractères)", len(text), m.start() + len(unit) + len(rest))
        text = (text[:m.start()] + unit.rstrip(_SEP) + rest).strip()
    return text


def warmup() -> None:
    get_model()


# une transcription à la fois : en parallèle, elles se disputent le GPU et toutes ralentissent
_run_lock = threading.Lock()


def transcribe(audio_bytes: bytes, language: str | None = None, names: str = "") -> dict:
    """→ {text, language}. Accepte wav/webm/mp3 (décodage via PyAV)."""
    model = get_model()
    with _run_lock:
        t0 = time.perf_counter()
        try:
            return _transcribe(model, audio_bytes, language, names)
        except RuntimeError:
            # DLL CUDA manquante & co : le GPU a chargé mais échoue à l'usage
            return _transcribe(_cpu_fallback(), audio_bytes, language, names)
        finally:
            log.info("Whisper : %.2f s", time.perf_counter() - t0)
