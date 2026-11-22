// ============================================================
//  AMADEUS — le compte Amadeus dans un VRAI Discord (Edge visible, piloté) :
//    - rejoint le salon vocal comme un utilisateur normal ;
//    - parle : le micro de la page est remplacé par la voix de Kurisu (page-inject.js) ;
//    - écoute : le son de chaque participant, capté dans la page (déjà déchiffré par
//      Discord), transcrit par Whisper (backend du fork, port 8643) ;
//    - diffuse la scène (onglet « Amadeus Stage ») avec le partage d'écran de Discord.
//  Une connexion du même compte (sans vocal) donne les pseudos, la
//  liste des serveurs/salons et qui est dans le vocal.
//
//  Compte utilisateur piloté par un programme : contraire aux conditions de Discord,
//  à tes risques. Connexion au compte : une fois, à la main, dans la fenêtre Discord.
// ============================================================
import 'dotenv/config';
import { Client } from '@lng2004/discord.js-selfbot-v13';
import puppeteer from 'puppeteer-core';
import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import { wavTo48k } from './pcm.mjs';
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.AMADEUS_API || 'http://127.0.0.1:8643';
const TOKEN = process.env.DISCORD_USER_TOKEN;
const PROFILE = path.resolve(HERE, '..', 'data', 'discord-profile');   // session Discord d'Amadeus
const LOGFILE = path.resolve(HERE, '..', 'data', 'amadeus-client.log');
const MUTESFILE = path.resolve(HERE, '..', 'data', 'moderation.json');   // mutes à lever
const INJECT = readFileSync(path.join(HERE, 'page-inject.js'), 'utf8');
const STAGE_TITLE = 'Amadeus Stage';
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

/* journal : console + fichier. logConsole : console seulement (ce que les gens disent
   sans s'adresser à elle n'est pas gardé sur le disque) */
