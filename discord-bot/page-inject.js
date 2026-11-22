/* Injecté dans la page Discord (compte Amadeus) AVANT ses propres scripts.
   - Micro virtuel : getUserMedia(audio) renvoie un flux alimenté par la voix de Kurisu,
     que le programme Node pousse par morceaux (window.__amadeus.play).
   - Écoute : chaque son entrant (un par participant, déjà déchiffré par Discord) est
     découpé en phrases (détection de voix simple) et envoyé à Node
     (window.__amadeusHeard), avec l'identifiant Discord de la personne.
   - Qui parle : les messages « speaking » de la passerelle vocale donnent la
     correspondance SSRC (numéro du flux audio) → utilisateur. */
(() => {
  if (window.__amadeus) return;
  const A = (window.__amadeus = { ssrcUser: new Map(), tracks: 0, log: [], endSilence: 0.5 });
  const note = (m) => { A.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); A.log.splice(0, Math.max(0, A.log.length - 50)); };

  // ---------------------------------------------------------------- micro virtuel
  let out = null, dest = null, playhead = 0, sources = [], lead = 0.06;
  function outCtx() {
    if (!out) {
      out = new AudioContext({ sampleRate: 48000 });
      dest = out.createMediaStreamDestination();
      // un souffle inaudible en continu : le micro n'est jamais « vide » (Discord coupe
      // les entrées muettes trop longtemps)
      const g = out.createGain(); g.gain.value = 0.0001;
      const o = out.createOscillator(); o.frequency.value = 50; o.connect(g); g.connect(dest); o.start();
    }
    if (out.state === 'suspended') out.resume();
    return out;
  }
  /* b64 : PCM 16 bits mono 48 kHz ; first : 1er morceau d'une phrase (le silence avant
     n'est pas un retard). Renvoie le délai (s) avant que ce morceau commence. */
  A.play = (b64, first) => {
    const ctx = outCtx();
    const bin = atob(b64);
    const n = bin.length >> 1;
    const buf = ctx.createBuffer(1, n, 48000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 32768) v -= 65536;
      ch[i] = v / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    // avance avant lecture : la voix arrive au fil de la synthèse. Si elle prend du retard
    // au milieu d'une phrase (carte graphique chargée), il y aurait un trou : l'avance
    // grandit alors (jusqu'à 0,5 s), puis redescend doucement quand tout va bien
    const now = ctx.currentTime;
    if (!first && playhead > 0 && playhead < now) lead = Math.min(0.5, lead + 0.15);
    else lead = Math.max(0.06, lead - 0.005);
    const t = Math.max(now + lead, playhead);
    src.start(t);
    playhead = t + buf.duration;
    sources.push(src);
    src.onended = () => { sources = sources.filter((s) => s !== src); };
    return t - now;
  };
  A.stop = () => {
    for (const s of sources) { try { s.stop(); } catch { /* déjà fini */ } }
    sources = [];
    playhead = 0;
  };
  A.remaining = () => (out ? Math.max(0, playhead - out.currentTime) : 0);

  const md = navigator.mediaDevices;
  const realGum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    if (c && c.audio && !c.video) {
      outCtx();
      note('micro virtuel fourni à Discord');
      return new MediaStream([dest.stream.getAudioTracks()[0].clone()]);
    }
    return realGum(c);
  };

  // ---------------------------------------------------------------- qui parle (SSRC → utilisateur)
  const RealWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols === undefined ? new RealWS(url) : new RealWS(url, protocols);
    if (/discord\.media/.test(String(url))) {
      note(`passerelle vocale : ${String(url).slice(0, 60)}`);
      ws.addEventListener('message', (e) => {
        if (typeof e.data !== 'string') return;
        try {
          const m = JSON.parse(e.data);
          if (m.op === 5 && m.d && m.d.ssrc) A.ssrcUser.set(m.d.ssrc, m.d.user_id);
        } catch { /* message binaire ou non JSON */ }
      });
    }
    return ws;
  }
  HookedWS.prototype = RealWS.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) HookedWS[k] = RealWS[k];
  window.WebSocket = HookedWS;

  // ---------------------------------------------------------------- écoute de chaque participant
  let cap = null;
  const THRESH = 0.012;           // niveau considéré comme de la voix
  function capture(receiver, track) {
    cap = cap || new AudioContext({ sampleRate: 48000 });
    if (cap.state === 'suspended') cap.resume();
    A.tracks++;
    // Chromium : un son WebRTC distant ne circule dans WebAudio que s'il est aussi
    // rattaché à un élément média (muet ici)
    const el = new Audio();
    el.muted = true;
    el.srcObject = new MediaStream([track]);
    el.play().catch(() => {});
    const src = cap.createMediaStreamSource(new MediaStream([track]));
    const proc = cap.createScriptProcessor(2048, 1, 1);      // blocs de 43 ms
    const st = { on: false, chunks: [], loud: 0, quiet: 0, len: 0 };
    proc.onaudioprocess = (ev) => {
      const x = ev.inputBuffer.getChannelData(0);
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      const rms = Math.sqrt(s / x.length);
      const dur = x.length / 48000;
      if (rms > THRESH) { st.loud += dur; st.quiet = 0; } else { st.quiet += dur; }
      if (st.on || rms > THRESH) { st.chunks.push(new Float32Array(x)); st.len += dur; }
      else { st.chunks = st.chunks.slice(-4); st.len = st.chunks.length * dur; }   // un peu d'avant
      if (!st.on && st.loud >= 0.15) st.on = true;
      if (!st.on && st.quiet > 0.4) st.loud = 0;
      // fin de phrase : un silence de endSilence secondes (réglage « réactivité »)
      if (st.on && (st.quiet >= A.endSilence || st.len > 25)) flush();
    };
    function flush() {
      const chunks = st.chunks;
      Object.assign(st, { on: false, chunks: [], loud: 0, quiet: 0, len: 0 });
      let ssrc = null;
      try { ssrc = receiver.getSynchronizationSources()[0]?.source ?? null; } catch { /* rien */ }
      const user = ssrc != null ? A.ssrcUser.get(ssrc) || null : null;
      // 48 kHz → 16 kHz (moyenne de 3 échantillons), PCM 16 bits
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const pcm = new Int16Array(Math.floor(total / 3));
      let k = 0, acc = 0, cnt = 0;
      for (const c of chunks) for (let i = 0; i < c.length; i++) {
        acc += c[i]; cnt++;
        if (cnt === 3) { pcm[k++] = Math.max(-32768, Math.min(32767, Math.round((acc / 3) * 32767))); acc = 0; cnt = 0; }
      }
      const bytes = new Uint8Array(pcm.buffer, 0, k * 2);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      if (window.__amadeusHeard) window.__amadeusHeard(user, ssrc, btoa(bin), k / 16000);
    }
    src.connect(proc);
    proc.connect(cap.destination);   // nécessaire pour que le traitement tourne (sortie coupée)
    track.addEventListener('ended', () => {
      try { proc.disconnect(); src.disconnect(); } catch { /* déjà fait */ }
      el.srcObject = null;
      A.tracks--;
    });
  }

  const RealPC = window.RTCPeerConnection;
  function HookedPC(...args) {
    const pc = new RealPC(...args);
    note('connexion WebRTC créée');
    pc.addEventListener('track', (e) => {
      if (e.track.kind === 'audio') capture(e.receiver, e.track);
    });
    return pc;
  }
  HookedPC.prototype = RealPC.prototype;
  Object.setPrototypeOf(HookedPC, RealPC);
  window.RTCPeerConnection = HookedPC;
})();
