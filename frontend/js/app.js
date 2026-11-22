/* Amadeus — démarrage, dialogue (SSE), voix en streaming, mains libres, mémoire, avatar. */
import { avatar } from './avatar.js?v=27';
import { AudioSys, TtsStream, Recorder, HandsFree } from './audio.js?v=27';
import { portrait } from './portrait.js?v=1';
import { screenBg } from './screenbg.js?v=5';

const $ = (sel) => document.querySelector(sel);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};

const SESSION = store.get('amadeus_sid') || crypto.randomUUID();
store.set('amadeus_sid', SESSION);

const WIDE = window.matchMedia('(min-width: 1100px)');
let busy = false;          /* une réponse est en cours d'écriture */
let chatAbort = null;      /* pour couper une réponse en cours (nouvelle question) */

/* ═══════════ Petits utilitaires ═══════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(msg, ms = 6000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* l'émotion va à la fois au modèle 3D et au portrait 2D */
function setEmotion(emotion) {
  avatar.setEmotion(emotion);
  portrait.setEmotion(emotion);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* Logo : image fournie par l'utilisateur (frontend/vendor/brand/amadeus-logo.png).
   Absente → le nom en texte, dans le même style. */
function setupLogos() {
  for (const img of document.querySelectorAll('.boot-logo, .top-logo')) {
    const swap = () => {
      const t = document.createElement('span');
      t.className = img.className + ' text-logo';
      t.textContent = 'AMADEUS';
      img.replaceWith(t);
    };
    if (img.complete && !img.naturalWidth) swap();
    else img.addEventListener('error', swap, { once: true });
  }
}

/* ═══════════ Conversation (tiroir) ═══════════ */

function addLine(role, text = '') {
  const li = document.createElement('li');
  li.className = `line ${role}`;
  li.textContent = text;
  const chat = $('#chat');
  chat.appendChild(li);
  chat.scrollTop = chat.scrollHeight;
  return li;
}

function setTranscript(open) {
  $('#transcript').hidden = !open;
  document.body.classList.toggle('with-transcript', open);
  $('#btn-transcript').setAttribute('aria-pressed', String(open));
  if (open) $('#chat').scrollTop = $('#chat').scrollHeight;
}

/* ═══════════ Sous-titres ═══════════ */

const subtitle = {
  el: $('#subtitle'),
  main: $('#subtitle .sub-main'),
  ja: $('#subtitle .sub-ja'),
  _hideTimer: 0,

  show(main, ja = '') {
    clearTimeout(this._hideTimer);
    this.main.classList.remove('thinking');
    this.main.textContent = main;
    /* la ligne japonaise n'apparaît que si la principale n'est pas déjà en japonais */
    this.ja.textContent = ja && ja !== main && !/[぀-ヿ]/.test(main) ? ja : '';
    this.el.classList.remove('idle');
  },
  thinking() {
    this.show('…');
    this.main.classList.add('thinking');
  },
  hide(delay = 900) {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.el.classList.add('idle'), delay);
  },
};
subtitle.el.classList.add('idle');

/* ═══════════ Trace de voix ═══════════
   Une ligne : sa voix en ambre, la tienne en blanc, plate au repos. */

function makeTrace(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0;
  const fit = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  if (window.ResizeObserver) new ResizeObserver(fit).observe(canvas);

  return {
    /* wave : Uint8Array (128 = silence) ou null ; progress : 0..1 (longueur tracée) */
    draw(wave, color, progress = 1) {
      ctx.clearRect(0, 0, w, h);
      const mid = h / 2;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, 'transparent');
      grad.addColorStop(0.12, color);
      grad.addColorStop(0.88, color);
      grad.addColorStop(1, 'transparent');
      ctx.strokeStyle = grad;
      ctx.lineWidth = wave ? 1.6 : 1;
      ctx.beginPath();
      if (!wave) {
        ctx.moveTo(0, mid); ctx.lineTo(w * progress, mid);
      } else {
        const n = 160;
        const step = Math.max(1, Math.floor(wave.length / n));
        for (let i = 0; i <= n; i++) {
          const x = (i / n) * w;
          const v = (wave[Math.min(i * step, wave.length - 1)] - 128) / 128;
          const env = Math.sin((i / n) * Math.PI);  /* amplitude max au centre */
          const y = mid + v * env * mid * 2.2;
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
      }
      ctx.stroke();
    },
  };
}

const voiceTrace = makeTrace($('#voice-trace'));
let colors = {};
const readColors = () => { colors = { voice: cssVar('--amber'), mine: cssVar('--text'), rest: cssVar('--line') }; };
readColors();

