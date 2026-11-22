"""Amadeus — serveur principal FastAPI.

Sert le frontend et expose l'API :
  POST /api/chat     → SSE : meta / say / token / line / done / error
  POST /api/tts      → audio en streaming (GPT-SoVITS Kurisu), secours edge-tts
  POST /api/stt      → transcription (faster-whisper)
  GET  /api/boot     → salutation de démarrage personnalisée
  GET  /api/health   → état des services
  GET/PUT /api/brain → cerveau choisi (principal ou rapide)
  /api/memory, /api/avatar, /api/sprites → mémoire, modèle 3D, portrait 2D
  POST /api/diag     → incidents de lecture audio (data/voice_diag.log)
"""
import asyncio
import json
import re
import logging
import threading
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import discord_cfg, memory, moderation, stt, tools, tts
from .config import CONFIG
from .dialogue import LineParser
from . import llm
from .llm import complete, is_configured, stream_chat
from .persona import (BOOT_GREETING_PROMPT, FIRST_BOOT_GREETING, JA_TRANSLATE_PROMPT,
                      DISCORD_ADDENDUM, EMOTIONS, STYLE_BOOST, SUBTITLE_TRANSLATE_PROMPT,
                      SYSTEM_PROMPT)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("amadeus")


# ------------------------------------------------------------------ démarrage

_warm = {"memory": False, "stt": False}


def _warmup() -> None:
    """Précharge les modèles lourds pour que le 1er message/la 1re phrase soient rapides."""
    try:
        memory.warmup()
        _warm["memory"] = True
    except Exception:
        log.exception("Préchargement mémoire impossible")
    if CONFIG.STT_PRELOAD:
        try:
            stt.warmup()
            _warm["stt"] = True
        except Exception:
            log.exception("Préchargement Whisper impossible")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    threading.Thread(target=_warmup, name="warmup", daemon=True).start()
    threading.Thread(target=tts.warmup, name="tts-warmup", daemon=True).start()
    log.info("Amadeus en ligne → http://127.0.0.1:%d", CONFIG.PORT)
    yield


app = FastAPI(title="Amadeus", docs_url=None, redoc_url=None, lifespan=lifespan)

# Historique de conversation par session (en mémoire vive)
_histories: dict[str, list[dict]] = defaultdict(list)
_hist_lock = threading.Lock()


# ------------------------------------------------------------------ helpers

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _parse_lines(raw: str) -> LineParser:
    """Analyse un texte complet au format de ligne (salutations)."""
    p = LineParser()
    p.feed(raw)
    p.finish()
    return p


async def _to_spoken_japanese(text: str) -> str:
    """Traduction de secours vers le japonais parlé, si le modèle a oublié la voix."""
    try:
        ja = await complete(
            [{"role": "user", "content": JA_TRANSLATE_PROMPT.format(text=text)}],
            max_tokens=300, temperature=0.4,
        )
        return tts.clean_text(ja) or text
    except Exception as e:
        log.warning("Traduction JP échouée (%s) — le texte original sera lu", e)
        return text


async def _subtitle(i: int, ja: str, user_message: str) -> tuple[int, str]:
    """Sous-titre d'une ligne japonaise que le modèle n'a pas traduite."""
    try:
        fr = await complete(
            [{"role": "user", "content": SUBTITLE_TRANSLATE_PROMPT.format(user=user_message[:300], ja=ja)}],
            max_tokens=200, temperature=0.3,
        )
        return i, fr.strip()
    except Exception as e:
        log.warning("Sous-titre de secours impossible (%s)", e)
        return i, ""


def _session_history(session_id: str) -> list[dict]:
    with _hist_lock:
        return list(_histories[session_id][-CONFIG.HISTORY_MAX_MESSAGES:])


def _remember_turn(session_id: str, user: str, assistant_raw: str) -> None:
    with _hist_lock:
        h = _histories[session_id]
        h.append({"role": "user", "content": user})
        h.append({"role": "assistant", "content": assistant_raw})
        del h[:-CONFIG.HISTORY_MAX_MESSAGES]


# ------------------------------------------------------------------ chat SSE

