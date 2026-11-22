/* Audio — voix de Kurisu en streaming (Web Audio), lip-sync, micro.

   La voix arrive de /api/tts :
   - audio/wav : en-tête WAV puis PCM 16 bits au fil de la génération
     (GPT-SoVITS en streaming) → on joue chaque morceau dès qu'il arrive ;
   - autre (mp3 edge-tts) : fichier complet décodé d'un coup.
   Les morceaux sont programmés bout à bout sur l'horloge audio : pas de trou. */

const GAP_BETWEEN_SENTENCES = 0.12;   /* respiration naturelle entre deux phrases (s) */
const START_BUFFER = 0.8;             /* audio d'avance voulu avant de démarrer une phrase (s) */
const START_WAIT_MAX = 0.35;          /* attente maximale pour ce tampon (s) */
const UNDERRUN_PAD = 0.12;            /* marge de reprise après un retard (s) */
const DUCK_LEVEL = 0.18;              /* volume de Kurisu pendant que tu lui parles */
const LIP_MAX = 0.65;                 /* ouverture max d'un visème */
const LIP_TOTAL_MAX = 0.85;           /* ouverture max cumulée des visèmes */

const AudioSys = {
  ctx: null,
  out: null,          /* gain → analyser → haut-parleurs */
  analyser: null,
  _freq: null,
  _wave: null,
  _sources: new Set(),
  _nextTime: 0,
  _token: 0,          /* incrémenté à chaque interruption */
  lipBands: null,

  /* À appeler depuis un geste utilisateur : les navigateurs bloquent l'audio avant. */
  unlock() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.out = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.55;
      this.out.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this._freq = new Uint8Array(this.analyser.frequencyBinCount);
      this._wave = new Uint8Array(this.analyser.fftSize);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  get playing() { return this._sources.size > 0; },

  /* Journal des incidents de lecture (trous, interruptions), consultable via
     __amadeus.AudioSys.log dans la console ; recopié dans data/voice_diag.log */
  log: [],
  diag(kind, info = {}) {
    const e = { t: new Date().toLocaleTimeString(), kind, ...info };
    this.log.push(e);
    if (this.log.length > 200) this.log.shift();
    console.debug('[voix]', kind, info);
    fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e), keepalive: true }).catch(() => {});
  },

  /* Joue un flux TTS (TtsStream). onStart() est appelé quand le son démarre
     réellement. Résout juste avant la fin, pour enchaîner la phrase suivante sans trou. */
  async play(stream, onStart) {
    this.unlock();
    const ctx = this.ctx;
    const token = this._token;
    let started = false;
    /* Tampon de démarrage : GPT-SoVITS envoie parfois un 1er morceau court (~0,6 s)
       suivi d'une pause ; démarrer trop tôt crée un blanc au milieu de la phrase.
       On attend d'avoir START_BUFFER d'audio d'avance (au plus START_WAIT_MAX). */
    if (this._nextTime <= ctx.currentTime) await stream.buffered(START_BUFFER, START_WAIT_MAX);
    for await (const chunk of stream) {
      if (token !== this._token) return false;
      const buf = chunk instanceof AudioBuffer ? chunk : this._toBuffer(chunk, stream.sampleRate);
      if (!buf.length) continue;
      const gap = started ? 0 : GAP_BETWEEN_SENTENCES;
      /* morceau en retard (la lecture a rattrapé la génération) : on reprend avec
         un peu de marge plutôt que de hacher mot par mot */
      const late = started && this._nextTime < ctx.currentTime;
      const t = Math.max(this._nextTime + gap, ctx.currentTime + (late ? UNDERRUN_PAD : 0.03));
      if (late) this.diag('trou', { s: +(t - this._nextTime).toFixed(2), recu: +stream.seconds.toFixed(2), texte: stream.text });
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.out);
      src.onended = () => this._sources.delete(src);
      this._sources.add(src);
      src.start(t);
      this._nextTime = t + buf.duration;
      if (!started) {
        started = true;
        if (onStart) setTimeout(onStart, Math.max(0, (t - ctx.currentTime) * 1000));
      }
    }
    /* attend la fin (à 150 ms près) sauf interruption */
    while (token === this._token && this._nextTime - ctx.currentTime > 0.15) {
      await new Promise((r) => setTimeout(r, Math.min(100, (this._nextTime - ctx.currentTime - 0.15) * 1000)));
    }
    return started && token === this._token;
  },

  /* Baisse (on) ou rétablit (off) sa voix en douceur, sans rien couper. */
  duck(on) {
    if (!this.ctx) return;
    const g = this.out.gain, now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.setTargetAtTime(on ? DUCK_LEVEL : 1, now, on ? 0.05 : 0.15);
  },

  /* Coupe immédiatement tout ce qui est programmé. */
  stop() {
    if (this.ctx) {
      this.out.gain.cancelScheduledValues(this.ctx.currentTime);
      this.out.gain.setValueAtTime(1, this.ctx.currentTime);
    }
    this._token++;
    for (const s of this._sources) { try { s.stop(); } catch { /* déjà fini */ } }
    this._sources.clear();
    this._nextTime = 0;
  },

  _toBuffer(f32, sampleRate) {
    const buf = this.ctx.createBuffer(1, f32.length, sampleRate);
    buf.copyToChannel(f32, 0);
    return buf;
  },

  /* Appelée à chaque frame par la boucle de rendu de l'avatar. */
  updateLips() {
    if (!this.playing) { this.lipBands = null; return null; }
    const bins = this._freq;
    this.analyser.getByteFrequencyData(bins);
    const binHz = this.ctx.sampleRate / 2 / bins.length;
    const band = (lo, hi) => {
      const a = Math.max(0, Math.floor(lo / binHz));
      const b = Math.min(bins.length - 1, Math.ceil(hi / binHz));
      let s = 0;
      for (let i = a; i <= b; i++) s += bins[i];
      return s / ((b - a + 1) * 255);
    };
    /* F1 ≈ ouverture de bouche, F2 ≈ forme voyelle, aigus ≈ fricatives */
    const low = band(90, 700), mid = band(700, 1900), high = band(1900, 4600);
    const vol = Math.min(1, low * 1.35 + mid * 0.8 + high * 0.5);
    const raw = {
      aa: vol * (0.55 + low * 0.9),
      ih: vol * (0.2 + mid * 0.9),
      ee: vol * mid * 0.5,
      ou: vol * (0.1 + high * 0.8),
      oh: vol * low * 0.7,
    };
    /* plafonds : au-delà, la bouche du modèle traverse le menton */
    let sum = 0;
    for (const k in raw) { raw[k] = Math.min(raw[k], LIP_MAX); sum += raw[k]; }
    if (sum > LIP_TOTAL_MAX) for (const k in raw) raw[k] *= LIP_TOTAL_MAX / sum;
    this.lipBands = raw;
    return this.lipBands;
  },

  /* Forme d'onde courante de sa voix (Uint8Array, 128 = silence) ou null. */
  waveform() {
    if (!this.playing) return null;
    this.analyser.getByteTimeDomainData(this._wave);
    return this._wave;
  },
};

