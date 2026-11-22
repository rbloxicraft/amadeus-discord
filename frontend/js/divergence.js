/* Compteur de divergence (tubes nixie), partagé par l'interface et la scène du stream. */
const $ = (sel) => document.querySelector(sel);

export const divergence = (() => {
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