_FORWARD = {"say", "token", "line"}
_KANA_RE = re.compile(r"[぀-ヿ]")
_EN_WORDS = re.compile(r"\b(the|you|are|what|how|is|do|i'm|hello|hi|my|your|and|can|don't)\b", re.I)
_FR_HINT = re.compile(r"[éèêàùçôîâ]|\b(je|tu|le|la|les|est|pas|que|quoi|salut|ça|bonjour|mais|et|un|une|des)\b", re.I)


def _user_language(message: str) -> str:
    """Langue des sous-titres : celle du message (français par défaut, c'est l'interface)."""
    if _KANA_RE.search(message):
        return "Japanese"
    if _EN_WORDS.search(message) and not _FR_HINT.search(message):
        return "English"
    return "French"


@app.post("/api/chat")
async def chat(body: dict):
    message = (body.get("message") or "").strip()
    session_id = body.get("session_id") or str(uuid.uuid4())
    # Discord : qui parle, ce qui s'est dit autour, longueur max de la réponse
    discord_mode = body.get("mode") == "discord"
    speaker = (body.get("speaker") or "").strip()[:60]
    context_lines = [str(l)[:300] for l in (body.get("context") or [])][-30:]
    max_lines = max(1, min(4, int(body.get("max_lines") or 2)))
    present = [str(n)[:80] for n in (body.get("present") or [])][:30]
    said = f"{speaker}: {message}" if discord_mode and speaker else message
    if not message:
        raise HTTPException(400, "message vide")

    async def gen():
        try:
            ctx = await run_in_threadpool(memory.memory_context, message)
            # le cerveau principal tient le personnage seul ; GPT-OSS reçoit un renfort de style
            persona = SYSTEM_PROMPT + (STYLE_BOOST if llm.current_brain() in llm.STYLE_BOOSTED else "")
            if discord_mode:
                persona += DISCORD_ADDENDUM.replace("{max_lines}", str(max_lines))
            messages = [{"role": "system", "content": persona + ("\n\n" + ctx if ctx else "")}]
            messages += _session_history(session_id)
            # date et heure : en fin de contexte (le début reste identique d'un message à
            # l'autre, ce qui garde le cache de l'API)
            messages.append({"role": "system", "content": tools.now_note()})
            if discord_mode and present:
                messages.append({"role": "system", "content":
                                 "People in the voice channel right now (Discord names; « nickname » = "
                                 "name): " + ", ".join(present) + ".\nSpeech recognition often garbles "
                                 "these names: when a word sounds like one of them, it IS that person. "
                                 "Say names the way people say them aloud (no « (PS5) », no underscores)."})
            ban_words = discord_cfg.load().get("ban_words") if discord_mode else None
            if ban_words:
                messages.append({"role": "system", "content":
                                 "Banned words on this server — never say them, in any language or "
                                 "spelling: " + ", ".join(ban_words) + "."})
            if discord_mode and context_lines:
                messages.append({"role": "system", "content":
                                 "Recent conversation in the voice channel (not addressed to you):\n"
                                 + "\n".join(context_lines)})
            # Discord : rappel, sur la question elle-même, que c'est une transcription (pas
            # dans l'historique ni la mémoire, qui gardent la phrase seule)
            messages.append({"role": "user", "content": f"[speech-to-text] {said}" if discord_mode else said})
            if llm.current_brain() in llm.STYLE_BOOSTED and _user_language(message) != "Japanese":
                # GPT-OSS oublie la langue des sous-titres au milieu d'un long contexte :
                # un rappel en toute fin, juste avant sa réponse
                lang = _user_language(message)
                messages.append({"role": "system", "content":
                    f"Reminder: reply as Kurisu, 2-3 lines, each `[emotion]<feminine casual Japanese> ||| "
                    f"<same sentence in {lang}>`. The subtitle after ||| MUST be in {lang}."})

            parser = LineParser(user_writes_japanese=bool(_KANA_RE.search(message)))
            meta_sent = False
            subtitles: list[asyncio.Task] = []   # lignes japonaises à sous-titrer

            def relay(events):
                nonlocal meta_sent
                for ev in events:
                    if ev["type"] == "translate":
                        subtitles.append(asyncio.create_task(_subtitle(ev["i"], ev["ja"], message)))
                    elif ev["type"] == "emotion" and not meta_sent:
                        meta_sent = True
                        yield _sse("meta", {"emotion": ev["emotion"], "session_id": session_id})
                    elif ev["type"] in _FORWARD:
                        yield _sse(ev["type"], {k: v for k, v in ev.items() if k != "type"})

            def ready_subtitles(wait: bool):
                for t in [t for t in subtitles if wait or t.done()]:
                    subtitles.remove(t)
                    yield t

            async for delta in stream_chat(messages, tools=True):
                for s in relay(parser.feed(delta)):
                    yield s
                for t in ready_subtitles(False):
                    i, fr = t.result()
                    if fr and parser.set_fr(i, fr):
                        yield _sse("line", {"i": i, "fr": fr})
            for s in relay(parser.finish()):
                yield s
            for t in ready_subtitles(True):
                i, fr = await t
                if fr and parser.set_fr(i, fr):
                    yield _sse("line", {"i": i, "fr": fr})

            if parser.said_count == 0 and parser.reply:
                # le modèle a oublié la piste japonaise → traduction de secours
                ja = await _to_spoken_japanese(parser.reply)
                yield _sse("say", {"i": 0, "ja": ja, "emotion": parser.emotion})
                yield _sse("line", {"i": 0, "fr": parser.reply})
                parser.lines = [{"i": 0, "ja": ja, "fr": parser.reply, "emotion": parser.emotion}]

            emotion = parser.first_emotion or "neutral"
            reply = parser.reply or parser.say_ja
            _remember_turn(session_id, said, parser.formatted() or parser.raw.strip())
            yield _sse("done", {"reply": reply, "emotion": emotion})

            # Mémoire en arrière-plan (ne bloque pas la réponse)
            threading.Thread(target=memory.store_exchange, args=(said, reply), daemon=True).start()
        except Exception as e:
            log.exception("Erreur /api/chat")
            yield _sse("error", {"message": str(e)})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ------------------------------------------------------------------ tts / stt

