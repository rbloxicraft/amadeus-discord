/* Scène du stream Discord : l'avatar 3D, le fond et le compteur, pilotés par le client
   Discord. Il envoie (via le backend, websocket /ws/stage) le niveau de sa voix pour la
   bouche, l'émotion de chaque phrase et les changements de ligne d'univers. */
import { avatar } from './avatar.js?v=27';
import { screenBg } from './screenbg.js?v=5';
import { divergence } from './divergence.js?v=1';

let level = 0;          /* ouverture de bouche visée (0..1), envoyée par le bot */
let smooth = 0;
let lastMouth = 0;

let showJa = true;
const sub = {
  box: document.querySelector('#subtitle'),
  main: document.querySelector('#subtitle .sub-main'),
  ja: document.querySelector('#subtitle .sub-ja'),
};
function subtitle(fr, ja) {
  const text = fr || ja || '';
  sub.main.textContent = text;
  // réponse longue : texte plus petit, et pas de ligne japonaise (sinon l'avatar disparaît)
  const long = text.length > 110, veryLong = text.length > 190;
  sub.ja.textContent = showJa && fr && ja && !veryLong ? ja : '';
  sub.box.classList.toggle('long', long && !veryLong);
  sub.box.classList.toggle('very-long', veryLong);
  sub.box.classList.toggle('idle', !text);
}

function apply(settings) {
  showJa = settings.subtitle_japanese;
  document.body.classList.toggle('no-subtitles', !settings.stream_subtitles);
  screenBg.setActive(settings.background === 'screen');
  document.body.classList.toggle('no-divergence', !settings.divergence);
  avatar.setView(settings.view_2d ? '2d' : '3d');
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws/stage`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'settings') apply(m.settings);
    else if (m.type === 'mouth') { level = Math.max(0, Math.min(1, m.v)); lastMouth = performance.now(); }
    else if (m.type === 'emotion') avatar.setEmotion(m.emotion, m.ms || 6000);
    else if (m.type === 'speaking' && !m.on) level = 0;
    else if (m.type === 'divergence') divergence.shift(m.value || undefined);
    else if (m.type === 'subtitle') subtitle(m.fr, m.ja);
  };
  ws.onclose = () => setTimeout(connect, 1500);   /* backend relancé : on se reconnecte */
}

async function boot() {
  divergence.init();
  avatar.init(document.querySelector('#scene'));
  screenBg.init(document.querySelector('#screen-bg'));
  /* bouche : le niveau de la voix, lissé (ouverture rapide, fermeture plus douce) */
  avatar.lipSource = () => {
    if (performance.now() - lastMouth > 400) level = 0;   /* plus de nouvelles : bouche fermée */
    smooth += (level - smooth) * (level > smooth ? 0.6 : 0.25);
    if (smooth < 0.02) return null;
    return { aa: smooth * 0.75, oh: smooth * 0.3, ih: smooth * 0.15, ee: 0, ou: 0 };
  };
  await avatar.loadDefault().catch((e) => console.warn('Avatar :', e));
  avatar.setEmotion('neutral');
  connect();
}

boot();
window.__stage = { avatar, divergence, screenBg };