const log = (...a) => {
  const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`;
  console.log(line);
  try { appendFileSync(LOGFILE, `${line}\n`); } catch { /* journal facultatif */ }
};
const logConsole = (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
try {                                     // un journal par lancement (+ le précédent)
  if (statSync(LOGFILE).size > 0) renameSync(LOGFILE, LOGFILE.replace(/\.log$/, '.old.log'));
} catch { /* pas encore de journal */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let settings = null;
let hub = null;
let page = null;               // la page Discord
let wantVoice = false;         // être dans le vocal (rejoindre / quitter depuis /admin)
const client = new Client();   // pseudos, salons, présents ; modération (déconnexion, mute)
const state = { thinking: false, speaking: false, here: false };   // here : en vocal depuis cette fenêtre

// ------------------------------------------------------------ backend (hub)

function hubSend(msg) { if (hub?.readyState === WebSocket.OPEN) hub.send(JSON.stringify(msg)); }
function adminLog(kind, who, text) { hubSend({ type: 'log', kind, who, text, t: Date.now() }); }

function connectHub() {
  hub = new WebSocket(`${API.replace(/^http/, 'ws')}/ws/bot`);
  hub.on('open', () => { log('Relié au backend Amadeus'); sendStatus(); });
  hub.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.type === 'settings') onSettings(m.settings);
    else if (m.type === 'command') onCommand(m).catch((e) => log('commande :', e.message));
  });
  hub.on('close', () => setTimeout(connectHub, 2000));
  hub.on('error', () => {});
}

// ------------------------------------------------------------ état du vocal (connexion sans vocal)

function guild() { return settings?.guild_id ? client.guilds.cache.get(settings.guild_id) : null; }
function myVoice() { return guild()?.voiceStates.cache.get(client.user?.id) || null; }
function inVoice() { const v = myVoice(); return !!v?.channelId && v.channelId === settings?.voice_channel_id; }
/* vraiment connecté depuis CETTE fenêtre : l'état Discord peut garder quelques secondes
   une ancienne session ; le bouton « Disconnect » n'existe que si la page est en vocal */
async function pageInVoice() { return !!(await find(LABELS.disconnect)); }

function sendStatus() {
  const g = guild();
  const v = myVoice();
  const ch = state.here && v?.channelId ? g?.channels.cache.get(v.channelId) : null;
  const members = ch
    ? [...g.voiceStates.cache.values()].filter((s) => s.channelId === ch.id && s.id !== client.user?.id)
      .map((s) => ({ id: s.id, name: s.member?.displayName || s.id }))
    : [];
  hubSend({
    type: 'status', user: client.user?.globalName || client.user?.username || null,
    guild: ch ? g.name : null, channel: ch?.name || null,
    connected: !!ch, streaming: !!v?.streaming, members,
    thinking: state.thinking, speaking: state.speaking,
    guilds: [...client.guilds.cache.values()].map((gg) => ({
      id: gg.id, name: gg.name,
      voice: [...gg.channels.cache.values()].filter((c) => c.isVoice?.()).map((c) => ({ id: c.id, name: c.name })),
    })),
  });
}
setInterval(sendStatus, 3000);

function nameOf(userId) {
  if (!userId || userId.startsWith('ssrc:')) return 'Quelqu\'un';
  return guild()?.members.cache.get(userId)?.displayName || client.users.cache.get(userId)?.username || 'Quelqu\'un';
}

/* Pseudos des gens dans le vocal (+ surnoms des réglages), pour que Whisper les écrive
   correctement et que le cerveau sache de qui on parle.
   - whisper : forme « parlée » (sans « (PS5) », « _ », emoji…)
   - brain : pseudos tels quels et « surnom = pseudo » */
function spoken(name) {
  return name.replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[_.\-]+/g, ' ')
    .replace(/[^\p{L}\p{N}' ]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function knownNames() {
  const g = guild(), v = myVoice();
  const names = new Set();
  if (g && v?.channelId) {
    for (const s of g.voiceStates.cache.values()) {
      if (s.channelId !== v.channelId || s.id === client.user?.id || !s.member) continue;
      names.add(s.member.displayName);
      if (s.member.user.globalName && s.member.user.globalName !== s.member.displayName) names.add(s.member.user.globalName);
    }
  }
  const brain = [...names], whisper = new Set([...names].map(spoken).filter((n) => n.length > 1));
  // les mots qui l'appellent (réglages) : écrits tels quels par Whisper, pas « ma qui c'est »
  for (const w of settings?.wake_words || []) if (w.length > 2) whisper.add(w.replace(/^./, (c) => c.toUpperCase()));
  for (const w of settings?.stt_words || []) {
    const [said, who] = w.split('=').map((x) => x.trim());
    if (said) whisper.add(said);
    if (said && who) brain.push(`« ${said} » = ${who}`);
    else if (said) brain.push(said);
  }
  return { whisper: [...whisper].join(', ').slice(0, 300), brain };
}

// ------------------------------------------------------------ navigateur + Discord

async function launch() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('ni Edge ni Chrome trouvé');
  const w = settings?.stream_width || 1280, h = settings?.stream_height || 720;
  const browser = await puppeteer.launch({
    executablePath: exe, headless: false, userDataDir: PROFILE, defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      `--app=${API}/stage`, `--window-size=${w},${h + 32}`,
      // partage d'écran : la fenêtre/l'onglet « Amadeus Stage » est choisi tout seul.
      // (PAS de --use-fake-ui-for-media-stream : il choisit l'écran entier ; le micro
      // n'en a pas besoin, c'est le micro virtuel injecté dans la page)
      `--auto-select-tab-capture-source-by-title=${STAGE_TITLE}`,
      `--auto-select-desktop-capture-source=${STAGE_TITLE}`,
      '--mute-audio',                    // le son de l'appel ne sort pas sur tes haut-parleurs
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling', '--autoplay-policy=no-user-gesture-required',
      '--enable-gpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check',
    ],
  });
  browser.on('disconnected', () => { log('Navigateur fermé : arrêt.'); process.exit(1); });
  page = await browser.newPage();
  await page.setBypassCSP(true);
  await page.exposeFunction('__amadeusHeard', (user, ssrc, b64, secs) => {
    try { onHeard(user, ssrc, b64, secs); } catch (e) { log('écoute :', e.message); }
  });
  await page.evaluateOnNewDocument(INJECT);
  await page.goto('https://discord.com/app', { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn();
}

async function loggedIn() {
  if (/\/login|\/register/.test(page.url())) return false;
  return page.evaluate(() => !!document.querySelector(
    '[data-list-id="guildsnav"], [class*="guilds_"], [class*="sidebar_"], [class*="panels_"]'));
}

async function ensureLoggedIn() {
  for (let i = 0; ; i++) {
    if (await loggedIn()) return;
    if (i === 6) {
      log('Connecte-toi au compte AMADEUS dans la fenêtre Discord (une seule fois).');
      adminLog('info', null, 'Connexion requise : connecte le compte Amadeus dans la fenêtre Discord');
    }
    await sleep(2000);
  }
}

const LABELS = {
  join: /^(rejoindre( le)?( salon)? vocal|join voice|rejoindre)$/i,
  disconnect: /^(se )?d[ée]connecter$|^disconnect$/i,
  mute: /(rendre muet|r[ée]activer (le )?micro|couper (le )?micro|d[ée]sactiver (le )?micro|^(un)?mute$|^micro$)/i,
  deafen: /(sourdine|r[ée]activer le son|d[ée]sactiver le son|^(un)?deafen$|^casque$)/i,
  share: /(partager (ton |votre )?[ée]cran|share (your )?screen|^partager$)/i,
  stopShare: /(arr[êe]ter (le )?(stream|partage|live)|stop (stream|streaming|sharing))/i,
  golive: /^(go live|passer en direct|lancer le (live|stream)|commencer|d[ée]marrer)$/i,
};

async function buttons() {
  return page.evaluate(() => [...document.querySelectorAll('button, [role="button"], [role="switch"]')]
    .filter((b) => b.offsetParent !== null)
    .map((b, i) => {
      b.dataset.amadeusIdx = String(i);
      return { i, label: (b.getAttribute('aria-label') || '').trim(), text: (b.innerText || '').trim().slice(0, 40) };
    }));
}
async function find(re) { return (await buttons()).find((b) => re.test(b.label) || re.test(b.text)); }
async function click(b) { await page.evaluate((i) => document.querySelector(`[data-amadeus-idx="${i}"]`)?.click(), b.i); }
async function dumpButtons(why) {
  const list = (await buttons()).map((b) => b.label || b.text).filter(Boolean);
  log(`${why} — boutons visibles : ${[...new Set(list)].slice(0, 70).join(' | ')}`);
}

async function joinVoice() {
  const { guild_id: g, voice_channel_id: c } = settings;
  if (!g || !c) throw new Error('aucun salon choisi (page de configuration)');
  await page.goto(`https://discord.com/channels/${g}/${c}`, { waitUntil: 'domcontentloaded' });
  await ensureLoggedIn();
  await sleep(3000);
  if (!(inVoice() && await pageInVoice())) {
    const j = await find(LABELS.join);
    if (!j) { await dumpButtons('bouton « Rejoindre le vocal » introuvable'); throw new Error('rejoindre le vocal : bouton introuvable'); }
    await click(j);
    for (let i = 0; i < 30 && !(inVoice() && await pageInVoice()); i++) await sleep(500);
    if (!(inVoice() && await pageInVoice())) { await dumpButtons('vocal non rejoint'); throw new Error('vocal non rejoint'); }
  }
  log(`Dans le vocal (${guild()?.channels.cache.get(c)?.name}).`);
  adminLog('info', null, `A rejoint « ${guild()?.channels.cache.get(c)?.name} »`);
}

