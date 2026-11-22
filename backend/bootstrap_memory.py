# -*- coding: utf-8 -*-
"""Rattrapage mémoire : résume TOUS les échanges Chroma stockés en profil.

Usage (depuis amadeus/backend) :
    venv/Scripts/python bootstrap_memory.py
"""
import json

from app.config import CONFIG
from app.memory import _get_collection, save_profile
from app.persona import SUMMARIZE_PROMPT
from app.llm import complete_sync

MAX_EXCHANGES = 60  # garde les plus récents si débordement


def main() -> None:
    col = _get_collection()
    count = col.count()
    if count == 0:
        print("Aucun échange stocké — rien à résumer.")
        return
    res = col.get(include=["documents"], limit=count)
    exchanges = []
    for doc in res["documents"]:
        try:
            exchanges.append(json.loads(doc))
        except json.JSONDecodeError:
            continue
    exchanges = exchanges[-MAX_EXCHANGES:]
    lines = "\n".join(
        f"- [{e.get('ts', '?')}] User: {e.get('user', '')}\n  Kurisu: {e.get('kurisu', '')}"
        for e in exchanges
    )
    print(f"Résumé de {len(exchanges)} échanges via le cerveau principal…")
    profile = complete_sync(
        [{"role": "user",
          "content": SUMMARIZE_PROMPT.format(profile="(empty — first memories)",
                                             exchanges=lines)}],
        max_tokens=900,
    )
    if not profile:
        raise SystemExit("Le LLM n'a rien renvoyé — profil non écrit.")
    save_profile(profile)
    print("✓ Profil écrit dans", CONFIG.DATA_DIR / "memory_profile.md")
    print("\n--- APERÇU ---")
    print(profile[:800])


if __name__ == "__main__":
    main()
