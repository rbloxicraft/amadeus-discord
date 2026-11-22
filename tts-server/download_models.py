# -*- coding: utf-8 -*-
"""Télécharge la voix de Kurisu (modèle GPT-SoVITS + extraits de référence) et les
modèles de base de GPT-SoVITS, puis configure tts_infer.yaml.

Rien de tout cela n'est inclus dans le dépôt : tout vient de Hugging Face, ici, sur
ta machine. Lancé par scripts/install.ps1 ; à la main (depuis amadeus/tts-server) :
    GPT-SoVITS/venv/Scripts/python download_models.py
Ensuite, les transcriptions des extraits : backend/tools/transcribe_refs.py
"""
import json
import shutil
import sys
from pathlib import Path

from huggingface_hub import hf_hub_download

HERE = Path(__file__).resolve().parent
GS = HERE / "GPT-SoVITS"
KURISU = HERE / "kurisu"
EMOTIONS = KURISU / "emotions"
PRETRAINED = GS / "GPT_SoVITS" / "pretrained_models"

VOICE_REPO = "bysq/TTS-KurisuMakise"
T2S_FILE = "牧懒红莉栖-e15.ckpt"        # modèle GPT (texte → sémantique)
VITS_FILE = "牧懒红莉栖_e4_s972.pth"    # modèle SoVITS (sémantique → voix)


def fetch(repo: str, filename: str, dest_dir: Path) -> Path:
    print(f"  ↓ {repo} :: {filename}", flush=True)
    return Path(hf_hub_download(repo_id=repo, filename=filename, local_dir=dest_dir))


def write_tts_config(ckpt: Path, pth: Path) -> None:
    """Remplace le bloc `custom:` de tts_infer.yaml (chemins relatifs à GPT-SoVITS/,
    le dossier courant de start_tts.bat : la config survit à un déplacement du projet)."""
    yaml_path = GS / "GPT_SoVITS" / "configs" / "tts_infer.yaml"
    out, in_custom = [], False
    for line in yaml_path.read_text(encoding="utf-8").splitlines(keepends=True):
        if line.startswith("custom:"):
            in_custom = True
            out += [
                "custom:\n",
                "  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large\n",
                "  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base\n",
                "  device: cuda\n",
                "  is_half: true\n",
                f"  t2s_weights_path: ../kurisu/{ckpt.name}\n",
                "  version: v2Pro\n",
                f"  vits_weights_path: ../kurisu/{pth.name}\n",
            ]
            continue
        if in_custom:
            if line.strip() and not line[0].isspace():
                in_custom = False
            else:
                continue  # anciennes lignes du bloc custom
        out.append(line)
    yaml_path.write_text("".join(out), encoding="utf-8")
    print("  ✓ tts_infer.yaml configuré (modèle Kurisu, v2Pro)")


def main() -> int:
    print("[1/3] Modèle de voix Kurisu")
    ckpt = fetch(VOICE_REPO, T2S_FILE, KURISU)
    pth = fetch(VOICE_REPO, VITS_FILE, KURISU)

    print("[2/3] Extraits de référence (un par émotion)")
    cfg = json.loads((HERE / "voice_refs.json").read_text(encoding="utf-8"))
    EMOTIONS.mkdir(parents=True, exist_ok=True)
    for emo, filename in cfg["refs"].items():
        src = fetch(cfg["repo"], filename, KURISU)
        dest = KURISU / "ref.wav" if emo == "neutral" else EMOTIONS / f"{emo}.wav"
        shutil.copyfile(src, dest)

    print("[3/3] Modèles de base GPT-SoVITS")
    # local_dir=PRETRAINED + nom préfixé par le dossier → pas de dossier en double
    for f in ["config.json", "preprocessor_config.json", "pytorch_model.bin"]:
        fetch("lj1995/GPT-SoVITS", f"chinese-hubert-base/{f}", PRETRAINED)
    for f in ["config.json", "tokenizer.json", "pytorch_model.bin"]:
        fetch("lj1995/GPT-SoVITS", f"chinese-roberta-wwm-ext-large/{f}", PRETRAINED)
    # v2Pro : vérificateur de locuteur (embeddings de la voix de référence)
    sv = PRETRAINED / "sv" / "pretrained_eres2netv2w24s4ep4.ckpt"
    if not sv.exists():
        fetch("lj1995/GPT-SoVITS", "sv/pretrained_eres2netv2w24s4ep4.ckpt", PRETRAINED)
    # fast-langdetect (détection de langue de GPT-SoVITS) refuse de démarrer si son
    # dossier de cache n'existe pas ; il y télécharge ensuite son modèle tout seul
    (PRETRAINED / "fast_langdetect").mkdir(parents=True, exist_ok=True)
    write_tts_config(ckpt, pth)

    print("\nVoix de Kurisu téléchargée.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
