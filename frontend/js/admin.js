/* Page de configuration d'Amadeus sur Discord : état, commandes, réglages (enregistrés à chaque
   changement), journal en direct, mémoire. Réservée à ce PC (127.0.0.1). */
const $ = (s) => document.querySelector(s);
const form = $('#settings');
let settings = null;
let status = null;
let logSize = 0;

function toast(msg, ms = 4000) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), ms);
}

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `erreur ${r.status}`);
  return r.status === 204 ? null : r.json();
}

/* ───────── réglages ───────── */

function fillSelect(sel, items, value, empty) {
  sel.replaceChildren(...[empty ? [ '', empty ] : null, ...items].filter(Boolean).map(([v, label]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    return o;
  }));
  if (value && ![...sel.options].some((o) => o.value === value)) {
    const o = document.createElement('option');
    o.value = value; o.textContent = `(${value})`;
    sel.appendChild(o);
  }
  sel.value = value || '';
}

function refreshPlaces() {
  const guilds = status?.guilds || [];
  fillSelect($('#guild'), guilds.map((g) => [g.id, g.name]), settings.guild_id, guilds.length ? '— choisir —' : 'lance Amadeus pour voir tes serveurs');
  const g = guilds.find((x) => x.id === settings.guild_id);
  fillSelect($('#channel'), (g?.voice || []).map((c) => [c.id, c.name]), settings.voice_channel_id, '— choisir —');
  const people = new Map((status?.members || []).map((m) => [m.id, m.name]));
  if (settings.owner_id && !people.has(settings.owner_id)) people.set(settings.owner_id, settings.owner_name || settings.owner_id);
  fillSelect($('#owner'), [...people], settings.owner_id, '— personne —');
}

function render() {
  for (const el of form.elements) {
    if (!el.name || !(el.name in settings)) continue;
    const v = settings[el.name];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (Array.isArray(v)) el.value = v.join(', ');
    else el.value = v;
  }
  form.elements.resolution.value = `${settings.stream_width}x${settings.stream_height}`;
  refreshPlaces();
}

let saveTimer = 0;
async function save(changes) {
  try {
    settings = await api('/api/discord/settings', { method: 'PUT', body: JSON.stringify(changes) });
    $('#saved').textContent = 'enregistré';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { $('#saved').textContent = ''; }, 1500);
    refreshPlaces();
  } catch (e) {
    toast('Réglage non enregistré : ' + e.message);
  }
}

form.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'brain') return;
  if (el.name === 'resolution') {
    const [w, h] = el.value.split('x').map(Number);
    return save({ stream_width: w, stream_height: h });
  }
  const changes = { [el.name]: el.type === 'checkbox' ? el.checked : el.value };
  if (el.name === 'guild_id') changes.voice_channel_id = '';
  if (el.name === 'owner_id') changes.owner_name = el.selectedOptions[0]?.textContent || '';
  save(changes);
});
form.addEventListener('submit', (e) => e.preventDefault());

/* cerveau : réglage commun avec l'interface Amadeus du fork */
async function loadBrain() {
  const b = await api('/api/brain');
  fillSelect($('#brain'), b.options.filter((o) => o.configured).map((o) => [o.id, `${o.label} — ${o.detail}`]), b.current);
  $('#brain').onchange = async (e) => {
    try { await api('/api/brain', { method: 'PUT', body: JSON.stringify({ brain: e.target.value }) }); toast('Cerveau changé.'); }
    catch (err) { toast('Cerveau : ' + err.message); }
  };
}

/* ───────── état + journal ───────── */

