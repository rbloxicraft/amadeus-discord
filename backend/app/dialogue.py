"""Découpe en direct du flux LLM, ligne par ligne :

    [émotion]phrase japonaise ||| même phrase dans la langue de l'utilisateur

Dès que le « ||| » d'une ligne arrive, la phrase japonaise est complète :
on émet un événement `say` → la synthèse vocale démarre pendant que le LLM
écrit encore la traduction et les phrases suivantes.

Événements produits (dicts) :
  {"type": "emotion", "emotion": str}            1re émotion connue (avatar)
  {"type": "say", "i": int, "ja": str, "emotion": str}
  {"type": "token", "t": str}                    texte affiché (langue utilisateur)
  {"type": "line", "i": int, "fr": str}          sous-titre complet de la phrase i
"""
import re

from .persona import EMOTIONS

MARKER = "|||"
_TAG_RE = re.compile(r"^\s*\[(" + "|".join(EMOTIONS) + r")\]\s*", re.I)
_ANY_TAG_RE = re.compile(r"\[[^\]\n]*\]")
_KANA_RE = re.compile(r"[぀-ヿ]")
_JAPANESE_RE = re.compile(r"[぀-ヿ一-鿿]")


def _clean(s: str) -> str:
    return _ANY_TAG_RE.sub("", s).strip()


class LineParser:
    def __init__(self, user_writes_japanese: bool = True) -> None:
        # False : une ligne japonaise sans « ||| » est un oubli du modèle → événement
        # `translate` (sous-titre fourni plus tard par set_fr) au lieu d'afficher du japonais
        self.user_ja = user_writes_japanese
        self.buf = ""            # ligne en cours (incomplète)
        self.i = 0               # index de la phrase en cours
        self.emotion = "neutral"
        self.first_emotion: str | None = None
        self._said = False       # 'say' déjà émis pour la ligne en cours
        self._shown = 0          # caractères de traduction déjà émis pour la ligne en cours
        self._displayed = 0      # nb de lignes déjà affichées (pour les sauts de ligne)
        self.lines: list[dict] = []   # {ja, fr, emotion} finalisées
        self.raw = ""

    # ------------------------------------------------------------ API

    def feed(self, delta: str) -> list[dict]:
        self.raw += delta
        self.buf += delta
        out: list[dict] = []
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            out += self._process(line, final=True)
        out += self._process(self.buf, final=False)
        return out

    def finish(self) -> list[dict]:
        out = self._process(self.buf, final=True)
        self.buf = ""
        return out

    @property
    def said_count(self) -> int:
        return sum(1 for l in self.lines if l["ja"])

    @property
    def reply(self) -> str:
        """Texte complet dans la langue de l'utilisateur."""
        return "\n".join(l["fr"] for l in self.lines if l["fr"]).strip()

    @property
    def say_ja(self) -> str:
        return "".join(l["ja"] for l in self.lines if l["ja"])

    # ------------------------------------------------------------ interne

    def _emit_text(self, text: str) -> list[dict]:
        if not text:
            return []
        if self._shown == 0 and self._displayed > 0:
            text = "\n" + text
        self._shown += 1  # au moins un morceau affiché pour cette ligne
        return [{"type": "token", "t": text}]

    def _process(self, line: str, final: bool) -> list[dict]:
        out: list[dict] = []
        if not line.strip():
            return out
        m = _TAG_RE.match(line)
        if m:
            emo = m.group(1).lower()
            if self.first_emotion is None:
                self.first_emotion = emo
                out.append({"type": "emotion", "emotion": emo})
            self.emotion = emo
            rest = line[m.end():]
        elif not final and line.lstrip().startswith("[") and "]" not in line:
            return out  # balise en cours d'écriture
        else:
            rest = line

        if MARKER in rest:
            ja, fr = rest.split(MARKER, 1)
            ja = _clean(ja)
            if not _JAPANESE_RE.search(ja):
                # modèle distrait (français ou anglais avant « ||| ») : GPT-SoVITS lirait du
                # charabia → pas de voix pour cette ligne (traduction de secours si aucune)
                ja = ""
            if not self._said and ja:
                out.append({"type": "say", "i": self.i, "ja": ja, "emotion": self.emotion})
                self._said = True
            fr = _clean(fr) if final else fr.lstrip()
            # traduction : on n'envoie que la partie nouvelle
            cur = getattr(self, "_fr_sent", "")
            if fr.startswith(cur) and len(fr) > len(cur):
                out += self._emit_text(fr[len(cur):])
                self._fr_sent = fr
            if final:
                self._close_line(ja, _clean(fr), out)
            return out

        if not final:
            return out  # pas encore de « ||| » : la phrase japonaise n'est pas finie

        text = _clean(rest)
        if not text:
            self._reset_line()
            return out
        if _KANA_RE.search(text) and not self.user_ja:
            # japonais sans traduction alors que l'utilisateur écrit en français :
            # voix tout de suite, sous-titre traduit à part (set_fr)
            out.append({"type": "say", "i": self.i, "ja": text, "emotion": self.emotion})
            out.append({"type": "translate", "i": self.i, "ja": text})
            self.lines.append({"i": self.i, "ja": text, "fr": "", "emotion": self.emotion})
            self.i += 1
            self._reset_line()
        elif _KANA_RE.search(text):
            # l'utilisateur parle japonais : la ligne sert à la fois de voix et de texte
            out.append({"type": "say", "i": self.i, "ja": text, "emotion": self.emotion})
            out += self._emit_text(text)
            self._close_line(text, text, out)
        elif self.lines and self.lines[-1]["ja"] and not self.lines[-1]["fr"]:
            # le modèle est passé à la ligne juste après « ||| » : traduction de la ligne précédente
            self.lines[-1]["fr"] = text
            self._shown = 0
            out += self._emit_text(text)
            out.append({"type": "line", "i": self.lines[-1]["i"], "fr": text})
            self._displayed += 1
            self._reset_line()
        else:
            # ligne sans japonais (modèle distrait) : affichée, voix ajoutée en secours
            out += self._emit_text(text)
            self.lines.append({"i": None, "ja": "", "fr": text, "emotion": self.emotion})
            self._displayed += 1
            self._reset_line()
        return out

    def set_fr(self, i: int, fr: str) -> bool:
        """Sous-titre traduit après coup ; False si la ligne en a déjà un."""
        for l in self.lines:
            if l["i"] == i and not l["fr"]:
                l["fr"] = fr
                return True
        return False

    def formatted(self) -> str:
        """La réponse réécrite au format attendu, pour l'historique : si le modèle y relit
        des lignes sans « ||| », il recopie l'erreur aux tours suivants."""
        out = []
        for l in self.lines:
            tag = f"[{l['emotion']}]"
            if l["ja"] and l["fr"] and l["fr"] != l["ja"]:
                out.append(f"{tag}{l['ja']} ||| {l['fr']}")
            elif l["ja"] or l["fr"]:
                out.append(tag + (l["ja"] or l["fr"]))
        return "\n".join(out)

    def _close_line(self, ja: str, fr: str, out: list[dict]) -> None:
        self.lines.append({"i": self.i, "ja": ja, "fr": fr, "emotion": self.emotion})
        out.append({"type": "line", "i": self.i, "fr": fr})
        if fr:
            self._displayed += 1
        self.i += 1
        self._reset_line()

    def _reset_line(self) -> None:
        self._said = False
        self._shown = 0
        self._fr_sent = ""