let traceWasActive = true;
function traceLoop() {
  requestAnimationFrame(traceLoop);
  const mine = Recorder.waveform() || HandsFree.waveform();
  const her = mine ? null : AudioSys.waveform();
  const active = !!(mine || her);
  HandsFree.setStrict(AudioSys.playing);  /* plus dur de lui couper la parole sur son propre écho */
  if (!active && !traceWasActive) return;
  voiceTrace.draw(mine || her, mine ? colors.mine : her ? colors.voice : colors.rest);
  traceWasActive = active;
}

/* ═══════════ Voix : file de phrases ═══════════
   Chaque phrase japonaise part en synthèse dès qu'elle arrive du LLM ; l'audio
   est joué en streaming, phrase après phrase, sans trou. Le sous-titre et
   l'expression de l'avatar suivent la phrase réellement entendue. */

const speech = {
  items: [],          /* {key, ja, fr, emotion, stream} */
  recentJa: [],       /* dernières phrases dites (détection d'écho) */
  playing: false,
  current: null,
  gen: 0,

  enqueue(key, ja, emotion = 'neutral', fr = '') {
    if (!ja) return;
    this.items.push({ key, ja, fr, emotion, stream: new TtsStream(ja, emotion) });
    this._pump();
  },

  /* la traduction d'une phrase arrive après sa voix : on complète le sous-titre */
  setFr(key, fr) {
    const it = this.items.find((x) => x.key === key) || (this.current?.key === key ? this.current : null);
    if (!it) return;
    it.fr = fr;
    if (it === this.current) subtitle.show(fr || it.ja, fr ? it.ja : '');
  },

  get active() { return this.playing || this.items.length > 0; },

  /* Coupe la parole (nouvelle question, tu parles par-dessus) */
  interrupt(reason = "") {
    if (this.active && reason) AudioSys.diag("interruption", { cause: reason, phrase: this.current?.ja || "" });
    this.gen++;
    for (const it of this.items) it.stream.cancel();
    this.current?.stream.cancel();
    this.items = [];
    AudioSys.stop();
  },

  async _pump() {
    if (this.playing) return;
    this.playing = true;
    const gen = this.gen;
    try {
      while (this.items.length && gen === this.gen) {
        const it = this.items.shift();
        this.current = it;
        this.recentJa = [...this.recentJa.slice(-3), it.ja];
        const ok = await AudioSys.play(it.stream, () => {
          if (gen !== this.gen) return;
          subtitle.show(it.fr || it.ja, it.fr ? it.ja : '');
          setEmotion(it.emotion);
        });
        if (!ok && gen === this.gen && it.stream.error) {
          /* pas de voix pour cette phrase : on laisse le temps de lire */
          subtitle.show(it.fr || it.ja, it.fr ? it.ja : '');
          await sleep(Math.max(1500, (it.fr || it.ja).length * 55));
        }
      }
    } finally {
      this.current = null;
      this.playing = false;
      /* des phrases d'une NOUVELLE réponse ont pu arriver pendant l'interruption :
         interrupt() vide la file, donc tout ce qui s'y trouve est à jouer */
      if (this.items.length) this._pump();
      else if (!busy) subtitle.hide();
    }
  },
};

/* ═══════════ Dialogue (SSE) ═══════════ */

function setBusy(b) {
  busy = b;
  $('#btn-send').disabled = b;
}

function* sseEvents(chunk, state) {
  state.buf += chunk;
  const parts = state.buf.split('\n\n');
  state.buf = parts.pop();
  for (const raw of parts) {
    let ev = 'message', data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event: ')) ev = line.slice(7).trim();
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (data) yield [ev, JSON.parse(data)];
  }
}

let turnSeq = 0;

async function sendMessage(text, { lineEl = null } = {}) {
  text = text.trim();
  if (!text) return;
  /* une nouvelle question coupe la réponse et la voix en cours */
  chatAbort?.abort();
  speech.interrupt("nouvelle question");
  divergence.maybeShift();
  const abort = new AbortController();
  chatAbort = abort;
  const turn = ++turnSeq;
  setBusy(true);
  if (!lineEl) addLine('user', text);
  $('#msg-input').value = '';
  subtitle.thinking();

  const li = addLine('kurisu');
  const txt = document.createTextNode('');
  const caret = document.createElement('span');
  caret.className = 'caret';
  li.append(txt, caret);
  let streamed = '';
  let final = null;

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, session_id: SESSION }),
      signal: abort.signal,
    });
    if (!resp.ok || !resp.body) throw new Error(`le serveur a répondu ${resp.status}`);

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    const state = { buf: '' };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const [ev, d] of sseEvents(dec.decode(value, { stream: true }), state)) {
        if (ev === 'meta') {
          setEmotion(d.emotion);
        } else if (ev === 'say') {
          speech.enqueue(`${turn}:${d.i}`, d.ja, d.emotion);
        } else if (ev === 'line') {
          speech.setFr(`${turn}:${d.i}`, d.fr);
        } else if (ev === 'token') {
          streamed += d.t;
          txt.textContent = streamed;
          $('#chat').scrollTop = $('#chat').scrollHeight;
        } else if (ev === 'done') {
          final = d;
        } else if (ev === 'error') {
          throw new Error(d.message);
        }
      }
    }
    if (!final) throw new Error('réponse interrompue');
    li.textContent = final.reply || streamed;
  } catch (e) {
    caret.remove();
    if (e.name === 'AbortError') {
      /* coupée par une nouvelle question : on garde ce qui a été dit */
      if (!streamed) li.remove();
      return;
    }
    if (!streamed) li.remove();
    addLine('error', explainError(e.message));
    subtitle.hide(0);
  } finally {
    if (chatAbort === abort) {
      chatAbort = null;
      setBusy(false);
      if (!speech.active) subtitle.hide();
    }
  }
}