_gs_lock = asyncio.Lock()


class _GsTurn:
    """Tour de parole auprès de GPT-SoVITS pour une requête (libération idempotente)."""

    def __init__(self) -> None:
        self.held = False

    async def acquire(self, request: Request) -> bool:
        """Attend son tour ; False si le navigateur a abandonné la phrase entre-temps."""
        while True:
            if await request.is_disconnected():
                return False
            try:
                await asyncio.wait_for(_gs_lock.acquire(), timeout=0.25)
                break
            except asyncio.TimeoutError:
                continue
        self.held = True
        if await request.is_disconnected():
            self.release()
            return False
        return True

    def release(self) -> None:
        if self.held:
            self.held = False
            _gs_lock.release()


class _ClosingStreamingResponse(StreamingResponse):
    """Quand le navigateur coupe la connexion, Starlette abandonne le générateur sans
    le fermer : le flux GPT-SoVITS restait ouvert sans lecteur, GPT-SoVITS se bloquait
    en écrivant dedans (verrou pris) et plus aucune phrase ne sortait pendant des
    minutes. Ici la fermeture est garantie."""

    def __init__(self, *args, on_close=None, **kwargs):
        super().__init__(*args, **kwargs)
        self._on_close = on_close

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            aclose = getattr(self.body_iterator, "aclose", None)
            if aclose is not None:
                try:
                    await aclose()
                except Exception:
                    pass
            if self._on_close is not None:
                self._on_close()