/* ------------------------------ Flux TTS ------------------------------
   Démarre la requête dès sa création et accumule l'audio décodé : la phrase
   suivante se télécharge pendant que la précédente est jouée. */

class TtsStream {
  constructor(text, emotion) {
    this.text = text;
    this.sampleRate = 32000;
    this.chunks = [];
    this.done = false;
    this.error = null;
    this._waiters = [];
    this._abort = new AbortController();
    this._run(text, emotion).catch((e) => { this.error = e; }).finally(() => { this.done = true; this._notify(); });
  }

  cancel() { this._abort.abort(); }

  /* durée d'audio déjà reçue (s) */
  get seconds() {
    let n = 0;
    for (const c of this.chunks) n += c instanceof AudioBuffer ? c.duration : c.length / this.sampleRate;
    return n;
  }

  /* attend d'avoir `sec` secondes d'audio (ou la fin du flux), au plus `maxWait` s
     après le 1er morceau */
  async buffered(sec, maxWait) {
    while (!this.chunks.length && !this.done) await new Promise((r) => { this._waiters.push(r); });
    const until = performance.now() + maxWait * 1000;
    while (!this.done && this.seconds < sec && performance.now() < until) {
      await new Promise((r) => {
        this._waiters.push(r);
        setTimeout(r, Math.max(0, until - performance.now()));
      });
    }
  }

  _notify() { const ws = this._waiters; this._waiters = []; for (const w of ws) w(); }

  _push(chunk) { this.chunks.push(chunk); this._notify(); }

  async _run(text, emotion) {
    const r = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, emotion }),
      signal: this._abort.signal,
    });
    if (!r.ok) throw new Error(`TTS ${r.status}`);
    const type = r.headers.get('content-type') || '';

    if (!type.includes('wav') || !r.body) {
      /* mp3 complet (voix de secours) */
      AudioSys.unlock();
      const data = await r.arrayBuffer();
      this._push(await AudioSys.ctx.decodeAudioData(data));
      return;
    }

    /* WAV en streaming : en-tête puis PCM 16 bits little-endian */
    const reader = r.body.getReader();
    let head = new Uint8Array(0);
    let dataStarted = false;
    let carry = null;  /* octet orphelin entre deux morceaux */
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let bytes = value;
      if (!dataStarted) {
        head = concat(head, bytes);
        const off = findWavData(head, (sr) => { this.sampleRate = sr; });
        if (off < 0) continue;
        dataStarted = true;
        bytes = head.subarray(off);
      }
      if (carry) { bytes = concat(carry, bytes); carry = null; }
      if (bytes.length % 2) { carry = bytes.slice(-1); bytes = bytes.subarray(0, bytes.length - 1); }
      if (!bytes.length) continue;
      const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
      const f32 = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
      this._push(f32);
    }
  }

  async *[Symbol.asyncIterator]() {
    let k = 0;
    for (;;) {
      while (k < this.chunks.length) yield this.chunks[k++];
      if (this.done) return;
      await new Promise((r) => { this._waiters.push(r); });
    }
  }
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* → index du début des données PCM, ou -1 si l'en-tête n'est pas encore complet */
function findWavData(h, onRate) {
  if (h.length < 12) return -1;
  const dv = new DataView(h.buffer, h.byteOffset, h.length);
  let p = 12;
  while (p + 8 <= h.length) {
    const id = String.fromCharCode(h[p], h[p + 1], h[p + 2], h[p + 3]);
    const size = dv.getUint32(p + 4, true);
    if (id === 'fmt ' && p + 16 <= h.length) onRate(dv.getUint32(p + 12, true));
    if (id === 'data') return p + 8 <= h.length ? p + 8 : -1;
    p += 8 + size + (size % 2);
  }
  return -1;
}

