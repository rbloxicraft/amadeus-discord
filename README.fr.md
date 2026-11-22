# AMADEUS pour Discord — Kurisu dans ton salon vocal

[English](README.md) · **Français**

Un fork d'[Amadeus](https://github.com/rbloxicraft/amadeus) (compagnon IA inspiré de
Steins;Gate) qui fait venir Kurisu dans un **salon vocal Discord**. Elle écoute tout le
monde, répond à voix haute avec sa voix japonaise quand on l'appelle, et diffuse sa scène
(avatar 3D, sous-titres français) en Go Live.

> [!CAUTION]
> **Ce projet nécessite un self-bot, et les self-bots sont interdits par Discord.**
>
> Amadeus n'utilise pas un compte bot : elle tourne sur un **compte Discord utilisateur
> normal, piloté par un programme**, un vrai client Discord dans un navigateur commandé
> par [Puppeteer](https://pptr.dev), plus
> [discord.js-selfbot-v13](https://www.npmjs.com/package/@lng2004/discord.js-selfbot-v13).
> Automatiser un compte utilisateur enfreint les
> [conditions d'utilisation de Discord](https://discord.com/terms) et ses
> [règles de la communauté](https://discord.com/guidelines). **Le compte peut être banni
> à tout moment, sans prévenir.**
>
> - Utilise un **compte dédié, jetable**, jamais le tien.
> - Ne partage jamais le token de ce compte : il donne un accès complet au compte.
> - Tu utilises ce projet **entièrement à tes risques**. Il est fourni pour apprendre et
>   expérimenter chez soi, sans aucune garantie.

> [!IMPORTANT]
> **Consentement.** Amadeus transcrit tout ce qui se dit dans le salon vocal. Préviens les
> gens du serveur avant de l'inviter. Aucun son n'est enregistré ; seules les phrases
> auxquelles elle répond sont gardées en texte (sa mémoire et son journal).

## Ce qu'elle fait

- **Écoute chaque personne séparément** (Whisper, sur ta carte graphique) et sait qui parle.
- **Répond quand on l'appelle** par son nom (Amadeus, Kurisu, Makise…), même quand la
  reconnaissance vocale écorche le nom. La personne à qui elle répond peut continuer à
  lui parler sans répéter son nom.
- **Parle avec la voix japonaise de Kurisu** (GPT-SoVITS, en local) et **diffuse sa scène**
  en Go Live : avatar, émotions, bouche synchronisée, sous-titres français.
- **Se souvient du serveur** dans sa propre mémoire, séparée de ton Amadeus perso.
- **Connaît l'heure, la météo, et peut chercher sur le web.**
- **Modération (facultative)** : les insultes envers elle et les mots interdits que tu
  choisis. Deux en deux minutes déconnectent la personne du vocal ; si elle recommence
  après être revenue, elle est mute sur le serveur pour un moment.
- **Page de configuration** sur `http://127.0.0.1:8643/admin` (depuis ce PC uniquement) :
  salon vocal, quand elle répond, surnoms, mots interdits, cerveau, stream, journal en
  direct, mémoire.

## Ce qu'il te faut

- Windows 10/11 et une **carte graphique NVIDIA** (8 Go de mémoire vidéo, c'est juste mais
  ça marche).
- Le projet principal **[Amadeus](https://github.com/rbloxicraft/amadeus), installé dans un
  dossier `amadeus` juste à côté de celui-ci**. Ce fork réutilise sa voix et son
  environnement Python : rien n'est téléchargé deux fois.
- [Node.js](https://nodejs.org) 20 ou plus récent, et Microsoft Edge (ou Google Chrome).
- Un **compte Discord dédié** à Amadeus, déjà présent sur ton serveur.
- Une clé d'API d'IA (la même que pour le projet principal). Une clé
  [DeepSeek](https://platform.deepseek.com) est conseillée : elle commence à répondre en
  1 seconde environ.

## Installation

```
Projets\
├─ amadeus\           ← le projet principal, installé avec son install.bat
└─ amadeus-discord\   ← ce dépôt
```

1. Installe d'abord le projet principal (`install.bat`, voir son README).
2. Clone ce dépôt juste à côté, puis lance **`setup_discord.bat`**. Il relie la voix et
   l'environnement Python du projet principal, crée `backend\.env` (tes clés d'API, port
   8643, mémoire séparée) et `discord-bot\.env`, et installe les modules du bot.
3. Mets le token du compte **dédié** d'Amadeus dans `discord-bot\.env`
   (`DISCORD_USER_TOKEN=`). Il ne sert qu'à la connexion d'arrière-plan qui lit les pseudos
   et les salons, et applique la modération.
4. Lance **`start_discord.bat`**. La première fois, connecte le compte Amadeus dans
   l'onglet Discord qui s'ouvre. La session est gardée dans `data\discord-profile`.
5. Dans la page de configuration, choisis le serveur et le salon vocal.

`stop_discord.bat` arrête Amadeus et son backend. Le serveur de voix reste allumé (ton
Amadeus perso s'en sert aussi) ; `stop_discord.bat -All` l'arrête aussi.

Le guide complet est dans [DISCORD.md](DISCORD.md) : chaque réglage, le fonctionnement et
les fichiers concernés.

## Crédits

Projet de fan, sans lien avec MAGES., Chiyomaru Studio ou Discord. **Aucun contenu du jeu
ni de l'anime n'est inclus dans ce dépôt.** Le modèle de voix de Kurisu est un modèle
communautaire, téléchargé depuis Hugging Face par l'installateur du projet principal. Le
reste est décrit dans le [projet principal](https://github.com/rbloxicraft/amadeus#crédits).