@app.post("/api/tts")
async def api_tts(body: dict, request: Request):
    """Voix de Kurisu. GPT-SoVITS → flux WAV (en-tête + PCM au fil de l'eau) ;
    sinon edge-tts → MP3 complet. Le type de contenu indique lequel."""
    text = tts.clean_text(body.get("text") or "")
    emotion = body.get("emotion") or "neutral"
    if not text:
        raise HTTPException(400, "texte vide")

    hit = tts.cached(text, emotion)
    if hit:
        audio, mime, engine = hit
        return Response(content=audio, media_type=mime, headers={"X-Amadeus-Engine": engine})

    # Une seule phrase à la fois chez GPT-SoVITS (il ne sait pas faire mieux) : les
    # suivantes attendent ici, où une phrase annulée (Kurisu interrompue) disparaît
    # sans avoir coûté une seconde de GPU.
    turn = _GsTurn()
    if not await turn.acquire(request):
        log.info("tts: phrase annulée avant GPT-SoVITS (%s…)", text[:12])
        return Response(status_code=204)
    try:
        stream = await run_in_threadpool(tts.open_stream, text, emotion)
    except BaseException:
        turn.release()
        raise
    if stream is not None and await request.is_disconnected():
        log.info("tts: phrase annulée pendant sa préparation (%s…)", text[:12])
        stream.close()
        turn.release()
        return Response(status_code=204)
    if stream is not None:
        def close():
            # navigateur parti ou phrase finie → on coupe GPT-SoVITS et on passe la main
            stream.close()
            turn.release()

        async def relay():
            it = iter(stream)
            try:
                while True:
                    chunk = await run_in_threadpool(next, it, None)
                    if chunk is None:
                        break
                    yield chunk
            finally:
                close()

        return _ClosingStreamingResponse(relay(), on_close=close, media_type="audio/wav",
                                         headers={"X-Amadeus-Engine": "gpt-sovits", "Cache-Control": "no-store"})
    turn.release()
    try:
        audio, mime, engine = await run_in_threadpool(tts.synth_edge, text, emotion)
    except Exception as e:
        log.exception("Erreur TTS")
        raise HTTPException(502, f"TTS indisponible: {e}")
    return Response(content=audio, media_type=mime, headers={"X-Amadeus-Engine": engine})


@app.post("/api/moderate")
async def api_moderate(body: dict):
    """Discord : la phrase adressée à Amadeus l'insulte-t-elle ? (jugée à part de la
    réponse, qui peut être coupée)"""
    message = (body.get("message") or "").strip()[:500]
    before = [str(l)[:200] for l in (body.get("before") or [])][-3:]
    if not message:
        return {"insult": False}
    return {"insult": await moderation.is_insult((body.get("speaker") or "")[:60], message, before)}


@app.post("/api/stt")
async def api_stt(audio: UploadFile = File(...), language: str = Form(""), names: str = Form("")):
    """names : pseudos et surnoms à reconnaître (Discord : les gens présents dans le vocal)."""
    data = await audio.read()
    if not data:
        raise HTTPException(400, "audio vide")
    try:
        return await run_in_threadpool(stt.transcribe, data, language or None, names[:300])
    except Exception:
        log.exception("Erreur STT")
        raise HTTPException(502, "STT indisponible")


# ------------------------------------------------------------------ boot

def _boot_payload(p: LineParser, returning: bool) -> dict:
    return {
        "lines": [{"ja": l["ja"], "fr": l["fr"], "emotion": l["emotion"]} for l in p.lines if l["ja"]],
        "greeting": p.reply or p.say_ja,
        "emotion": p.first_emotion or "neutral",
        "returning": returning,
    }


@app.get("/api/boot")
async def api_boot(lang: str = "fr"):
    profile = await run_in_threadpool(memory.get_profile)
    if not profile or not is_configured():
        return _boot_payload(_parse_lines(FIRST_BOOT_GREETING), bool(profile))
    try:
        raw = await complete(
            [{"role": "user", "content": BOOT_GREETING_PROMPT.format(lang=lang, profile=profile)}],
            max_tokens=300,
        )
        p = _parse_lines(raw)
        if not p.said_count and p.reply:
            ja = await _to_spoken_japanese(p.reply)
            p.lines = [{"i": 0, "ja": ja, "fr": p.reply, "emotion": p.emotion}]
        return _boot_payload(p, True)
    except Exception as e:
        log.warning("Salutation LLM impossible (%s) — template", e)
        return _boot_payload(_parse_lines(
            "[neutral]…接続を確認。それで、続きを始める？ ||| …Connexion rétablie. Alors, on reprend ?"), True)


# ------------------------------------------------------------------ cerveau

@app.get("/api/brain")
async def api_brain():
    return llm.brains_info()


@app.put("/api/brain")
async def api_brain_set(body: dict):
    try:
        await run_in_threadpool(llm.set_brain, str(body.get("brain", "")))
    except ValueError as e:
        raise HTTPException(400, str(e))
    return llm.brains_info()