async function leaveVoice() {
  interrupt();
  const b = await find(LABELS.disconnect);
  if (b) await click(b);
  for (let i = 0; i < 10 && myVoice()?.channelId; i++) await sleep(500);
  adminLog('info', null, 'A quitté le vocal');
}

/* micro et son réactivés (Discord garde l'état d'une session à l'autre) */
async function unmute() {
  const v = myVoice();
  if (v?.selfDeaf) { const d = await find(LABELS.deafen); if (d) { await click(d); await sleep(800); } }
  if (myVoice()?.selfMute) { const m = await find(LABELS.mute); if (m) { await click(m); await sleep(800); } }
}

async function startShare() {
  const s = await find(LABELS.share);
  if (!s) { await dumpButtons('bouton « Partager l\'écran » introuvable'); throw new Error('partage : bouton introuvable'); }
  await click(s);
  await sleep(2500);
  const go = await find(LABELS.golive);
  if (go) { await click(go); await sleep(2500); }
  for (let i = 0; i < 20 && !myVoice()?.streaming; i++) await sleep(500);
  if (!myVoice()?.streaming) { await dumpButtons('partage non démarré'); throw new Error('partage non démarré'); }
  log('Stream de la scène en cours.');
  adminLog('info', null, 'Go Live lancé (partage de la scène)');
}

async function stopShare() {
  const b = await find(LABELS.stopShare);
  if (b) await click(b);
}

/* boucle d'entretien : vocal, micro, stream (toutes les 3 s) */
async function keepAlive() {
  let failures = 0;
  for (;;) {
    try {
      if (settings && client.isReady()) {
        // la page Discord a pu se recharger : réglage d'écoute remis à chaque tour
        await page.evaluate((s) => { if (window.__amadeus) window.__amadeus.endSilence = s; }, settings.end_silence_s);
        const pageIn = await pageInVoice();
        const here = inVoice() && pageIn;
        if (here !== state.here) { state.here = here; sendStatus(); }
        if (wantVoice && !here) { await joinVoice(); failures = 0; }
        else if (!wantVoice && pageIn) await leaveVoice();
        else if (wantVoice) {
          const v = myVoice();
          if (v?.selfMute || v?.selfDeaf) await unmute();
          if (settings.stream_enabled && !myVoice()?.streaming) await startShare();
          else if (!settings.stream_enabled && myVoice()?.streaming) await stopShare();
        }
        failures = 0;
      }
    } catch (e) {
      failures++;
      log('Erreur :', e.message);
      if (failures === 1) adminLog('error', null, e.message);
      await sleep(Math.min(60_000, 4000 * failures));
    }
    await sleep(3000);
  }
}

