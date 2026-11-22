"""Outils du cerveau : ce qu'Amadeus peut aller chercher pendant une réponse.

- l'heure et la date : pas un outil, elles sont données à chaque question (aucun délai) ;
- météo : Open-Meteo (gratuit, sans clé) ; ville par défaut dans les réglages (/admin) ;
- recherche web (via GPT-OSS chez Groq) : la culture et l'actualité qu'elle ignore.

Le cerveau appelle un outil s'il en a besoin (function calling OpenAI) : un aller-retour
de plus (1 à 4 s) seulement dans ce cas. Seule la ville ou la question part vers ces services.
"""
import json
import logging
import re
from datetime import datetime

import httpx

from . import discord_cfg

log = logging.getLogger("amadeus.tools")

_UA = {"User-Agent": "Amadeus-companion/1.0 (personal project)"}
_http: httpx.AsyncClient | None = None

_JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août",
         "septembre", "octobre", "novembre", "décembre"]


def now_note() -> str:
    """Message système : date et heure locales (heure du PC)."""
    n = datetime.now().astimezone()
    tz = n.strftime("%z")
    return (f"Current local date and time: {_JOURS[n.weekday()]} {n.day} {_MOIS[n.month - 1]} "
            f"{n.year}, {n:%H:%M} (UTC{tz[:3]}:{tz[3:]}). Use it only when asked or when it "
            "truly matters; don't comment on the hour or keep reminding people it's late.")


def _client() -> httpx.AsyncClient:
    global _http
    if _http is None:
        _http = httpx.AsyncClient(timeout=6.0, headers=_UA, follow_redirects=True)
    return _http


# ---------------------------------------------------------------- météo

_WMO = {0: "ciel dégagé", 1: "plutôt dégagé", 2: "partiellement nuageux", 3: "couvert",
        45: "brouillard", 48: "brouillard givrant", 51: "bruine légère", 53: "bruine",
        55: "forte bruine", 56: "bruine verglaçante", 57: "bruine verglaçante",
        61: "pluie légère", 63: "pluie", 65: "forte pluie", 66: "pluie verglaçante",
        67: "pluie verglaçante", 71: "neige légère", 73: "neige", 75: "forte neige",
        77: "grains de neige", 80: "averses", 81: "averses", 82: "fortes averses",
        85: "averses de neige", 86: "fortes averses de neige", 95: "orage",
        96: "orage avec grêle", 99: "orage avec grêle"}


async def get_weather(city: str = "", days: int = 1) -> dict:
    city = (city or discord_cfg.load().get("weather_city") or "").strip()
    if not city:
        return {"error": "unknown city: ask the person, in character and in their language, "
                         "which city they mean"}
    days = max(2, min(int(days or 2), 7))       # toujours demain aussi : « ce soir / demain »
    c = _client()
    g = (await c.get("https://geocoding-api.open-meteo.com/v1/search",
                     params={"name": city, "count": 1, "language": "fr"})).json()
    if not g.get("results"):
        return {"error": f"city not found: {city}"}
    p = g["results"][0]
    w = (await c.get("https://api.open-meteo.com/v1/forecast", params={
        "latitude": p["latitude"], "longitude": p["longitude"], "timezone": "auto",
        "forecast_days": days,
        "current": "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation",
        "daily": "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max",
    })).json()
    cur, d = w["current"], w["daily"]
    return {
        "place": f"{p['name']}, {p.get('country', '')}",
        "now": {"temp_c": cur["temperature_2m"], "feels_like_c": cur["apparent_temperature"],
                "sky": _WMO.get(cur["weather_code"], "?"), "wind_kmh": cur["wind_speed_10m"],
                "precipitation_mm": cur["precipitation"]},
        "days": [{"day": ["today", "tomorrow"][i] if i < 2 else d["time"][i],
                  "sky": _WMO.get(d["weather_code"][i], "?"),
                  "min_c": d["temperature_2m_min"][i], "max_c": d["temperature_2m_max"][i],
                  "rain_chance_pct": d["precipitation_probability_max"][i]}
                 for i in range(len(d["time"]))],
    }


# ---------------------------------------------------------------- recherche web

_CITE_RE = re.compile(r"【[^】]*】|\*\*")


async def web_search(query: str) -> dict:
    """Recherche web intégrée de GPT-OSS chez Groq (sans clé de plus que GROQ_API_KEY).
    Coûteuse en quota Groq (3 000 à 40 000 jetons) : le cerveau ne l'appelle qu'au besoin."""
    from . import llm
    client = llm.get_client("gptoss")
    r = await client.chat.completions.create(
        model=llm.BRAINS["gptoss"]["model"], tools=[{"type": "browser_search"}],
        reasoning_effort="low", max_tokens=1000, temperature=0.3,
        messages=[{"role": "system", "content": now_note() + " Search the web and answer in 1-3 "
                   "short factual sentences, in the language of the question, with dates when "
                   "relevant. Prefer the most recent information."},
                  {"role": "user", "content": query}])
    return {"answer": _CITE_RE.sub("", r.choices[0].message.content or "").strip()}


# ---------------------------------------------------------------- déclaration au cerveau

SPECS = [
    {"type": "function", "function": {
        "name": "get_weather",
        "description": "Current weather and forecast for a city. Without a city: the user's own city.",
        "parameters": {"type": "object", "properties": {
            "city": {"type": "string", "description": "City name; omit for the user's city"},
            "days": {"type": "integer", "description": "Days of forecast, 1 = today only (max 7)"},
        }},
    }},
    {"type": "function", "function": {
        "name": "web_search",
        "description": "Search the web: facts you don't know or that may have changed since your "
                       "memories (recent games, releases, scores, news, people). Not for small talk.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "Full question, e.g. 'Hollow Knight Silksong release date'"},
        }, "required": ["query"]},
    }},
]

_FUNCS = {"get_weather": get_weather, "web_search": web_search}


def specs() -> list[dict]:
    """Outils proposés : la recherche web demande la clé Groq."""
    from . import llm
    return [s for s in SPECS if s["function"]["name"] != "web_search" or llm._configured("gptoss")]


async def run(name: str, arguments: str) -> str:
    """Exécute un appel d'outil du cerveau → résultat JSON (jamais d'exception)."""
    try:
        args = json.loads(arguments or "{}")
        fn = _FUNCS.get(name)
        result = await fn(**args) if fn else {"error": f"unknown tool {name}"}
    except Exception as e:      # réseau, arguments inventés…
        log.warning("Outil %s : %s", name, e)
        result = {"error": "tool unavailable right now"}
    log.info("Outil %s(%s)", name, (arguments or "")[:80])
    return json.dumps(result, ensure_ascii=False)