/* ------------------------- Micro : maintenir pour parler ------------------------- */

const Recorder = {
  media: null,
  chunks: [],
  active: false,
  _stream: null,
  _t0: 0,
  _analyser: null,
  _wave: null,
  _src: null,

  async start() {
    if (this.active) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    this.media = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.media.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.media.start(200);
    this.active = true;
    this._t0 = performance.now();
    this._stream = stream;

    AudioSys.unlock();
    const ctx = AudioSys.ctx;
    if (!this._analyser) {
      this._analyser = ctx.createAnalyser();
      this._analyser.fftSize = 1024;
      this._wave = new Uint8Array(this._analyser.fftSize);
    }
    this._src = ctx.createMediaStreamSource(stream);
    this._src.connect(this._analyser);
  },

  waveform() {
    if (!this.active || !this._analyser) return null;
    this._analyser.getByteTimeDomainData(this._wave);
    return this._wave;
  },

  /* → Blob audio, ou null si trop court */
  stop() {
    return new Promise((resolve) => {
      if (!this.active || !this.media) return resolve(null);
      const dur = performance.now() - this._t0;
      this.media.onstop = () => {
        this._stream.getTracks().forEach((t) => t.stop());
        try { this._src?.disconnect(); } catch { /* déjà déconnecté */ }
        this._src = null;
        this.active = false;
        if (dur < 350 || this.chunks.length === 0) return resolve(null);
        resolve(new Blob(this.chunks, { type: this.chunks[0].type }));
      };
      this.media.stop();
    });
  },
};

/* ------------------------- Mains libres : détection de la parole -------------------------
   Silero VAD (réseau de neurones) dans le navigateur : détecte quand tu commences
   et finis de parler. Pendant que Kurisu parle, il faut une voix plus nette et
   plus longue pour lui couper la parole (évite qu'elle s'interrompe sur son propre écho). */

const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/';

const CALM = { positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.4, minSpeechMs: 250 };
const WHILE_SHE_TALKS = { positiveSpeechThreshold: 0.85, negativeSpeechThreshold: 0.6, minSpeechMs: 450 };

const HandsFree = {
  vad: null,
  on: false,
  speaking: false,
  _wave: new Uint8Array(512),
  _hasWave: false,
  _strict: false,
  handlers: { onStart() {}, onEnd() {}, onMisfire() {} },

  async enable() {
    if (!window.vad?.MicVAD) throw new Error('détecteur de parole non chargé (connexion internet ?)');
    if (!this.vad) {
      this.vad = await window.vad.MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_BASE,
        onnxWASMBasePath: ORT_BASE,
        ...CALM,
        redemptionMs: 550,      /* silence qui marque la fin de ta phrase */
        preSpeechPadMs: 300,
        getStream: () => navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        }),
        onSpeechRealStart: () => { this.speaking = true; this.handlers.onStart(); },
        onSpeechEnd: (audio) => { this.speaking = false; this._hasWave = false; this.handlers.onEnd(audio); },
        onVADMisfire: () => { this.speaking = false; this._hasWave = false; this.handlers.onMisfire(); },
        onFrameProcessed: (_p, frame) => {
          if (!this.speaking || !frame) return;
          const n = Math.min(frame.length, this._wave.length);
          for (let i = 0; i < n; i++) this._wave[i] = 128 + Math.max(-127, Math.min(127, frame[i] * 400));
          this._hasWave = true;
        },
      });
    }
    await this.vad.start();
    this.on = true;
  },

  async disable() {
    this.on = false;
    this.speaking = false;
    this._hasWave = false;
    if (this.vad) await this.vad.pause();
  },

  /* plus exigeant pendant que Kurisu parle */
  setStrict(strict) {
    if (!this.vad || strict === this._strict) return;
    this._strict = strict;
    this.vad.setOptions(strict ? WHILE_SHE_TALKS : CALM);
  },

  waveform() { return this.on && this.speaking && this._hasWave ? this._wave : null; },

  /* Float32 16 kHz → WAV (pour /api/stt) */
  toWav(samples) {
    const sr = 16000;
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  },
};

export { AudioSys, TtsStream, Recorder, HandsFree };