// ------------------------------------------------------------ écoute

const HALLUCINATION = /sous-titr|amara\.org|merci d'avoir regard|thanks for watching|ご視聴|字幕|チャンネル登録/i;
const pending = new Map();
const recent = [];
let follow = { userId: null, until: 0 };
let deferred = null;   // ce que la personne a enchaîné pendant qu'Amadeus lui répondait encore

function remember(line) { recent.push(line); recent.splice(0, Math.max(0, recent.length - 40)); }

function wav(pcm, rate, ch) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function repetitive(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 4) return false;
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  return Math.max(...Object.values(counts)) / words.length >= 0.6;
}

/* chronométrage de la dernière réponse (journal) */
const timing = { end: 0, stt: 0 };

/* File de transcription : UNE phrase à la fois chez Whisper. Envoyer tout en parallèle
   (chaque bout de phrase de chaque personne) saturait le GPU : la file grossissait sans
   fin et elle comprenait avec des minutes de retard. Ici, les bouts d'une même personne
   qui attendent leur tour sont regroupés en un seul passage (Whisper coûte presque autant
   pour 1 s que pour 20 s d'audio), et une phrase trop vieille est abandonnée : mieux vaut
   en rater une que répondre à côté avec une minute de retard. */
const STT_STALE_MS = 8000;
const STT_GAP = Buffer.alloc(16000 * 2 * 0.3);    // 0,3 s de silence entre deux bouts regroupés
const sttQueue = [];
let sttRunning = false, sttDropped = 0;

function onHeard(user, ssrc, b64, secs) {
  if (!settings || secs < settings.min_speech_s) return;
  const tEnd = Date.now() - settings.end_silence_s * 1000;   // la page attend ce silence avant d'envoyer
  const tStart = Date.now() - secs * 1000 + 170;              // début de la voix (la page garde 170 ms d'avant)
  const userId = user || `ssrc:${ssrc}`;
  if (user && (user === client.user?.id || settings.ignore_ids.includes(user))) return;
  const pcm = Buffer.from(b64, 'base64');
  const q = sttQueue.find((x) => x.userId === userId && x.secs + secs < 28);
  if (q) { q.pcm.push(STT_GAP, pcm); q.secs += secs + 0.3; q.tEnd = tEnd; }
  else sttQueue.push({ user, userId, pcm: [pcm], secs, tStart, tEnd });
  pumpStt();
}

async function pumpStt() {
  if (sttRunning) return;
  sttRunning = true;
  try {
    while (sttQueue.length) {
      const job = sttQueue.shift();
      if (Date.now() - job.tEnd > STT_STALE_MS) {           // trop en retard : abandonnée
        sttDropped++;
        if (sttDropped === 1 || sttDropped % 20 === 0) log(`Transcription en retard : ${sttDropped} phrase(s) abandonnée(s) (carte graphique trop chargée ?)`);
        continue;
      }
      try { await transcribe(job); } catch (e) { log('écoute :', e.message); }
    }
  } finally { sttRunning = false; }
}

async function transcribe({ user, userId, pcm, secs, tStart, tEnd }) {
  const t0 = Date.now();
  // pseudo d'un nouveau venu : demandé pendant que Whisper travaille
  const member = user && !guild()?.members.cache.has(user) ? guild()?.members.fetch(user).catch(() => {}) : null;
  const fd = new FormData();
  fd.append('audio', new Blob([wav(Buffer.concat(pcm), 16000, 1)], { type: 'audio/wav' }), 'speech.wav');
  fd.append('language', settings.stt_language === 'auto' ? '' : settings.stt_language);
  fd.append('names', knownNames().whisper);
  const r = await fetch(`${API}/api/stt`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`STT ${r.status}`);
  const text = ((await r.json()).text || '').trim();
  const sttDone = Date.now();
  const f = (ms) => (ms / 1000).toFixed(1);
  logConsole(`[stt] ${f(secs * 1000)} s d'audio : attente ${f(t0 - tEnd)} s, Whisper ${f(sttDone - t0)} s, file ${sttQueue.length}`);
  if (member) await Promise.race([member, sleep(1500)]);
  if (text.replace(/[\s.,!?…。、]/g, '').length < 2 || HALLUCINATION.test(text) || repetitive(text)) return;
  const p = pending.get(userId) || { texts: [] };
  p.texts.push(text);
  p.end = tEnd; p.stt = sttDone; p.start = Math.min(p.start ?? tStart, tStart);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pending.delete(userId);
    Object.assign(timing, { end: p.end, stt: p.stt });
    heard(userId, p.texts.join(' '), p.start);
  }, 120);   // regroupe deux bouts de phrase transcrits presque ensemble (Whisper ralenti)
  pending.set(userId, p);
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ');
/* forme « au son » d'un mot (français) : Whisper écrit les noms japonais comme il les
   entend (« Makise » → « ma qui c'est », « Maquisez » ; « Kurisu » → « Kourissou »,
   « Curry sous ») */
