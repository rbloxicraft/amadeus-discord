"""Modération Discord : la phrase adressée à Amadeus est-elle une insulte envers elle ?

Petit appel au cerveau (/api/moderate), à part de la réponse : une réponse coupée par la
phrase suivante ne fait pas perdre le verdict. Le client Discord compte ensuite les
insultes et agit (déconnexion du vocal, puis mute).
"""
import logging

from . import llm

log = logging.getLogger("amadeus.moderation")

_PROMPT = """You moderate a French Discord voice chat for an AI character called Amadeus \
(also Kurisu, Christina). The message below was said out loud TO Amadeus and transcribed \
automatically (imperfect speech-to-text).

Answer YES only if the speaker insults or verbally abuses AMADEUS herself: name-calling, \
vulgar insults (« connasse », « ta gueule », « va te faire foutre », « t'es une merde »…), \
slurs, sexual harassment or degrading remarks aimed at her.
Answer NO for everything else: friendly teasing and jokes between friends, mild remarks \
(« t'es nulle », « t'es bête ou quoi », « idiote », « t'es lente »), playful banter, swearing that is not aimed at her (« putain c'est dur »), criticism \
or disagreement, insults aimed at someone else or at a game, quoting, garbled text.
The transcription often garbles insults phonetically: judge by how the words SOUND \
(« on a te gul » = « ta gueule », « ni Nick Taras » = « nique ta race », « fils de pupute », \
« bouffer tes morts »). The speaker's previous lines (if given) help: someone who just \
insulted her and says something that sounds like an insult is insulting her again.
When unsure, answer NO. Reply with exactly one word: YES or NO."""


async def is_insult(speaker: str, message: str, before: list[str] | None = None) -> bool:
    who = speaker or "Someone"
    prev = ("Speaker's previous lines to Amadeus:\n" + "\n".join(f"- {l}" for l in before) + "\n\n") if before else ""
    try:
        out = await llm.complete([
            {"role": "system", "content": _PROMPT},
            {"role": "user", "content": f"{prev}Message to judge — {who}: {message}"},
        ], max_tokens=300, temperature=0.0)
    except Exception as e:
        log.warning("Modération indisponible : %s", e)
        return False
    verdict = out.strip().upper().startswith("YES")
    if verdict:
        log.info("Insulte envers Amadeus détectée (%s)", speaker or "?")
    return verdict
