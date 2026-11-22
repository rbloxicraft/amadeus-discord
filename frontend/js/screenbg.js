/* Fond « écran » : noir bleuté, grille verte de carrés qui glisse lentement,
   traits lumineux qui courent le long de la grille, lignes de code floues et
   étirées qui défilent, éclats cyan qui s'allument et s'éteignent.
   Canvas à 30 images/s max, à l'arrêt quand le fond n'est pas affiché. */

const GLYPHS = '0123456789abcdefABCDEF{}[]()<>=+-*/_.:;#$%&|';
const CELL = 92;            /* taille d'un carré de la grille (px CSS) */
const DRIFT = [7, 11];      /* vitesse de glissement de la grille (px/s, x et y) */
const TEXT_SPEED = 6;       /* défilement du texte vers le haut (px/s) */

const rand = (a, b) => a + Math.random() * (b - a);

class ScreenBg {
  constructor() {
    this.on = false;
    this.blips = [];
    this.runners = [];
    this._last = 0;
    this._raf = 0;
    this._t0 = performance.now();
    this._loop = this._loop.bind(this);
  }

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.text = document.createElement('canvas');   /* texte net (brouillon) */
    this.soft = document.createElement('canvas');   /* texte flou, prêt à l'emploi */
    new ResizeObserver(() => this._resize()).observe(canvas);
  }

  setActive(on) {
    this.on = on;
    this.canvas.hidden = !on;
    cancelAnimationFrame(this._raf);
    if (on) { this._resize(); this._raf = requestAnimationFrame(this._loop); }
  }

  _resize() {
    if (!this.on) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    for (const c of [this.canvas, this.text, this.soft]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.w = w; this.h = h; this.dpr = dpr;
    /* intensité propre à chaque ligne de la grille : certaines plus marquées */
    this.lineAlpha = Array.from({ length: 512 }, () => (Math.random() < 0.25 ? rand(0.17, 0.26) : rand(0.08, 0.13)));
    this._drawText();
    this.blips = [];
    this.runners = [];
    this._draw(performance.now());
  }

  /* lignes de « code » : étirées en largeur puis floutées, comme un écran projeté */
  _drawText() {
    const g = this.text.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const size = 11, lineH = 17, stretch = 2.1;
    g.font = `${size}px Consolas, "Cascadia Mono", monospace`;
    g.textBaseline = 'top';
    g.save();
    g.scale(stretch, 1);                               /* caractères étirés horizontalement */
    const W = this.w / stretch;
    for (let y = 6; y < this.h; y += lineH) {
      if (Math.random() < 0.3) continue;               /* ligne vide */
      let x = rand(4, 30);
      while (x < W) {
        const len = 3 + Math.floor(Math.random() * 18);
        let s = '';
        for (let i = 0; i < len; i++) s += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        const a = rand(0.05, 0.13);
        g.fillStyle = Math.random() < 0.85 ? `rgba(80, 170, 120, ${a})` : `rgba(90, 200, 210, ${a * 1.3})`;
        g.fillText(s, x, y);
        x += len * size * 0.58 + rand(8, 70);
      }
    }
    g.restore();
    /* flou appliqué une seule fois (pas à chaque image) */
    const s = this.soft.getContext('2d');
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, this.soft.width, this.soft.height);
    s.filter = `blur(${(1.4 * this.dpr).toFixed(1)}px)`;
    s.drawImage(this.text, 0, 0);
    s.filter = 'none';
  }

  /* trait lumineux qui court le long d'une ligne de la grille */
  _spawnRunner(now, ox, oy) {
    const vertical = Math.random() < 0.5;
    const span = vertical ? this.w : this.h;
    const line = Math.floor(Math.random() * (span / CELL + 1));
    this.runners.push({
      vertical,
      base: (vertical ? ox : oy) + line * CELL,             /* ligne de grille suivie (écran, à la naissance) */
      pos: rand(-0.2, 0.6),                                  /* position de départ (fraction) */
      speed: rand(0.04, 0.12) * (Math.random() < 0.5 ? -1 : 1),
      len: rand(40, 160),
      born: now,
      life: rand(2500, 6000),
    });
  }

  _spawnBlip(now) {
    const vertical = Math.random() < 0.55;
    this.blips.push({
      x: Math.random() * this.w,
      y: Math.random() * this.h,
      w: vertical ? rand(3, 7) : rand(8, 32),
      h: vertical ? rand(6, 32) : rand(2, 5),
      born: now,
      life: rand(900, 4100),
      flicker: Math.random() < 0.35,
      tick: Math.random() < 0.3,
    });
  }

  _draw(now) {
    const c = this.ctx;
    const t = (now - this._t0) / 1000;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    /* fond : noir bleu-vert, plus clair au centre */
    const grd = c.createRadialGradient(this.w * 0.5, this.h * 0.45, 0, this.w * 0.5, this.h * 0.45, Math.max(this.w, this.h) * 0.75);
    grd.addColorStop(0, '#15201f');
    grd.addColorStop(1, '#060909');
    c.fillStyle = grd;
    c.fillRect(0, 0, this.w, this.h);

    /* texte flou qui défile lentement vers le haut (deux copies pour boucler) */
    const ty = this.reduced ? 0 : (t * TEXT_SPEED) % this.h;
    c.drawImage(this.soft, 0, 0, this.soft.width, this.soft.height, 0, -ty, this.w, this.h);
    c.drawImage(this.soft, 0, 0, this.soft.width, this.soft.height, 0, this.h - ty, this.w, this.h);

    /* grille verte de carrés qui glisse */
    const ox = this.reduced ? 0 : (t * DRIFT[0]) % CELL;
    const oy = this.reduced ? 0 : (t * DRIFT[1]) % CELL;
    const kx = this.reduced ? 0 : Math.floor((t * DRIFT[0]) / CELL);
    const ky = this.reduced ? 0 : Math.floor((t * DRIFT[1]) / CELL);
    const pulse = this.reduced ? 1 : 0.85 + 0.15 * Math.sin(t * 0.7);
    c.lineWidth = 1;
    for (let i = -1, x = ox - CELL; x < this.w + CELL; i++, x += CELL) {
      const a = this.lineAlpha[((i - kx) % 256 + 256) % 256] * pulse;
      c.strokeStyle = `rgba(70, 200, 120, ${a.toFixed(3)})`;
      c.beginPath(); c.moveTo(Math.round(x) + 0.5, 0); c.lineTo(Math.round(x) + 0.5, this.h); c.stroke();
    }
    for (let j = -1, y = oy - CELL; y < this.h + CELL; j++, y += CELL) {
      const a = this.lineAlpha[256 + (((j - ky) % 256 + 256) % 256)] * pulse;
      c.strokeStyle = `rgba(70, 200, 120, ${a.toFixed(3)})`;
      c.beginPath(); c.moveTo(0, Math.round(y) + 0.5); c.lineTo(this.w, Math.round(y) + 0.5); c.stroke();
    }

    /* traits lumineux qui courent sur la grille (ils suivent son glissement) */
    if (!this.reduced && this.runners.length < 7 && Math.random() < 0.04) this._spawnRunner(now, ox, oy);
    this.runners = this.runners.filter((r) => now - r.born < r.life);
    c.shadowColor = 'rgba(80, 255, 150, .8)';
    c.shadowBlur = 6;
    for (const r of this.runners) {
      const age = (now - r.born) / r.life;
      const a = Math.min(1, age * 5) * Math.min(1, (1 - age) * 3) * 0.55;
      const along = (r.pos + r.speed * (now - r.born) / 1000) * (r.vertical ? this.h : this.w);
      const grad = r.vertical
        ? c.createLinearGradient(0, along - r.len, 0, along)
        : c.createLinearGradient(along - r.len, 0, along, 0);
      const head = r.speed > 0 ? 1 : 0;
      grad.addColorStop(head, `rgba(120, 255, 170, ${a.toFixed(3)})`);
      grad.addColorStop(1 - head, 'rgba(120, 255, 170, 0)');
      c.strokeStyle = grad;
      c.lineWidth = 1.5;
      c.beginPath();
      /* la ligne glisse avec la grille : on suit le même déplacement */
      const drift = (now - r.born) / 1000 * (r.vertical ? DRIFT[0] : DRIFT[1]);
      if (r.vertical) {
        const x = Math.round(r.base + drift) + 0.5;
        c.moveTo(x, along - r.len); c.lineTo(x, along);
      } else {
        const y = Math.round(r.base + drift) + 0.5;
        c.moveTo(along - r.len, y); c.lineTo(along, y);
      }
      c.stroke();
    }

    /* éclats cyan */
    const target = Math.round((this.w * this.h) / 38000);
    if (!this.reduced && this.blips.length < target && Math.random() < 0.25) this._spawnBlip(now);
    if (this.reduced && !this.blips.length) for (let i = 0; i < target; i++) this._spawnBlip(now - 400);
    c.shadowColor = 'rgba(60, 230, 255, .9)';
    c.shadowBlur = 8;
    this.blips = this.blips.filter((b) => this.reduced || now - b.born < b.life);
    for (const b of this.blips) {
      const k = (now - b.born) / b.life;
      let a = this.reduced ? 0.7 : Math.min(1, k * 6) * Math.min(1, (1 - k) * 3);
      if (b.flicker && !this.reduced) a *= 0.55 + 0.45 * Math.sin(now / 45 + b.x);
      c.fillStyle = `rgba(90, 235, 255, ${(a * 0.85).toFixed(3)})`;
      c.fillRect(b.x, b.y, b.w, b.h);
      if (b.tick) c.fillRect(b.x - 3, b.y + b.h * 0.4, b.w + 6, 2);
    }
    c.shadowBlur = 0;
  }

  _loop(now) {
    if (!this.on) return;
    this._raf = requestAnimationFrame(this._loop);
    if (this.reduced || now - this._last < 33) return;
    this._last = now;
    this._draw(now);
  }
}

export const screenBg = new ScreenBg();