function phon(w) {
  let s = w.toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');   // accents (NFD) et le reste retirés
  if (s.length > 3) s = s.replace(/(est|ez|er|et|ait|ais|ai)$/, 'e');   // « mer » reste « mer »
  s = s.replace(/([^s])s$/, '$1').replace(/x$/, '');
  return s.replace(/ch(?=r)/g, 'k').replace(/qu/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k')
    .replace(/ou/g, 'u').replace(/z/g, 's').replace(/y/g, 'i').replace(/h/g, '').replace(/(.)\1+/g, '$1')
    .replace(/(.)[dt]$/, '$1').replace(/([^aeiou])e$/, '$1');   // d, t, e muets en fin de mot
}
/* mots entiers « au son », apostrophes collées (« c'est » = un mot, comme à l'oral) */
function phonWords(text) {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '')
    .split(/[^a-z0-9]+/).filter(Boolean).map(phon);
}
/* 1 à 3 mots consécutifs qui, à l'oreille, font exactement p */
function soundsLike(words, p) {
  for (let i = 0; i < words.length; i++) {
    let acc = '';
    for (let j = i; j < Math.min(words.length, i + 3); j++) { acc += words[j]; if (acc === p) return true; }
  }
  return false;
}
function calls(text) {
  const t = norm(text);
  const compact = t.replace(/ /g, '');
  const words = phonWords(text);
  return settings.wake_words.some((w) => {
    const n = norm(w).trim();
    if (!n) return false;
    if (t.includes(n) || compact.includes(n.replace(/ /g, ''))) return true;
    const p = phonWords(n).join('');
    return p.length >= 5 && soundsLike(words, p);
  });
}
/* mot interdit (réglage ban_words) dans la phrase ? → le mot, sinon null */
function bannedWord(text) {
  const t = ` ${norm(text)} `;
  const words = phonWords(text);
  for (const w of settings.ban_words || []) {
    const n = norm(w).trim();
    if (!n) continue;
    if (t.includes(` ${n} `)) return w;
    const p = phonWords(n).join('');
    if (p.length >= 3 && soundsLike(words, p)) return w;
  }
  return null;
}

const busy = () => state.thinking || state.speaking || pumping || queue.length > 0;

/* « Suite de conversation » : la personne à qui elle répond peut continuer sans la nommer,
   aussi longtemps qu'elle enchaîne. Compte : avoir COMMENCÉ à parler (tStart) dans le délai
   après la fin de la voix d'Amadeus (fin de phrase et transcription non décomptées). Ce
   qu'elle dit pendant qu'Amadeus lui répond encore est gardé et traité juste après. */