function renderStatus(s) {
  const bot = s.bot_connected;
  status = s.status || {};
  $('#conn').textContent = bot ? (status.connected ? (status.streaming ? 'En vocal · en direct' : 'En vocal') : 'Lancée, hors vocal') : 'Amadeus non lancée';
  $('#conn').className = 'pill ' + (bot ? 'on' : 'off');
  $('#st-user').textContent = status.user || '—';
  $('#st-where').textContent = status.channel ? `${status.channel} (${status.guild})` : 'pas dans un vocal';
  $('#st-members').textContent = (status.members || []).map((m) => m.name).join(', ') || '—';
  $('#st-activity').textContent = !bot ? '—'
    : status.speaking ? 'parle' : status.thinking ? 'réfléchit…' : status.connected ? 'écoute' : 'en attente';
  $('#btn-join').disabled = !bot || !!status.connected;
  $('#btn-leave').disabled = !bot || !status.connected;
  $('#btn-stream').disabled = !bot || !status.connected;
  $('#btn-stream').textContent = settings?.stream_enabled ? 'Arrêter le stream' : 'Lancer le stream';
  $('#btn-stop').disabled = !bot || !(status.speaking || status.thinking);
  if (s.log_size < logSize) $('#log').replaceChildren();   // backend relancé : journal repris de zéro
  for (const entry of s.log) addLog(entry);
  logSize = s.log_size;
}

function addLog(e) {
  const li = document.createElement('li');
  li.className = e.kind + (e.text?.endsWith('(sans réponse)') ? ' muted' : '');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(e.t).toLocaleTimeString('fr-FR');
  li.appendChild(time);
  if (e.who) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = e.who;
    li.appendChild(who);
  }
  li.appendChild(document.createTextNode(e.text || ''));
  const box = $('#log');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.appendChild(li);
  while (box.children.length > 300) box.firstChild.remove();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

let placesShown = false;
async function poll() {
  try {
    renderStatus(await api(`/api/discord/status?since=${logSize}`));
    if (!placesShown && status.guilds) { refreshPlaces(); placesShown = true; }
  } catch { $('#conn').textContent = 'Backend arrêté'; $('#conn').className = 'pill off'; }
  setTimeout(poll, 1500);
}

async function command(action, extra = {}) {
  try { await api('/api/discord/command', { method: 'POST', body: JSON.stringify({ action, ...extra }) }); }
  catch (e) { toast(e.message); }
}
$('#btn-join').onclick = () => command('join');
$('#btn-leave').onclick = () => command('leave');
/* le stream suit le réglage : Amadeus le lance ou l'arrête d'elle-même (≤ 3 s) */
$('#btn-stream').onclick = async () => {
  await save({ stream_enabled: !settings.stream_enabled });
  render();
};
$('#btn-stop').onclick = () => command('stop');
$('#say-form').onsubmit = (e) => {
  e.preventDefault();
  const t = $('#say-input').value.trim();
  if (!t) return;
  command('say', { text: t });
  $('#say-input').value = '';
};

/* ───────── mémoire (celle du fork, distincte de ton Amadeus perso) ───────── */

async function loadMemory() {
  const m = await api('/api/memory');
  $('#memory').value = m.profile || '';
  $('#mem-count').textContent = `${m.exchanges} échange${m.exchanges > 1 ? 's' : ''}`;
}
$('#mem-save').onclick = async () => {
  const v = $('#memory').value.trim();
  if (!v) return toast('Texte vide : pour repartir de zéro, utilise « Tout effacer ».');
  try { await api('/api/memory', { method: 'PUT', body: JSON.stringify({ profile: v }) }); toast('Mémoire enregistrée.'); }
  catch (e) { toast(e.message); }
};
$('#mem-wipe').onclick = async () => {
  if (!confirm('Effacer toute sa mémoire du serveur ? Impossible d\'annuler.')) return;
  try { await api('/api/memory', { method: 'DELETE' }); await loadMemory(); toast('Mémoire effacée.'); }
  catch (e) { toast(e.message); }
};

/* aperçu : la scène (1280×720) réduite à la largeur du cadre */
function fitPreview() {
  const frame = $('.preview .frame');
  $('#preview').style.transform = `scale(${frame.clientWidth / 1280})`;
}
new ResizeObserver(fitPreview).observe($('.preview .frame'));

(async () => {
  settings = await api('/api/discord/settings');
  render();
  loadBrain().catch(() => {});
  loadMemory().catch(() => {});
  poll();
})();