function explainError(msg) {
  const key = msg.match(/(LLM|GROQ)_API_KEY/);
  if (key) return `Kurisu ne peut pas répondre : ajoute ta clé ${key[0]} dans backend\\.env (ou relance install.bat), puis relance Amadeus.`;
  if (/401|invalid.*key|authentication/i.test(msg)) return 'La clé API est refusée. Vérifie-la dans backend\\.env (ou relance install.bat).';
  if (/429|余额|insufficient/i.test(msg)) return 'L\'API refuse la requête (quota ou solde épuisé). Vérifie ton compte, ou change de cerveau dans Réglages.';
  if (/Failed to fetch|NetworkError/i.test(msg)) return 'Le serveur Amadeus ne répond pas. Relance start_amadeus.bat.';
  return `Kurisu n'a pas pu répondre : ${msg}`;
}

/* ═══════════ Ta voix → texte ═══════════ */

/* phrases que Whisper invente sur du bruit ou du silence */
const STT_HALLUCINATION = /ご視聴|チャンネル登録|字幕|sous-titr|merci d'avoir regard|thanks for watching|amara\.org/i;
const normSpeech = (s) => s.toLowerCase().replace(/[\s.,!?…。、！？「」『』・~〜ー'"-]/g, '');

/* Le micro n'a-t-il capté que l'écho de la voix de Kurisu ? (≥ 60 % des paires de
   caractères transcrites se retrouvent dans ce qu'elle vient de dire) */
function isEcho(text) {
  const t = normSpeech(text);
  const said = speech.recentJa.map(normSpeech).join('|');
  if (t.length < 2 || !said) return false;
  let hit = 0;
  for (let i = 0; i < t.length - 1; i++) if (said.includes(t.slice(i, i + 2))) hit++;
  return hit / (t.length - 1) >= 0.6;
}

/* bargeIn : tu as parlé pendant qu'elle parlait. Elle a seulement baissé la voix ;
   on ne la coupe que si ta phrase est réelle (ni bruit, ni son propre écho). */
async function transcribeAndSend(blob, { quiet = false, bargeIn = false } = {}) {
  let li = null;
  if (!bargeIn) {
    li = addLine('user', '…');
    li.classList.add('pending');
  }
  try {
    const fd = new FormData();
    fd.append('audio', blob, blob.type.includes('wav') ? 'speech.wav' : 'speech.webm');
    const r = await fetch('/api/stt', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`STT ${r.status}`);
    const text = ((await r.json()).text || '').trim();
    let reject = '';
    if (text.replace(/[\s.,!?…。、]/g, '').length < 2) reject = 'rien de compréhensible';
    else if (quiet && STT_HALLUCINATION.test(text)) reject = 'bruit';
    else if (bargeIn && isEcho(text)) reject = 'écho de sa voix';
    if (reject) {
      li?.remove();
      if (bargeIn) {
        AudioSys.diag('faux départ ignoré', { cause: reject, texte: text });
        AudioSys.duck(false);
      } else if (!quiet) toast("Je n'ai rien entendu. Réessaie en parlant un peu plus fort.");
      return;
    }
    if (li) {
      li.textContent = text;
      li.classList.remove('pending');
    } else li = addLine('user', text);
    sendMessage(text, { lineEl: li });
  } catch (err) {
    li?.remove();
    if (bargeIn) AudioSys.duck(false);
    toast('Transcription impossible : ' + err.message);
  }
}

/* ═══════════ Micro : mains libres ou maintenir pour parler ═══════════ */

const micBtn = $('#btn-mic');
const input = $('#msg-input');

function micUi(state) {
  /* off : maintenir pour parler · listen : mains libres, à l'écoute · talk : tu parles */
  micBtn.classList.toggle('listening', state === 'listen');
  micBtn.classList.toggle('rec', state === 'talk');
  micBtn.setAttribute('aria-pressed', String(state !== 'off'));
  micBtn.setAttribute('aria-label', state === 'off'
    ? 'Maintenir pour parler (clic : activer les mains libres)'
    : 'Mains libres actif : clique pour couper le micro');
  input.placeholder = state === 'off'
    ? 'Écris à Kurisu, ou maintiens Espace pour parler'
    : 'Parle quand tu veux, ou écris ici';
}

async function setHandsFree(on, { silent = false } = {}) {
  try {
    if (on) {
      await HandsFree.enable();
      micUi('listen');
      if (!silent) toast('Mains libres : parle quand tu veux. Tu peux lui couper la parole.');
    } else {
      await HandsFree.disable();
      micUi('off');
      if (!silent) toast('Mains libres coupé : maintiens le micro ou Espace pour parler.');
    }
    store.set('amadeus_handsfree', on ? '1' : '0');
  } catch (err) {
    micUi('off');
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      toast('Le micro est bloqué. Autorise-le pour 127.0.0.1 dans Chrome ou Edge.', 10000);
    } else {
      toast('Mains libres indisponible : ' + (err?.message || name) + '. Maintiens le micro pour parler.', 9000);
    }
  }
}

let bargeIn = false;

function setupMic() {
  HandsFree.handlers = {
    onStart: () => {
      micUi('talk');
      /* elle parle (ou va répondre) : elle baisse la voix et t'écoute. Elle ne se tait
         pour de bon qu'une fois ta phrase transcrite : un bruit, une toux ou l'écho de
         sa propre voix ne lui coupent plus la parole. */
      bargeIn = speech.active || busy;
      if (bargeIn) AudioSys.duck(true);
    },
    onEnd: (audio) => {
      micUi('listen');
      const b = bargeIn;
      bargeIn = false;
      transcribeAndSend(HandsFree.toWav(audio), { quiet: true, bargeIn: b });
    },
    onMisfire: () => {
      micUi('listen');
      if (bargeIn) {
        bargeIn = false;
        AudioSys.duck(false);
        AudioSys.diag('faux départ ignoré', { cause: 'son trop court' });
      }
    },
  };

  /* maintenir pour parler (quand les mains libres sont coupées) */
  let pressing = false, starting = false, downAt = 0;

  const down = async (e) => {
    e.preventDefault();
    downAt = performance.now();
    if (HandsFree.on || e.repeat || Recorder.active || starting) return;
    starting = true;
    pressing = true;
    speech.interrupt("appui micro");
    subtitle.hide(0);
    try {
      await Recorder.start();
      if (!pressing) { await Recorder.stop(); return; }
      micUi('talk');
    } catch (err) {
      pressing = false;
      const name = err?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        toast('Le micro est bloqué. Autorise-le pour 127.0.0.1 dans Chrome ou Edge.', 10000);
      } else if (name === 'NotFoundError') {
        toast('Aucun micro détecté sur cet ordinateur.');
      } else {
        toast('Micro indisponible : ' + (err?.message || name));
      }
    } finally {
      starting = false;
    }
  };

  const up = async (e) => {
    if (!pressing) return;
    e?.preventDefault();
    pressing = false;
    micUi('off');
    const blob = await Recorder.stop();
    if (blob) transcribeAndSend(blob);
  };

  micBtn.addEventListener('pointerdown', down);
  micBtn.addEventListener('pointerup', up);
  micBtn.addEventListener('pointercancel', up);
  window.addEventListener('pointerup', up);
  /* clic bref sur le micro : bascule les mains libres */
  micBtn.addEventListener('click', () => {
    if (performance.now() - downAt < 300) setHandsFree(!HandsFree.on);
  });

  /* Espace : maintenir pour parler, sauf en train d'écrire */
  const spaceTalks = (t) => t === document.body || t?.id === 'scene' || (t?.id === 'msg-input' && !t.value);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !HandsFree.on && spaceTalks(e.target) && $('#memory').hidden) { e.preventDefault(); down(e); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') up(e); });
}

