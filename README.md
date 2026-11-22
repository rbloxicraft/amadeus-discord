# AMADEUS for Discord — Kurisu in your voice channel

**English** · [Français](README.fr.md)

A fork of [Amadeus](https://github.com/rbloxicraft/amadeus) (an AI companion inspired by
Steins;Gate) that brings Kurisu into a **Discord voice channel**. She listens to everyone,
answers out loud with her Japanese voice when someone calls her, and streams her stage
(3D avatar, French subtitles) with Go Live.

> [!CAUTION]
> **This project requires a self-bot, and self-bots are forbidden by Discord.**
>
> Amadeus does not use a bot account: she runs on a **regular Discord user account
> controlled by a program**, a real Discord client in a browser driven by
> [Puppeteer](https://pptr.dev) plus
> [discord.js-selfbot-v13](https://www.npmjs.com/package/@lng2004/discord.js-selfbot-v13).
> Automating a user account breaks
> [Discord's Terms of Service](https://discord.com/terms) and
> [Community Guidelines](https://discord.com/guidelines). **The account can be banned at
> any time, without warning.**
>
> - Use a **dedicated, throwaway account**, never your own.
> - Never share that account's token: it gives full access to the account.
> - You use this project **entirely at your own risk**. It is provided for learning and
>   personal experiments, with no warranty.

> [!IMPORTANT]
> **Consent.** Amadeus transcribes everything that is said in the voice channel. Tell the
> people on the server before inviting her. No audio is recorded; only the sentences she
> answers are kept as text (her memory and her log).

## What she does

- **Listens to each person separately** (Whisper, on your GPU) and knows who is talking.
- **Answers when called** by name (Amadeus, Kurisu, Makise…), even when the speech
  recognition mangles the name. Whoever she answers can keep talking to her without
  repeating her name.
- **Speaks with Kurisu's Japanese voice** (GPT-SoVITS, local) and **streams her stage** with
  Go Live: avatar, emotions, lip sync, French subtitles.
- **Remembers the server** in her own memory, separate from your personal Amadeus.
- **Knows the time, the weather, and can search the web.**
- **Moderation (optional)**: insults aimed at her and banned words you choose. Two in two
  minutes disconnect the person from the voice channel; doing it again after coming back
  gets a temporary server mute.
- **Configuration page** at `http://127.0.0.1:8643/admin` (this PC only): voice channel,
  when she answers, nicknames, banned words, brain, stream, live log, memory.

## Requirements

- Windows 10/11 and an **NVIDIA GPU** (8 GB of VRAM is tight but works).
- The main project **[Amadeus](https://github.com/rbloxicraft/amadeus), installed in a
  folder named `amadeus` next to this one**. This fork reuses its voice model and Python
  environment: nothing is downloaded twice.
- [Node.js](https://nodejs.org) 20 or newer, and Microsoft Edge (or Google Chrome).
- A **dedicated Discord account** for Amadeus, already on your server.
- An AI API key (same as the main project). A [DeepSeek](https://platform.deepseek.com)
  key is recommended: answers start in about 1 second.

## Installation

```
Projects\
├─ amadeus\           ← the main project, installed with its install.bat
└─ amadeus-discord\   ← this repository
```

1. Install the main project first (`install.bat`, see its README).
2. Clone this repository next to it, then run **`setup_discord.bat`**. It links the
   main project's voice and Python environment, creates `backend\.env` (your API keys,
   port 8643, separate memory) and `discord-bot\.env`, and installs the bot modules.
3. Put the token of Amadeus's **dedicated** account in `discord-bot\.env`
   (`DISCORD_USER_TOKEN=`). It is used only by the background connection that reads
   nicknames and channels, and applies moderation.
4. Run **`start_discord.bat`**. The first time, sign in with the Amadeus account in the
   Discord tab that opens. The session is kept in `data\discord-profile`.
5. On the configuration page, choose the server and the voice channel.

`stop_discord.bat` stops Amadeus and her backend. The voice server keeps running (your
personal Amadeus uses it too); `stop_discord.bat -All` stops it as well.

The full guide (in French) is in [DISCORD.md](DISCORD.md): every setting, how it works,
and the files involved.

## Credits

Fan project, not affiliated with MAGES., Chiyomaru Studio or Discord. **No content from the
game or the anime is included in this repository.** The Kurisu voice model is a community
model downloaded from Hugging Face by the main project's installer. Everything else is
described in the [main project](https://github.com/rbloxicraft/amadeus#credits).