# ------------------------------------------------------------------ admin

_DIAG_FILE = CONFIG.DATA_DIR / "voice_diag.log"
_diag_lock = threading.Lock()


@app.post("/api/diag")
async def api_diag(body: dict):
    """Incidents de lecture remontés par le navigateur (trous de son, interruptions)."""
    line = json.dumps(body, ensure_ascii=False)[:1000]
    log.info("voix: %s", line)
    with _diag_lock:
        if _DIAG_FILE.exists() and _DIAG_FILE.stat().st_size > 512_000:
            _DIAG_FILE.replace(_DIAG_FILE.with_suffix(".old.log"))
        with _DIAG_FILE.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    return Response(status_code=204)


@app.get("/api/health")
async def api_health():
    gs_ok, mem = await asyncio.gather(
        run_in_threadpool(tts.gptsovits_reachable),
        run_in_threadpool(memory.stats),
    )
    return {
        "llm": {"configured": is_configured(), "model": llm.current_model(), "brain": llm.current_brain()},
        "tts": {"gpt_sovits": gs_ok, "ref_audio_ok": Path(CONFIG.TTS_REF_AUDIO).exists()},
        "stt": {"model": CONFIG.STT_MODEL, "ready": _warm["stt"]},
        "memory": {"exchanges": mem["exchanges"], "ready": _warm["memory"]},
    }


@app.get("/api/memory")
async def api_memory():
    return await run_in_threadpool(memory.stats)


@app.put("/api/memory")
async def api_memory_put(body: dict):
    """Édition manuelle du profil mémoire."""
    profile = (body.get("profile") or "").strip()
    if not profile:
        raise HTTPException(400, "profil vide — utilise DELETE pour tout effacer")
    await run_in_threadpool(memory.save_profile, profile)
    return {"ok": True, "size": len(profile)}


@app.delete("/api/memory")
async def api_memory_delete():
    await run_in_threadpool(memory.wipe)
    with _hist_lock:
        _histories.clear()
    return {"ok": True}


# ------------------------------------------------------------------ avatar

_MODELS_DIR = CONFIG.FRONTEND_DIR / "vendor" / "models"


def _avatar_path() -> Path:
    return _MODELS_DIR / "current.vrm"


@app.get("/api/avatar")
async def api_avatar_get():
    p = _avatar_path()
    if not p.exists():
        raise HTTPException(404, "aucun avatar configuré")
    return FileResponse(p, media_type="model/gltf-binary", filename="current.vrm")


@app.post("/api/avatar")
async def api_avatar_post(file: UploadFile = File(...)):
    if not (file.filename or "").lower().endswith(".vrm"):
        raise HTTPException(400, "il faut un fichier .vrm")
    data = await file.read()
    if len(data) < 10_000:
        raise HTTPException(400, "fichier .vrm trop petit / invalide")
    await run_in_threadpool(_avatar_path().write_bytes, data)
    return {"ok": True, "size": len(data)}


@app.delete("/api/avatar")
async def api_avatar_delete():
    """Supprime l'avatar personnalisé → retour au Kurisu par défaut."""
    _avatar_path().unlink(missing_ok=True)
    return {"ok": True, "kurisu_available": (_MODELS_DIR / "kurisu.vrm").exists()}


# ------------------------------------------------------------------ portrait 2D
# Images fournies par l'utilisateur, une par émotion (+ variante bouche ouverte).
# Nom du fichier = émotion : neutral/neutre, joy/joie, angry/colere, sad/triste,
# shy/gene, surprised/surprise ; suffixe _talk ou _parle pour la bouche ouverte.

_SPRITES_DIR = CONFIG.FRONTEND_DIR / "vendor" / "sprites"
_SPRITE_EXTS = (".png", ".webp", ".jpg", ".jpeg", ".gif")
_SPRITE_ALIASES = {
    "neutral": "neutral", "neutre": "neutral", "normal": "neutral", "default": "neutral",
    "joy": "joy", "joie": "joy", "happy": "joy", "content": "joy",
    "angry": "angry", "colere": "angry", "fache": "angry", "fachee": "angry",
    "sad": "sad", "triste": "sad",
    "shy": "shy", "gene": "shy", "genee": "shy", "embarrassed": "shy",
    "surprised": "surprised", "surprise": "surprised",
}