/* ═══════════ Avatar ═══════════ */

async function importVrm(file) {
  if (!file.name.toLowerCase().endsWith('.vrm')) {
    toast('Il faut un fichier .vrm (export VRoid Studio, par exemple).');
    return;
  }
  try {
    await avatar.loadFromBuffer(await file.arrayBuffer(), file.name);
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch('/api/avatar', { method: 'POST', body: fd });
    toast(r.ok ? `Avatar remplacé par ${file.name}.` : `Avatar affiché, mais pas enregistré (erreur ${r.status}).`);
  } catch (err) {
    toast(`Ce fichier n'est pas un VRM valide : ${err.message}`);
  }
}

const EMO_FR = { neutral: 'neutre', joy: 'joie', angry: 'colère', sad: 'triste', shy: 'gênée', surprised: 'surprise' };

async function importSprites(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  let res;
  try {
    const r = await fetch('/api/sprites', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`erreur ${r.status}`);
    res = await r.json();
  } catch (err) {
    toast('Images non enregistrées : ' + err.message);
    return;
  }
  await portrait.load();
  const names = res.saved.map((k) => (EMO_FR[k.replace('_talk', '')] || k) + (k.endsWith('_talk') ? ' (parle)' : ''));
  let msg = res.saved.length ? `Images 2D : ${names.join(', ')}.` : 'Aucune image reconnue.';
  if (res.ignored.length) msg += ` Ignorées (nom inconnu) : ${res.ignored.join(', ')}. Noms attendus : neutre, joie, colere, triste, gene, surprise (+ _parle).`;
  if (res.saved.length && !portrait.sprites.neutral) msg += " Ajoute aussi « neutre » : c'est l'image de repos.";
  toast(msg, 10000);
  if (res.saved.length && !want2d) {
    const opt = $('#opt-2d');
    if (opt.getAttribute('aria-checked') !== 'true') opt.click();   /* active le mode 2D */
  } else apply2d();
}

