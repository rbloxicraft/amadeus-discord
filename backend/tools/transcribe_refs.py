# -*- coding: utf-8 -*-
"""Transcrit les extraits de référence de la voix (un par émotion) avec Whisper et
écrit tts-server/kurisu/emotions/refs.json, dont GPT-SoVITS a besoin (audio + texte).

Lancé par scripts/install.ps1 après tts-server/download_models.py ; à la main
(depuis amadeus/backend) :
    venv\\Scripts\\python -m tools.transcribe_refs
"""
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

from app.config import ROOT_DIR  # noqa: E402

KURISU = ROOT_DIR / "tts-server" / "kurisu"
CLIPS = {
    "neutral": KURISU / "ref.wav",
    "joy": KURISU / "emotions" / "joy.wav",
    "angry": KURISU / "emotions" / "angry.wav",
    "sad": KURISU / "emotions" / "sad.wav",
    "shy": KURISU / "emotions" / "shy.wav",
    "surprised": KURISU / "emotions" / "surprised.wav",
}


def main() -> int:
    missing = [str(p) for p in CLIPS.values() if not p.exists()]
    if missing:
        print("Extraits manquants (lance d'abord tts-server/download_models.py) :\n  " + "\n  ".join(missing))
        return 1

    from app import stt
    model = stt.get_model()
    refs = {}
    for emo, path in CLIPS.items():
        segments, _ = model.transcribe(str(path), language="ja", beam_size=5,
                                       vad_filter=False, condition_on_previous_text=False)
        text = "".join(s.text for s in segments).strip()
        if not text:
            print(f"  ! {emo} : transcription vide, émotion ignorée")
            continue
        refs[emo] = {"audio": str(path.relative_to(KURISU)).replace("\\", "/"), "text": text}
        print(f"  ✓ {emo}")

    if "neutral" not in refs:
        print("La référence neutre est indispensable : transcription impossible.")
        return 1
    out = KURISU / "emotions" / "refs.json"
    out.write_text(json.dumps(refs, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Références vocales prêtes ({len(refs)} émotions).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