def _sprite_key(filename: str) -> str | None:
    """'Joie_parle.PNG' → 'joy_talk' ; None si le nom ne correspond à aucune émotion."""
    import unicodedata
    stem = Path(filename).stem.lower().strip()
    stem = "".join(c for c in unicodedata.normalize("NFD", stem) if unicodedata.category(c) != "Mn")
    stem = re.sub(r"[\s\-]+", "_", stem)
    talk = False
    for suf in ("_talk", "_parle", "_open", "_bouche"):
        if stem.endswith(suf):
            stem, talk = stem[: -len(suf)], True
            break
    emo = _SPRITE_ALIASES.get(stem)
    return f"{emo}_talk" if emo and talk else emo


def _sprite_files() -> dict[str, Path]:
    out: dict[str, Path] = {}
    if _SPRITES_DIR.exists():
        for f in _SPRITES_DIR.iterdir():
            if f.suffix.lower() in _SPRITE_EXTS:
                out[f.stem] = f
    return out


@app.get("/api/sprites")
async def api_sprites():
    files = _sprite_files()

    def url(f: Path | None) -> str | None:
        return f"/vendor/sprites/{f.name}?v={int(f.stat().st_mtime)}" if f else None

    res = {}
    for emo in EMOTIONS:
        idle, talk = files.get(emo), files.get(f"{emo}_talk")
        if idle or talk:
            res[emo] = {"idle": url(idle or talk), "talk": url(talk)}
    return {"sprites": res}


@app.post("/api/sprites")
async def api_sprites_post(files: list[UploadFile] = File(...)):
    _SPRITES_DIR.mkdir(parents=True, exist_ok=True)
    saved, ignored = [], []
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        key = _sprite_key(f.filename or "")
        if ext not in _SPRITE_EXTS or not key:
            ignored.append(f.filename)
            continue
        data = await f.read()
        if len(data) > 25_000_000:
            ignored.append(f.filename)
            continue
        for old in _SPRITES_DIR.glob(f"{key}.*"):
            old.unlink(missing_ok=True)
        await run_in_threadpool((_SPRITES_DIR / f"{key}{'.jpg' if ext == '.jpeg' else ext}").write_bytes, data)
        saved.append(key)
    return {"saved": saved, "ignored": ignored}


@app.delete("/api/sprites")
async def api_sprites_delete():
    for f in _sprite_files().values():
        f.unlink(missing_ok=True)
    return {"ok": True}


# ------------------------------------------------------------------ Discord : hub temps réel
# Le client Discord (discord-bot/amadeus-client.mjs) et la scène (/stage, partagée en
# Go Live) se connectent ici en websocket : réglages et ordres vers le client ; bouche,
# émotion, sous-titres, compteur vers la scène. La page /admin lit l'état par /api/discord/status.

class _Hub:
    def __init__(self) -> None:
        self.bots: set[WebSocket] = set()
        self.stages: set[WebSocket] = set()
        self.status: dict = {}
        self.log: list[dict] = []          # derniers échanges entendus / dits (page admin)

    async def send(self, targets: set[WebSocket], msg: dict) -> None:
        # un client qui ne lit plus (navigateur figé, orphelin) est abandonné au lieu de
        # bloquer le relais : la bouche est envoyée 25 fois par seconde
        for ws in list(targets):
            try:
                await asyncio.wait_for(ws.send_json(msg), timeout=0.5)
            except Exception:
                targets.discard(ws)
                try:
                    await asyncio.wait_for(ws.close(), timeout=0.5)
                except Exception:
                    pass

    def note(self, entry: dict) -> None:
        self.log.append(entry)
        del self.log[:-200]


_hub = _Hub()
_STAGE_KEYS = ("background", "divergence", "view_2d", "stream_width", "stream_height",
               "stream_subtitles", "subtitle_japanese")


def _stage_settings(cfg: dict) -> dict:
    return {k: cfg[k] for k in _STAGE_KEYS}