function setupAvatar() {
  const menu = $('#avatar-menu');
  const btn = $('#btn-avatar');
  const setOpen = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };

  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  window.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setOpen(false); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  $('#avatar-import').addEventListener('click', () => { setOpen(false); $('#avatar-file').click(); });
  $('#avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) await importVrm(file);
  });
  $('#avatar-reset').addEventListener('click', async () => {
    setOpen(false);
    try {
      await fetch('/api/avatar', { method: 'DELETE' });
      const r = await fetch('/vendor/models/kurisu.vrm?v=2');
      if (!r.ok) throw new Error('modèle kurisu.vrm introuvable');
      await avatar.loadFromBuffer(await r.arrayBuffer(), 'kurisu.vrm');
      toast('Kurisu est de retour.');
    } catch (err) {
      toast('Impossible de recharger Kurisu : ' + err.message);
    }
  });

  /* images 2D */
  $('#sprites-import').addEventListener('click', () => { setOpen(false); $('#sprites-file').click(); });
  $('#sprites-file').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await importSprites(files);
  });
  $('#sprites-clear').addEventListener('click', async () => {
    setOpen(false);
    const r = await fetch('/api/sprites', { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) { toast('Impossible de retirer les images : le serveur ne répond pas.'); return; }
    await portrait.load();
    apply2d();
    toast('Images 2D retirées. En mode 2D, le modèle 3D est affiché à plat.');
  });

  /* glisser-déposer */
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    const all = [...e.dataTransfer.files];
    const file = all.find((f) => f.name.toLowerCase().endsWith('.vrm'));
    if (file) await importVrm(file);
    const images = all.filter((f) => f.type.startsWith('image/'));
    if (images.length) await importSprites(images);
  });
}

/* ═══════════ Mémoire ═══════════ */

function setupMemory() {
  const drawer = $('#memory');
  const ta = $('#memory-profile');
  const saveBtn = $('#btn-memory-save');
  const count = (n) => `${n} échange${n > 1 ? 's' : ''} mémorisé${n > 1 ? 's' : ''}`;

  const setOpen = (open) => {
    drawer.hidden = !open;
    $('#scrim').hidden = !open;
    if (open) ta.focus(); else $('#btn-memory').focus();
  };

  $('#btn-memory').addEventListener('click', async () => {
    setOpen(true);
    $('#memory-count').textContent = 'Chargement…';
    try {
      const s = await (await fetch('/api/memory')).json();
      $('#memory-count').textContent = count(s.exchanges);
      ta.value = s.profile || '';
    } catch {
      $('#memory-count').textContent = 'Impossible de lire la mémoire : le serveur ne répond pas.';
    }
  });
  $('#scrim').addEventListener('click', () => setOpen(false));
  drawer.querySelector('[data-close]').addEventListener('click', () => setOpen(false));
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !drawer.hidden) setOpen(false); });

  saveBtn.addEventListener('click', async () => {
    const value = ta.value.trim();
    if (!value) {
      toast('Le texte est vide. Pour repartir de zéro, utilise « Tout effacer ».');
      return;
    }
    saveBtn.disabled = true;
    try {
      const r = await fetch('/api/memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: value }),
      });
      if (!r.ok) throw new Error(`erreur ${r.status}`);
      toast('Mémoire enregistrée. Kurisu en tiendra compte dès ta prochaine phrase.');
    } catch (e) {
      toast('Mémoire non enregistrée : ' + e.message);
    } finally {
      saveBtn.disabled = false;
    }
  });

  $('#btn-memory-wipe').addEventListener('click', async () => {
    if (!confirm('Tout effacer ? Kurisu oubliera tout ce qu\'elle sait de toi. Impossible d\'annuler.')) return;
    const r = await fetch('/api/memory', { method: 'DELETE' }).catch(() => null);
    if (!r?.ok) { toast('Effacement impossible : le serveur ne répond pas.'); return; }
    ta.value = '';
    $('#memory-count').textContent = count(0);
    toast('Mémoire effacée.');
  });
}

