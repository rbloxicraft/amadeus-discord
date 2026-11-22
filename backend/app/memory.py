"""Mémoire long-terme d'Amadeus.

Deux niveaux :
- ChromaDB (vectoriel) : chaque échange est embedé, retrieval par similarité.
- Profil glissant (markdown) : résumé LLM de qui est l'utilisateur et de la relation,
  mis à jour tous les MEMORY_SUMMARY_EVERY échanges, injecté dans le prompt système.

Toutes les fonctions sont bloquantes (embedding CPU, SQLite) : depuis du code
async, les appeler via run_in_executor.
"""
import json
import re
import logging
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

import chromadb

from .config import CONFIG

log = logging.getLogger("amadeus.memory")

_lock = threading.Lock()
_client = None
_collection = None
_embedder = None
_exchange_count = 0
_pending_exchanges: list[dict] = []


def _get_embedder():
    global _embedder
    if _embedder is None:
        from sentence_transformers import SentenceTransformer
        log.info("Chargement du modèle d'embedding %s…", CONFIG.EMBED_MODEL)
        _embedder = SentenceTransformer(CONFIG.EMBED_MODEL)
    return _embedder


def _get_collection():
    global _client, _collection, _exchange_count
    if _collection is None:
        _client = chromadb.PersistentClient(path=str(CONFIG.DATA_DIR / "chroma"))
        _collection = _client.get_or_create_collection("amadeus_memories")
        _exchange_count = _collection.count()
    return _collection


def _embed(texts: list[str]) -> list[list[float]]:
    return _get_embedder().encode(texts, normalize_embeddings=True).tolist()


def warmup() -> None:
    """Charge Chroma + le modèle d'embedding (appelé au démarrage, en arrière-plan)."""
    with _lock:
        _get_collection()
        _embed(["warmup"])
    log.info("Mémoire prête (%d échanges)", _exchange_count)


# ---------------------------------------------------------------- profil

def _profile_path() -> Path:
    return CONFIG.DATA_DIR / "memory_profile.md"


def get_profile() -> str:
    p = _profile_path()
    if p.exists():
        return p.read_text(encoding="utf-8").strip()
    return ""


def save_profile(profile: str) -> None:
    _profile_path().write_text(profile.strip() + "\n", encoding="utf-8")


# ---------------------------------------------------------------- stockage

def store_exchange(user_text: str, reply_text: str) -> None:
    """Archive un échange (vectoriel + file d'attente de résumé). Thread-safe."""
    global _exchange_count
    ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
    record = {
        "user": user_text.strip()[:1000],
        "kurisu": reply_text.strip()[:1000],
        "ts": ts,
    }
    try:
        with _lock:
            col = _get_collection()
            emb = _embed([f"U: {user_text}\nK: {reply_text}"])[0]
            col.add(
                ids=[f"ex-{uuid.uuid4().hex}"],
                embeddings=[emb],
                documents=[json.dumps(record, ensure_ascii=False)],
                metadatas=[{"ts": ts}],
            )
            _exchange_count += 1
            _pending_exchanges.append(record)
            need_summary = len(_pending_exchanges) >= CONFIG.MEMORY_SUMMARY_EVERY
            pending = list(_pending_exchanges)
            if need_summary:
                _pending_exchanges.clear()
        if need_summary:
            _update_profile(pending)
    except Exception:
        log.exception("Échec du stockage mémoire (non bloquant)")


_FIXED_RE = re.compile(r"^## KURISU\b.*?(?=^## |\Z)", re.M | re.S)


def _split_fixed(profile: str) -> tuple[str, str]:
    """Sépare la fiche « ## KURISU » (son personnage, écrite à la main) du reste.
    Elle ne passe jamais par le résumé automatique : impossible de l'abîmer."""
    m = _FIXED_RE.search(profile)
    if not m:
        return "", profile
    rest = (profile[:m.start()] + profile[m.end():]).strip()
    return m.group(0).strip(), re.sub(r"^# MEMORY PROFILE\s*", "", rest)


def _update_profile(exchanges: list[dict]) -> None:
    """Fusionne les nouveaux échanges dans le profil via LLM (appel bloquant)."""
    from .llm import complete_sync
    from .persona import SUMMARIZE_PROMPT

    fixed, profile = _split_fixed(get_profile())
    lines = "\n".join(
        f"- [{e['ts']}] User: {e['user']}\n  Kurisu: {e['kurisu']}" for e in exchanges
    )
    try:
        # whole : un résumé coupé par la limite de longueur effacerait la fin du profil
        new_profile = complete_sync(
            [{"role": "user",
              "content": SUMMARIZE_PROMPT.format(profile=profile or "(empty — first memories)",
                                                 exchanges=lines)}],
            max_tokens=4000, whole=True,
        )
        if new_profile:
            if fixed:
                new_profile = f"# MEMORY PROFILE\n\n{fixed}\n\n{_split_fixed(new_profile)[1]}"
            save_profile(new_profile)
            log.info("Profil mémoire mis à jour (%d échanges fusionnés)", len(exchanges))
    except Exception:
        log.exception("Échec du résumé mémoire (le profil reste inchangé)")
        # Remet les échanges en file pour le prochain essai
        with _lock:
            _pending_exchanges[:0] = exchanges


# ---------------------------------------------------------------- retrieval

def retrieve_relevant(query: str, k: int | None = None) -> list[dict]:
    """Récupère les k échanges les plus proches sémantiquement."""
    k = k or CONFIG.MEMORY_RETRIEVE_K
    try:
        with _lock:
            col = _get_collection()
            n = col.count()
            if n == 0:
                return []
            emb = _embed([query])[0]
            res = col.query(query_embeddings=[emb], n_results=min(k, n))
        out = []
        for doc in res["documents"][0]:
            try:
                out.append(json.loads(doc))
            except json.JSONDecodeError:
                continue
        return out
    except Exception:
        log.exception("Échec du retrieval mémoire")
        return []


def memory_context(query: str) -> str:
    """Bloc 'MÉMOIRE' injecté dans le prompt système."""
    profile = get_profile()
    hits = retrieve_relevant(query)
    if not profile and not hits:
        return ""
    parts = ["# Amadeus memory subsystem (context from long-term memory — use naturally)"]
    if profile:
        parts.append("## Memory profile (who the user is, your shared history):\n" + profile)
    if hits:
        lines = [f"- [{h.get('ts', '?')}] User: {h.get('user', '')} | You: {h.get('kurisu', '')}"
                 for h in hits]
        parts.append("## Most relevant past exchanges:\n" + "\n".join(lines))
    return "\n\n".join(parts)


def wipe() -> None:
    """Réinitialise toute la mémoire (profil + vectoriel)."""
    global _collection, _exchange_count
    with _lock:
        _get_collection()
        _client.delete_collection("amadeus_memories")
        _collection = None
        _exchange_count = 0
        _pending_exchanges.clear()
        p = _profile_path()
        if p.exists():
            p.unlink()


def stats() -> dict:
    """Profil + nombre d'échanges (force l'init lazy de Chroma)."""
    try:
        with _lock:
            _get_collection()
    except Exception:
        log.exception("Chroma indisponible")
    return {"profile": get_profile(), "exchanges": _exchange_count}