@app.websocket("/ws/{role}")
async def ws_hub(ws: WebSocket, role: str):
    if role not in ("bot", "stage") or ws.client is None or ws.client.host not in ("127.0.0.1", "::1"):
        await ws.close(code=1008)
        return
    await ws.accept()
    group = _hub.bots if role == "bot" else _hub.stages
    group.add(ws)
    cfg = discord_cfg.load()
    await ws.send_json({"type": "settings", "settings": _stage_settings(cfg) if role == "stage" else cfg})
    try:
        while True:
            msg = await ws.receive_json()
            t = msg.get("type")
            if role != "bot":
                continue
            if t == "status":
                _hub.status = {k: v for k, v in msg.items() if k != "type"}
            elif t == "log":
                _hub.note({k: v for k, v in msg.items() if k != "type"})
            elif t in ("mouth", "emotion", "speaking", "divergence", "subtitle"):
                await _hub.send(_hub.stages, msg)       # scène : lip-sync et expressions
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        group.discard(ws)
        if role == "bot" and not _hub.bots:
            _hub.status = {}


def _local_only(request: Request) -> None:
    if request.client is None or request.client.host not in ("127.0.0.1", "::1"):
        raise HTTPException(403, "page réservée à ce PC")


@app.get("/api/discord/settings")
async def discord_settings(request: Request):
    _local_only(request)
    return discord_cfg.load()


@app.put("/api/discord/settings")
async def discord_settings_put(body: dict, request: Request):
    _local_only(request)
    cfg = await run_in_threadpool(discord_cfg.save, body)
    await _hub.send(_hub.bots, {"type": "settings", "settings": cfg})
    await _hub.send(_hub.stages, {"type": "settings", "settings": _stage_settings(cfg)})
    return cfg


@app.post("/api/discord/command")
async def discord_command(body: dict, request: Request):
    """join / leave / stop / say {text} : transmis au client Discord."""
    _local_only(request)
    if not _hub.bots:
        raise HTTPException(503, "Amadeus (Discord) n'est pas lancée")
    await _hub.send(_hub.bots, {"type": "command", **body})
    return {"ok": True}


@app.get("/api/discord/status")
async def discord_status(request: Request, since: int = 0):
    _local_only(request)
    return {"bot_connected": bool(_hub.bots), "stage_connected": bool(_hub.stages),
            "status": _hub.status, "log": _hub.log[since:] if since < len(_hub.log) else [],
            "log_size": len(_hub.log)}


@app.get("/stage")
async def stage_page():
    return FileResponse(CONFIG.FRONTEND_DIR / "stage.html", headers={"Cache-Control": "no-cache"})


@app.get("/admin")
async def admin_page(request: Request):
    _local_only(request)
    return FileResponse(CONFIG.FRONTEND_DIR / "admin.html", headers={"Cache-Control": "no-cache"})


# ------------------------------------------------------------------ frontend

@app.get("/")
async def index():
    return FileResponse(CONFIG.FRONTEND_DIR / "index.html", headers={"Cache-Control": "no-cache"})


class _RevalidateCode:
    """JS/CSS : toujours revalidés (304 si inchangés) → jamais de vieille version en cache.

    Middleware ASGI pur, volontairement : un @app.middleware("http") cache aux routes
    la déconnexion du navigateur. Les phrases annulées (Kurisu interrompue) partaient
    alors quand même à GPT-SoVITS, et les flux abandonnés restaient ouverts."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith(("/js/", "/css/")):
            return await self.app(scope, receive, send)

        async def send_no_cache(message):
            if message["type"] == "http.response.start":
                headers = [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"]
                message = {**message, "headers": headers + [(b"cache-control", b"no-cache")]}
            await send(message)

        await self.app(scope, receive, send_no_cache)


app.add_middleware(_RevalidateCode)


app.mount("/css", StaticFiles(directory=str(CONFIG.FRONTEND_DIR / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(CONFIG.FRONTEND_DIR / "js")), name="js")
app.mount("/vendor", StaticFiles(directory=str(CONFIG.FRONTEND_DIR / "vendor")), name="vendor")


def main():
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=CONFIG.PORT, log_level="info")


if __name__ == "__main__":
    main()