/* ═══════════ État des services ═══════════ */

const dismissed = new Set();

async function checkHealth() {
  let h = null;
  try { h = await (await fetch('/api/health')).json(); } catch { /* serveur arrêté */ }
  const items = [];
  if (!h) {
    items.push(['server', 'Le serveur Amadeus ne répond pas. Relance <code>start_amadeus.bat</code>.']);
  } else {
    if (!h.llm.configured) {
      const key = h.llm.brain === 'gptoss' ? 'GROQ_API_KEY' : 'LLM_API_KEY';
      items.push(['llm', `Kurisu ne peut pas répondre : ajoute ta clé <code>${key}</code> dans <code>backend\\.env</code> (ou relance <code>install.bat</code>), puis relance Amadeus.`]);
    }
    if (!h.tts.gpt_sovits) items.push(['tts', 'Voix de secours active. Lance <code>tts-server\\start_tts.bat</code> pour entendre la vraie voix de Kurisu.']);
  }
  const box = $('#notices');
  box.replaceChildren(...items.filter(([id]) => !dismissed.has(id)).map(([id, html]) => {
    const div = document.createElement('div');
    div.className = 'notice';
    div.innerHTML = `<span style="flex:1">${html}</span>`;  /* textes statiques ci-dessus */
    const x = document.createElement('button');
    x.className = 'icon-btn';
    x.setAttribute('aria-label', 'Masquer');
    x.textContent = '✕';
    x.style.cssText = 'width:24px;height:24px;font-size:12px';
    x.onclick = () => { dismissed.add(id); div.remove(); };
    div.appendChild(x);
    return div;
  }));
  return h;
}

/* ═══════════ Fond : compteur de divergence ═══════════
   Des tubes nixie qui affichent la ligne d'univers courante. Quand elle bouge
   (nouvelle question, ou de temps en temps), tous les chiffres défilent puis se
   fixent de gauche à droite, et l'ancienne valeur passe dans l'historique. */

