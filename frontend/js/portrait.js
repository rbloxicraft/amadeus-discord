/* Portrait 2D : images fournies par l'utilisateur, une par émotion
   (+ variante « bouche ouverte » facultative pour la parole).
   Fondu entre émotions, respiration légère, bouche qui suit la voix. */

const TALK_ON = 0.16;    /* ouverture (somme des visèmes) au-delà de laquelle la bouche s'ouvre */
const TALK_OFF = 0.09;   /* et en dessous de laquelle elle se ferme (hystérésis : pas de scintillement) */
const MIN_HOLD = 70;     /* ms minimum entre deux changements de bouche */

class Portrait {
  constructor() {
    this.sprites = {};          /* émotion → { idle, talk } (URLs) */
    this.active = false;
    this.lipSource = null;
    this._emotion = 'neutral';
    this._until = 0;
    this._open = false;
    this._lastFlip = 0;
    this._shown = null;
  }

  init(root) {
    this.root = root;
    /* deux calques pour le fondu enchaîné entre émotions */
    this.layers = [0, 1].map(() => {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      root.appendChild(img);
      return img;
    });
    this._front = 0;
    this._tick = this._tick.bind(this);
  }

  get available() { return Object.keys(this.sprites).length > 0; }

  async load() {
    try {
      const r = await fetch('/api/sprites', { cache: 'no-store' });
      this.sprites = r.ok ? (await r.json()).sprites || {} : {};
    } catch { this.sprites = {}; }
    /* précharge tout : aucun blanc au premier changement d'expression */
    for (const s of Object.values(this.sprites)) for (const u of [s.idle, s.talk]) if (u) new Image().src = u;
    this._shown = null;
    if (this.active) this._render(true);
    return this.available;
  }

  setActive(on) {
    this.active = on && this.available;
    this.root.hidden = !this.active;
    if (this.active) { this._render(true); requestAnimationFrame(this._tick); }
    return this.active;
  }

  setEmotion(emotion, durationMs = 6000) {
    this._emotion = emotion || 'neutral';
    this._until = performance.now() + durationMs;
  }

  _currentUrl() {
    const emo = performance.now() < this._until ? this._emotion : 'neutral';
    const s = this.sprites[emo] || this.sprites.neutral || Object.values(this.sprites)[0];
    if (!s) return null;
    return { url: this._open && s.talk ? s.talk : s.idle, emoChanged: emo, hasTalk: !!s.talk };
  }

  _render(force = false) {
    const cur = this._currentUrl();
    if (!cur || (!force && cur.url === this._shown)) return;
    const mouthOnly = this._shownEmo === cur.emoChanged && !force;
    this._shown = cur.url;
    this._shownEmo = cur.emoChanged;
    const [a, b] = [this.layers[this._front], this.layers[1 - this._front]];
    if (mouthOnly) {
      /* bouche : changement instantané sur le même calque */
      a.src = cur.url;
      return;
    }
    /* émotion : fondu enchaîné */
    b.src = cur.url;
    b.classList.add('on');
    a.classList.remove('on');
    this._front = 1 - this._front;
  }

  _tick() {
    if (!this.active) return;
    requestAnimationFrame(this._tick);
    const lips = this.lipSource ? this.lipSource() : null;
    const open = lips ? Object.values(lips).reduce((s, v) => s + v, 0) : 0;
    const now = performance.now();
    const cur = this._currentUrl();
    if (cur?.hasTalk && now - this._lastFlip > MIN_HOLD) {
      const want = this._open ? open > TALK_OFF : open > TALK_ON;
      if (want !== this._open) { this._open = want; this._lastFlip = now; }
    } else if (!cur?.hasTalk) this._open = false;
    /* sans image « bouche ouverte » : léger mouvement de tête quand elle parle */
    const bob = !cur?.hasTalk && open > TALK_OFF ? Math.min(open, 0.6) * 6 : 0;
    this.root.style.setProperty('--bob', `${bob.toFixed(1)}px`);
    this._render();
  }
}

export const portrait = new Portrait();