function heard(userId, text, tStart = Date.now()) {
  const who = nameOf(userId);
  const named = calls(text);
  const isOwner = settings.owner_id && userId === settings.owner_id;
  // « Merci. », « À bientôt ! » seuls : souvent inventés par Whisper sur du bruit, et pas
  // une vraie relance de toute façon
  const filler = /^(merci( beaucoup)?|au revoir|à bientôt|bonne (soirée|nuit|journée)|ok|d'accord)[\s.!…]*$/i.test(text.trim());
  const talking = follow.userId === userId && !filler;
  const followUp = talking && (busy() || (follow.until && tStart < follow.until));
  let answer;
  if (settings.reply_mode === 'everyone') answer = true;
  else if (settings.reply_mode === 'owner') answer = named || isOwner;
  else answer = named || followUp;

  adminLog('heard', who, text + (answer ? '' : '  (sans réponse)'));
  if (settings.moderation && /^\d+$/.test(userId)) {
    const ban = bannedWord(text);
    if (ban) onInsult(userId, who, `mot interdit (${ban})`).catch(moderationFailed);
    else if (named || followUp) checkInsult(userId, who, text);
  }
  (answer ? log : logConsole)(`${who} : ${text}${answer ? '  → réponse' : ''}`);
  if (answer && busy()) {
    if (named && settings.interruptible) interrupt();
    else if (followUp && text.split(/\s+/).length >= 2) {   // pas un « mdr » / bruit isolé
      deferred = { userId, who, text: deferred?.userId === userId ? `${deferred.text} ${text}` : text };
      return;
    } else { remember(`${who}: ${text}`); return; }
  }
  if (!answer) { remember(`${who}: ${text}`); return; }
  follow = { userId, until: 0 };
  reply(userId, who, text).catch(replyFailed);
}

/* Amadeus a fini de parler : répond à ce que la personne a enchaîné entre-temps */
function flushDeferred() {
  if (!deferred || busy()) return;
  const d = deferred;
  deferred = null;
  follow = { userId: d.userId, until: 0 };
  reply(d.userId, d.who, d.text).catch(replyFailed);
}

// ------------------------------------------------------------ modération
/* Infractions : insultes envers Amadeus (jugées par le cerveau, /api/moderate) et mots
   interdits (réglage ban_words, dits par n'importe qui dans le vocal) :
   - 2 en moins de 2 min → la personne est déconnectée du vocal ;
   - revenue, elle recommence (dans les 30 min) → mute serveur (mute_seconds), levé tout seul.
   Les mutes en cours sont notés dans data/moderation.json : levés même après un redémarrage,
   ou au retour de la personne si elle a quitté le vocal entre-temps. */
const STRIKE_WINDOW = 120_000, STRIKE_MEMORY = 30 * 60_000;
const strikes = new Map();   // userId → { times: [], kickedAt }
let mutes = {};              // userId → fin du mute (ms)
try { mutes = JSON.parse(readFileSync(MUTESFILE, 'utf8')); } catch { /* aucun mute en cours */ }
const saveMutes = () => { try { writeFileSync(MUTESFILE, JSON.stringify(mutes)); } catch { /* facultatif */ } };

/* chaque phrase adressée à Amadeus est jugée à part (même si elle n'y répond pas) */
const toAmadeus = new Map();   // userId → ses dernières phrases adressées à Amadeus
function checkInsult(userId, who, text) {
  const before = toAmadeus.get(userId) || [];
  toAmadeus.set(userId, [...before, text].slice(-3));
  fetch(`${API}/api/moderate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ speaker: who, message: text, before }),
  })
    .then((r) => r.json())
    .then((d) => (d.insult ? onInsult(userId, who, 'insulte envers Amadeus') : null))
    .catch(moderationFailed);
}
function moderationFailed(e) { log('modération :', e.message); adminLog('error', null, `Modération impossible : ${e.message}`); }

async function onInsult(userId, who, why) {
  if (!settings.moderation) return;
  const now = Date.now();
  const s = strikes.get(userId) || { times: [], kickedAt: 0 };
  if (s.kickedAt && now - s.kickedAt > STRIKE_MEMORY) s.kickedAt = 0;
  s.times = s.times.filter((t) => now - t < STRIKE_WINDOW).concat(now);
  strikes.set(userId, s);
  const vs = guild()?.voiceStates.cache.get(userId);
  if (s.kickedAt) {
    if (!vs?.channelId) return;
    await vs.setMute(true, 'Amadeus : insultes répétées');
    mutes[userId] = now + settings.mute_seconds * 1000;
    saveMutes();
    s.kickedAt = now; s.times = [];
    log(`Modération : ${who} mute ${settings.mute_seconds} s (${why}, après une déconnexion)`);
    adminLog('info', null, `${who} : mute ${settings.mute_seconds} s (${why}, récidive après déconnexion)`);
  } else if (s.times.length >= 2) {
    if (!vs?.channelId) return;
    await vs.disconnect('Amadeus : insultes répétées');
    s.kickedAt = now; s.times = [];
    log(`Modération : ${who} déconnecté du vocal (2 infractions en moins de 2 min, dernière : ${why})`);
    adminLog('info', null, `${who} : déconnecté du vocal (2 infractions en moins de 2 min, dernière : ${why})`);
  } else {
    adminLog('info', null, `${who} : ${why} (1re infraction ; une autre en moins de 2 min = déconnexion)`);
  }
}

/* lève les mutes arrivés à échéance (la personne doit être en vocal pour ça) */
async function liftMutes() {
  for (const [id, until] of Object.entries(mutes)) {
    if (Date.now() < until) continue;
    const vs = guild()?.voiceStates.cache.get(id);
    if (!vs?.channelId) continue;                    // pas en vocal : au retour
    try {
      if (vs.serverMute) await vs.setMute(false, 'Amadeus : fin du mute');
      delete mutes[id];
      saveMutes();
      log(`Modération : mute levé pour ${nameOf(id)}`);
      adminLog('info', null, `${nameOf(id)} : mute levé`);
    } catch (e) { log('modération (démute) :', e.message); }
  }
}
setInterval(() => { if (client.isReady() && Object.keys(mutes).length) liftMutes(); }, 5000);

// ------------------------------------------------------------ répondre

function replyFailed(e) {
  state.thinking = false;
  if (e?.name === 'AbortError') return;      // coupée par une nouvelle question : normal
  log('réponse :', e.message);
  adminLog('error', null, `Réponse impossible : ${e.message}`);
}

let turn = 0;
let chatAbort = null;
const queue = [];
let pumping = false;

function interrupt() {
  turn++;
  deferred = null;
  chatAbort?.abort();
  for (const q of queue) q.abort.abort();
  queue.length = 0;
  page?.evaluate(() => window.__amadeus?.stop()).catch(() => {});
  setSpeaking(false);
  clearSubtitle(0);
  state.thinking = false;
}

async function reply(userId, who, text) {
  const my = ++turn;
  state.thinking = true;
  sendStatus();
  const context = recent.slice(-settings.context_lines);
  remember(`${who}: ${text}`);
  if (Math.random() < 0.5) hubSend({ type: 'divergence' });
  chatAbort = new AbortController();
  const r = await fetch(`${API}/api/chat`, {
    method: 'POST', signal: chatAbort.signal, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: text, session_id: `discord:${settings.voice_channel_id || 'x'}`, mode: 'discord',
      speaker: who, context, max_lines: settings.max_lines, present: knownNames().brain,
    }),
  });
  if (!r.ok || !r.body) throw new Error(`chat ${r.status}`);
  const dec = new TextDecoder();
  let buf = '';
  const lines = new Map();
  for await (const chunk of r.body) {
    if (my !== turn) return;
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const raw of parts) {
      let ev = 'message', data = '';
      for (const l of raw.split('\n')) {
        if (l.startsWith('event: ')) ev = l.slice(7).trim();
        else if (l.startsWith('data: ')) data += l.slice(6);
      }
      if (!data) continue;
      const d = JSON.parse(data);
      if (ev === 'say') {
        if (!lines.size) timing.say = Date.now();
        lines.set(d.i, say(d.ja, d.emotion));
      }
      else if (ev === 'line') {
        const it = lines.get(d.i);
        if (it && d.fr) { it.fr = d.fr; if (it === current) showSubtitle(it); }
      } else if (ev === 'done') {
        state.thinking = false;
        adminLog('said', 'Amadeus', d.reply);
        remember(`Amadeus: ${d.reply}`);
        follow.userId = userId;
      } else if (ev === 'error') throw new Error(d.message);
    }
  }
  state.thinking = false;
  sendStatus();
  flushDeferred();
}

/* voix d'une phrase : la réponse de /api/tts (WAV en flux, ou MP3 de secours) →
   PCM 16 bits mono 48 kHz, disponible par morceaux au fil de la synthèse */
function voiceStream(text, emotion, signal) {
  const st = { chunks: [], done: false, error: null, waiters: [] };
  const wake = () => { for (const w of st.waiters.splice(0)) w(); };
  st.next = () => new Promise((res) => { if (st.chunks.length || st.done) res(); else st.waiters.push(res); });
  (async () => {
    try {
      const r = await fetch(`${API}/api/tts`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, emotion }),
      });
      if (!r.ok || !r.body) throw new Error(`voix ${r.status}`);
      if ((r.headers.get('content-type') || '').startsWith('audio/wav')) {
        // voix de Kurisu (GPT-SoVITS) : lue ici, morceau par morceau (voir pcm.mjs)
        const w = wavTo48k((pcm) => { st.chunks.push(pcm); wake(); });
        for await (const ch of r.body) w.push(Buffer.from(ch));
        w.end();
      } else {
        // voix de secours (MP3) : décodée par ffmpeg
        const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1']);
        const closed = new Promise((res) => ff.on('close', res));
        signal.addEventListener('abort', () => { try { ff.kill('SIGKILL'); } catch { /* fini */ } });
        ff.stdin.on('error', () => {});
        ff.stdout.on('data', (c) => { st.chunks.push(c); wake(); });
        for await (const ch of r.body) {
          if (!ff.stdin.write(Buffer.from(ch))) await new Promise((res) => ff.stdin.once('drain', res));
        }
        ff.stdin.end();
        await closed;
      }
    } catch (e) { st.error = e; }
    st.done = true;
    wake();
  })();
  return st;
}

function say(ja, emotion) {
  const abort = new AbortController();
  const item = { ja, emotion, fr: '', abort, voice: voiceStream(ja, emotion, abort.signal) };
  queue.push(item);
  pump();
  return item;
}

let current = null;
let subClear = 0;
function showSubtitle(it) {
  clearTimeout(subClear);
  hubSend({ type: 'subtitle', fr: it.fr || '', ja: it.ja });
}
function clearSubtitle(delay = 1800) {
  clearTimeout(subClear);
  subClear = setTimeout(() => hubSend({ type: 'subtitle', fr: '', ja: '' }), delay);
}
function setSpeaking(on) { state.speaking = on; hubSend({ type: 'speaking', on }); }

async function pump() {
  if (pumping) return;
  pumping = true;
  const my = turn;
  try {
    while (queue.length && my === turn) {
      const it = queue.shift();
      const v = it.voice;
      current = it;
      hubSend({ type: 'emotion', emotion: it.emotion });
      showSubtitle(it);
      setSpeaking(true);
      const env = [];
      let t0 = 0;
      const mouth = setInterval(() => {
        if (!t0) return;
        const k = Math.floor((Date.now() - t0) / 40);
        hubSend({ type: 'mouth', v: Number(Math.min(1, (env[k] || 0) * 5.5).toFixed(3)) });
      }, 40);
      let carry = Buffer.alloc(0);
      const vol = settings.voice_volume;
      for (;;) {
        await v.next();
        if (my !== turn) break;
        const avail = Buffer.concat([carry, ...v.chunks.splice(0)]);
        // morceaux d'au moins 100 ms (moins d'appels à la page), longueur paire
        if (avail.length < 9600 && !v.done) { carry = avail; continue; }
        const n = avail.length - (avail.length % 2);
        carry = avail.subarray(n);
        if (n) {
          const pcm = Buffer.from(avail.subarray(0, n));          // copie alignée
          const s16 = new Int16Array(pcm.buffer, pcm.byteOffset, n >> 1);
          if (vol !== 1) for (let i = 0; i < s16.length; i++) s16[i] = Math.max(-32768, Math.min(32767, Math.round(s16[i] * vol)));
          for (let i = 0; i + 1920 <= s16.length; i += 1920) {   // enveloppe : 40 ms à 48 kHz
            let acc = 0;
            for (let j = i; j < i + 1920; j++) { const s = s16[j] / 32768; acc += s * s; }
            env.push(Math.sqrt(acc / 1920));
          }
          const delay = await page.evaluate((b, first) => window.__amadeus.play(b, first), pcm.toString('base64'), !t0);
          if (!t0) {
            t0 = Date.now() + Math.round((delay || 0.06) * 1000);   // la bouche suit le son
            if (timing.end && timing.say) {
              const f = (t) => ((t - timing.end) / 1000).toFixed(1);
              log(`délais depuis la fin de la phrase : texte reconnu ${f(timing.stt)} s, 1re phrase du cerveau ${f(timing.say)} s, 1er son ${f(t0)} s`);
              timing.end = 0; timing.say = 0;
            }
          }
        }
        if (v.done && !v.chunks.length) break;
      }
      if (v.error && my === turn) log('voix :', v.error.message);
      // attendre la fin de la lecture dans la page
      while (my === turn) {
        const left = await page.evaluate(() => window.__amadeus.remaining()).catch(() => 0);
        if (left < 0.05) break;
        await sleep(Math.min(200, left * 1000));
      }
      clearInterval(mouth);
      hubSend({ type: 'mouth', v: 0 });
    }
  } finally {
    pumping = false;
    current = null;
    if (!queue.length) {
      setSpeaking(false);
      clearSubtitle();
      if (follow.userId) follow.until = Date.now() + settings.follow_seconds * 1000;
      if (!state.thinking) setTimeout(flushDeferred, 0);
    }
    if (queue.length && my !== turn) pump();
    sendStatus();
  }
}

// ------------------------------------------------------------ réglages et ordres

function onSettings(s) {
  const before = settings;
  settings = s;
  page?.evaluate((v) => { if (window.__amadeus) window.__amadeus.endSilence = v; }, s.end_silence_s).catch(() => {});
  if (before && (before.guild_id !== s.guild_id || before.voice_channel_id !== s.voice_channel_id) && wantVoice) {
    leaveVoice().catch(() => {});      // la boucle d'entretien rejoindra le nouveau salon
  }
}

async function onCommand(m) {
  if (m.action === 'join') wantVoice = true;
  else if (m.action === 'leave') { wantVoice = false; await leaveVoice(); }
  else if (m.action === 'stop') interrupt();
  else if (m.action === 'say' && m.text) {
    if (busy()) interrupt();
    await reply(settings.owner_id || 'owner', settings.owner_name || 'Moi', m.text).catch(replyFailed);
  }
}

// ------------------------------------------------------------ démarrage

async function main() {
  if (!TOKEN) { log('DISCORD_USER_TOKEN manquant dans discord-bot/.env'); process.exit(1); }
  connectHub();
  for (let i = 0; i < 50 && !settings; i++) await sleep(200);
  await new Promise((res) => { client.once('ready', res); client.login(TOKEN); });
  log(`Compte : ${client.user.globalName || client.user.username} (pseudos, salons, modération)`);
  await launch();
  log('Discord ouvert et connecté.');
  wantVoice = !!settings?.auto_join;
  keepAlive();
  sendStatus();
}

process.on('unhandledRejection', (e) => log('erreur :', e?.message || e));
main().catch((e) => { log('Arrêt :', e.message); process.exit(1); });