const divergence = (() => {
  /* lignes d'univers marquantes de l'animé */
  const KNOWN = ['1.048596', '0.571024', '0.523299', '0.456903', '0.409431', '0.337187', '1.130205', '0.334581'];
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let value = '1.048596';
  let history = [];
  let tubes = [];
  let rolling = false;
  let idleTimer = 0;

  const fmt = (x) => x.toFixed(6);
  function next() {
    if (Math.random() < 0.3) {
      const pick = KNOWN.filter((v) => v !== value);
      return pick[Math.floor(Math.random() * pick.length)];
    }
    /* petite dérive dans le même champ attracteur */
    const v = parseFloat(value);
    const drift = (Math.random() - 0.5) * (Math.random() < 0.7 ? 0.0004 : 0.02);
    return fmt(Math.min(1.999999, Math.max(0, v + drift)));
  }

  /* Chiffres en fil (cathodes) dessinés à la main, viewBox 40×70, trait fin comme un
     filament. Toutes les cathodes sont empilées dans le tube : les éteintes restent
     visibles en sombre derrière celle qui brille. */
  const CATHODES = {
    0: 'M20 8C30 8 33 20 33 35S30 62 20 62 7 50 7 35 10 8 20 8Z',
    1: 'M14 15 20 8V62',
    2: 'M8 18C9 11 14 8 20 8 28 8 32 13 32 19 32 29 23 36 8 62H33',
    3: 'M8 8H32L19 30C28 30 33 36 33 45 33 55 27 62 20 62 13 62 9 58 7 54',
    4: 'M27 62V8L6 46H34',
    5: 'M32 8H11L9 32C12 29 16 28 20 28 28 28 33 35 33 45 33 55 27 62 20 62 13 62 9 58 7 54',
    6: 'M30 10C27 8.6 24 8 20 8 11 8 7 20 7 40 7 54 12 62 20 62 28 62 33 56 33 46 33 36 28 31 20 31 13 31 8 35 7 41',
    7: 'M7 8H33L15 62',
    8: 'M20 34C12 34 9 29 9 21 9 13 14 8 20 8S31 13 31 21 28 34 20 34 7 40 7 48 12 62 20 62 33 57 33 48 28 34 20 34Z',
    9: 'M33 29C31 35 26 39 20 39 12 39 7 34 7 24 7 14 12 8 20 8 29 8 33 16 33 30 33 50 29 62 20 62 16 62 13 61 10 59',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ORDER = ['1', '7', '4', '9', '0', '6', '2', '3', '5', '8'];   /* empilement (arrière → avant) */

  function makeTube() {
    const tube = document.createElement('span');
    tube.className = 'dm-tube';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 40 70');
    svg.setAttribute('class', 'dm-cathodes');
    const paths = {};
    for (const d of ORDER) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', CATHODES[d]);
      p.setAttribute('class', 'cath');
      svg.appendChild(p);
      paths[d] = p;
    }
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', '6'); dot.setAttribute('cy', '62'); dot.setAttribute('r', '2.2');
    dot.setAttribute('class', 'cath dp');
    svg.appendChild(dot);
    paths['.'] = dot;
    /* le chiffre allumé : une copie au premier plan, avec halo */
    const lit = document.createElementNS(SVG_NS, 'path');
    lit.setAttribute('class', 'lit');
    lit.setAttribute('filter', 'url(#nixie-glow)');
    svg.appendChild(lit);
    tube.append(svg);
    tube._paths = paths;
    tube._lit = lit;
    return tube;
  }

  function setDigit(tube, ch) {
    const lit = tube._lit;
    const dp = ch === '.';
    lit.setAttribute('d', dp ? 'M3.8 62a2.2 2.2 0 1 0 4.4 0a2.2 2.2 0 1 0 -4.4 0Z' : (CATHODES[ch] || ''));
    lit.classList.toggle('dp', dp);
    /* la cathode allumée est retirée de la pile sombre (sinon elle double le trait) */
    for (const [k, p] of Object.entries(tube._paths)) p.classList.toggle('on', k === ch);
  }

  function build() {
    const box = $('#divergence .dm-tubes');
    if (tubes.length !== value.length) {
      tubes = [...value].map(() => makeTube());
      box.replaceChildren(...tubes);
    }
    [...value].forEach((ch, i) => setDigit(tubes[i], ch));
  }

  function renderHistory() {
    $('#divergence .dm-history').replaceChildren(...history.map((v) => {
      const li = document.createElement('li');
      li.textContent = v;
      return li;
    }));
  }

  function shift(to = next()) {
    if (rolling || to === value || document.body.classList.contains('no-divergence')) return;
    history = [value, ...history].slice(0, 3);
    value = to;
    renderHistory();
    if (reduced) { build(); return; }
    rolling = true;
    const start = performance.now();
    const timer = setInterval(() => {
      const el = performance.now() - start;
      let done = true;
      [...value].forEach((ch, i) => {
        if (ch === '.') { setDigit(tubes[i], ch); return; }
        const settled = el > 700 + i * 110;
        tubes[i].classList.toggle('rolling', !settled);
        setDigit(tubes[i], settled ? ch : String(Math.floor(Math.random() * 10)));
        if (!settled) done = false;
      });
      if (done) { clearInterval(timer); rolling = false; }
    }, 55);
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { shift(); scheduleIdle(); }, 60000 + Math.random() * 90000);
  }

  return {
    init() { build(); renderHistory(); scheduleIdle(); },
    shift,
    /* une question sur deux fait bouger la ligne (sinon ça clignote sans arrêt) */
    maybeShift() { if (Math.random() < 0.5) shift(); },
  };
})();

/* ═══════════ Cerveau : principal ou rapide (choix enregistré côté serveur) ═══════════ */

async function setupBrain() {
  const box = $('#brain-options');
  let info = null;
  const render = () => {
    box.replaceChildren(...info.options.map((o) => {
      const b = document.createElement('button');
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(o.id === info.current));
      b.disabled = !o.configured;
      const label = document.createElement('span');
      label.textContent = o.label;
      const small = document.createElement('small');
      small.textContent = o.configured ? o.detail : 'Clé API manquante dans backend\\.env';
      label.appendChild(small);
      const dot = document.createElement('i');
      dot.className = 'radio';
      b.append(label, dot);
      b.addEventListener('click', async () => {
        if (o.id === info.current) return;
        try {
          const r = await fetch('/api/brain', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brain: o.id }),
          });
          if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `erreur ${r.status}`);
          info = await r.json();
          render();
          toast(`Cerveau : ${o.label}. Effet dès ta prochaine phrase.`);
        } catch (err) {
          toast('Changement de cerveau impossible : ' + err.message);
        }
      });
      return b;
    }));
  };
  try {
    info = await (await fetch('/api/brain')).json();
    render();
  } catch {
    box.textContent = '';
  }
}

/* ═══════════ Affichage : vue 2D/3D, fond, compteur ═══════════ */

