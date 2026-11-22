# Amadeus sur Discord (fork)

Amadeus rejoint un salon vocal Discord avec **son propre compte**, dans un vrai Discord
(fenêtre Edge pilotée) : elle écoute chaque participant, répond avec la vraie voix
japonaise de Kurisu quand on l'appelle, et **partage sa scène** (avatar 3D, fond,
sous-titres français) en Go Live. Elle a **sa propre mémoire**, séparée de ton Amadeus perso.

> ⚠️ **Compte utilisateur piloté par un programme** : contraire aux conditions de Discord,
> le compte peut être banni. Utilise un compte dédié, jamais ton compte principal, et ne
> connecte pas ce compte ailleurs pendant qu'Amadeus tourne (il serait éjecté du vocal).
>
> **Consentement** : Amadeus écoute et transcrit tout ce qui se dit dans le salon.
> Préviens les gens du serveur. Rien n'est enregistré en audio ; seules les phrases
> auxquelles elle répond sont gardées (texte : mémoire et journal). Le reste n'apparaît
> qu'en direct dans la page de configuration.

## Démarrer

1. Le projet principal Amadeus doit être installé juste à côté (`..\amadeus`, avec son
   `install.bat`) : ce fork partage sa voix (GPT-SoVITS) et son environnement Python.
   **`setup_discord.bat`** (une fois) crée les liens, `backend\.env` et `discord-bot\.env`,
   et installe les modules du bot (Node.js requis).
2. `discord-bot\.env` : `DISCORD_USER_TOKEN=` (token du compte **dédié** à Amadeus : sert à
   la connexion qui donne les pseudos, les salons et sert à la modération).
3. **`start_discord.bat`** : voix, backend Discord (port 8643), puis une fenêtre Edge avec
   deux onglets, **Discord** et **Amadeus Stage**. La première fois, connecte le compte
   Amadeus dans l'onglet Discord (la session est gardée dans `data\discord-profile`).
   La page de configuration s'ouvre : **http://127.0.0.1:8643/admin** (depuis ce PC uniquement).
4. **`stop_discord.bat`** : arrête Amadeus et le backend Discord. La voix reste allumée
   (ton Amadeus perso l'utilise) ; `stop_discord.bat -All` l'arrête aussi.

Ne ferme pas la fenêtre Edge et ne réduis pas l'onglet de la scène pendant le stream.
Évite de faire tourner Amadeus perso en même temps : chacun charge Whisper sur la carte
graphique (et un jeu ouvert en parallèle ralentit beaucoup Whisper).

## Page de configuration

- **État** : compte, salon, présents, activité ; rejoindre / quitter, lancer ou arrêter
  le stream, faire taire ; « Dire quelque chose » (elle réagit comme si tu parlais en vocal).
- **Aperçu** de la scène diffusée.
- **En direct** : ce qu'elle entend (grisé quand elle ne répond pas) et ce qu'elle dit.
- **Réglages** (appliqués immédiatement) :
  - salon vocal, connexion automatique ;
  - quand elle répond : quand on l'appelle (mots : amadeus, kurisu…), seulement à toi, ou
    à tout le monde ; « suite de conversation » (la personne à qui elle répond peut continuer à
    lui parler sans la nommer, tant qu'elle reprend la parole dans ce délai après chaque
    réponse ; ce qu'elle dit pendant qu'Amadeus parle encore est traité juste après) ; l'interrompre en l'appelant ;
  - **surnoms et mots à reconnaître** : les pseudos des gens présents dans le vocal sont
    donnés tout seuls à la reconnaissance vocale et au cerveau ; ajoute ici ceux qu'on
    appelle autrement à l'oral (`Max = Maxime_42 (PS5)`) ou des mots difficiles
    (noms de jeux…) ;
  - **ville pour la météo** (quand on lui demande la météo sans dire où) ;
  - langue parlée (français conseillé), phrases par réponse, durée minimale d'une phrase,
    **réactivité** (silence qui marque la fin d'une phrase : plus court = elle répond plus
    vite, mais peut couper ceux qui hésitent), contexte retenu, volume, cerveau ;
  - stream : on/off, fond, sous-titres (+ phrase japonaise), compteur de divergence,
    vue 2D, taille de la scène (au prochain démarrage).
- **Modération** (cochée par défaut) : deux sortes d'infractions. Les insultes envers
  Amadeus (le cerveau juge chaque phrase qui lui est adressée ; taquineries et jurons entre
  potes exclus) et les **ban words**, mots interdits que tu listes, dits par n'importe qui
  dans le vocal (reconnus aussi mal écrits par Whisper : « connar », « nique ta mer » ;
  Amadeus ne les dit jamais). 2 infractions
  en moins de 2 min : déconnexion du vocal ; si la personne recommence après être revenue
  (dans les 30 min), mute serveur (2 min par défaut), levé tout seul, même après un
  redémarrage. Le compte Amadeus doit avoir les permissions « Déplacer des membres » et
  « Rendre les membres muets », et un rôle au-dessus des personnes concernées.
- **Mémoire** du serveur : modifiable, effaçable. La section `## KURISU` du profil (son
  personnage) n'est jamais réécrite par le résumé automatique : elle ne change que si tu
  la modifies toi-même.

## Fonctionnement

```
Edge (compte Amadeus, Discord web)                       backend du fork (8643)
  ├─ micro : remplacé par la voix de Kurisu ◄──────────── /api/tts (GPT-SoVITS)
  ├─ son de chaque participant (déchiffré par Discord) ──► /api/stt (Whisper)
  │     + « qui parle » (messages de la passerelle vocale)      │
  │                                                         /api/chat (mode discord)
  └─ partage d'écran : onglet « Amadeus Stage » ◄── bouche, émotion, sous-titres (/ws/stage)
```

- `discord-bot/amadeus-client.mjs` : pilote la fenêtre Edge, décide quand répondre, joue
  la voix, anime la scène. Journal : `data\amadeus-client.log` (un par lancement, le
  précédent en `.old.log`), avec le délai de chaque réponse : texte reconnu, 1re phrase
  du cerveau, 1er son.
- `backend/app/tools.py` : ce qu'elle sait aller chercher. L'heure et la date (toujours
  connues), la météo (Open-Meteo, gratuit) et une recherche web (celle de GPT-OSS chez
  Groq, clé `GROQ_API_KEY`). Le cerveau ne s'en sert que quand la question le demande :
  1 à 4 s de plus dans ce cas. Une recherche consomme beaucoup du quota gratuit de Groq ;
  s'il est épuisé, les réponses suivantes passent quelques instants par un cerveau de secours.
- Cerveaux (`backend/app/llm.py`, choix dans /admin) : principal (`LLM_API_KEY`), GPT-OSS
  chez Groq (gratuit, très rapide, mais quota par minute vite épuisé à plusieurs) et DeepSeek
  (`DEEPSEEK_API_KEY`, payant, très peu cher : 1re phrase en ~1 s, régulier). Quand le cerveau
  choisi est à court de quota, la question part sur DeepSeek, puis sur le principal.
- `discord-bot/pcm.mjs` : lit la voix (WAV en flux) et la passe en 48 kHz pour Discord.
- `discord-bot/page-inject.js` : injecté dans la page Discord (micro virtuel, écoute).
- `backend/app/discord_cfg.py` : réglages (`data/discord.json`).
- `frontend/stage.html` : la scène diffusée ; `frontend/admin.html` : la configuration.