/* 2D : les images de l'utilisateur s'il en a importé, sinon le modèle 3D vu à plat */
let want2d = false;
function apply2d(on = want2d) {
  want2d = on;
  const sprites = portrait.setActive(on);
  avatar.setView(on && !sprites ? '2d' : '3d');
  avatar.paused = sprites;
  document.body.classList.toggle('view-2d', on);
  document.body.classList.toggle('portrait-on', sprites);
}

function setupOptions() {
  const menu = $('#options-menu');
  const btn = $('#btn-options');
  const setOpen = (open) => { menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  window.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) setOpen(false); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  const opts = {
    '#opt-2d': {
      key: 'amadeus_view2d', def: false,
      apply(on) { apply2d(on); },
    },
    '#opt-screen': {
      key: 'amadeus_screenbg', def: false,
      apply(on) { screenBg.setActive(on); },
    },
    '#opt-divergence': {
      key: 'amadeus_divergence', def: true,
      apply(on) { document.body.classList.toggle('no-divergence', !on); },
    },
  };
  for (const [sel, o] of Object.entries(opts)) {
    const el = $(sel);
    const saved = store.get(o.key);
    const set = (on, save) => {
      el.setAttribute('aria-checked', String(on));
      o.apply(on);
      if (save) store.set(o.key, on ? '1' : '0');
    };
    set(saved == null ? o.def : saved === '1', false);
    el.addEventListener('click', () => set(el.getAttribute('aria-checked') !== 'true', true));
  }
}


/* ═══════════ Démarrage ═══════════ */

async function boot() {
  const bootTrace = makeTrace($('#boot-trace'));
  const status = $('#boot-status');
  let progress = 0;
  const step = (p, label) => {
    progress = Math.max(progress, p);
    bootTrace.draw(null, cssVar('--amber'), progress);
    if (label) status.textContent = label;
  };

  setupLogos();
  divergence.init();
  avatar.init($('#scene'));
  portrait.init($('#portrait'));
  portrait.lipSource = () => AudioSys.updateLips();
  screenBg.init($('#screen-bg'));
  await portrait.load();
  setupOptions();
  setupBrain();
  avatar.lipSource = () => AudioSys.updateLips();
  setupMic();
  micUi('off');
  setupAvatar();
  setupMemory();

  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage(input.value); });
  $('#btn-transcript').addEventListener('click', () => {
    const open = $('#transcript').hidden;
    setTranscript(open);
    store.set('amadeus_transcript', open ? '1' : '0');
  });
  $('#transcript [data-close]').addEventListener('click', () => { setTranscript(false); store.set('amadeus_transcript', '0'); });
  setTranscript(WIDE.matches && store.get('amadeus_transcript') !== '0');

  step(0.1, 'Vérification des systèmes…');
  /* tout en parallèle : santé, salutation (LLM) et avatar 3D (~15 Mo) */
  const health = checkHealth().then((h) => { step(0.35); return h; });
  const greeting = fetch('/api/boot?lang=fr').then((r) => r.json()).catch(() => null)
    .then((g) => { step(0.6, 'Souvenirs chargés.'); return g; });
  const model = avatar.loadDefault().catch((e) => console.warn('Avatar :', e))
    .then(() => step(0.85, 'Kurisu est presque là…'));
  status.textContent = 'Chargement des souvenirs et de l\'avatar…';

  const [, bootData] = await Promise.all([health, greeting, model]);
  /* salutation : une ou deux phrases, chacune avec sa voix et son émotion */
  const lines = bootData?.lines?.length ? bootData.lines
    : [{ ja: '接続を確認。Amadeus、起動完了。', fr: 'Connexion établie. Amadeus en ligne.', emotion: 'neutral' }];
  step(1, 'Amadeus est prête.');

  const btn = $('#btn-connect');
  btn.disabled = false;
  btn.focus();
  await new Promise((r) => btn.addEventListener('click', r, { once: true }));

  AudioSys.unlock();   /* le clic autorise la voix */
  $('#boot').classList.add('gone');
  setTimeout(() => divergence.shift(), 900);   /* connexion : la ligne bascule */
  setTimeout(() => $('#boot').remove(), 1000);
  requestAnimationFrame(traceLoop);
  setInterval(checkHealth, 30000);

  addLine('kurisu', bootData?.greeting || lines.map((l) => l.fr).join('\n'));
  setEmotion(bootData?.emotion || 'joy');
  lines.forEach((l, i) => speech.enqueue(`boot:${i}`, l.ja, l.emotion, l.fr));
  input.focus();

  /* mains libres activées par défaut (le clic de connexion autorise le micro) */
  if (store.get('amadeus_handsfree') !== '0') setHandsFree(true, { silent: true });
}

boot();

/* accès console pour le débogage : __amadeus.speech, __amadeus.HandsFree… */
window.__amadeus = { speech, AudioSys, HandsFree, avatar, TtsStream, divergence, portrait, screenBg };
