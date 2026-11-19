'use strict';
const $ = s => document.querySelector(s);
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = iso => new Date(iso).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const st = { code: store.get('nave.code') || '', author: store.get('nave.author') || '', cfg: null, versions: [], view: null, sess: null, busy: false, pose: null, autoFixed: false, lastActivity: Date.now() };
const viewer = $('#viewer'), log = $('#log'), msg = $('#msg');

async function api(p, opt = {}) {
  const r = await fetch(p, { ...opt, headers: { 'Content-Type': 'application/json', 'x-access-code': st.code, ...(opt.headers || {}) } });
  if (r.status === 401) { showLogin('El código de acceso no es válido.'); throw new Error('auth'); }
  const isJson = (r.headers.get('content-type') || '').includes('json');
  const d = isJson ? await r.json() : await r.text();
  if (!r.ok) throw new Error((isJson ? d.error : d) || 'Error');
  return d;
}
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 3200); }

/* ---------- visor ---------- */
function loadViewer(url, keepPose, peek) {
  st.peek = peek || null; $('#peek').hidden = !peek; if (peek) $('#peekTxt').textContent = peek.label; renderSessions();
  if (keepPose) { try { st.pose = viewer.contentWindow.__nave.getPose(); } catch { st.pose = null; } } else st.pose = null;
  $('#loading').hidden = false; $('#sceneErr').hidden = true; if (st.points?.length) { st.points = []; renderPins(); } if (st.meas?.length || st.mA) { st.meas = []; st.mA = null; st.mTmp = null; renderMeas(); }
  viewer.src = `${url}?embed=1&t=${Date.now()}`;
}
window.addEventListener('message', e => {
  if (e.source !== viewer.contentWindow) return;
  if (e.data?.type === 'scene-ready') {
    $('#loading').hidden = true;
    if (st.pose) { try { viewer.contentWindow.__nave.setPose(st.pose); } catch {} st.pose = null; }
  }
  if (e.data?.type === 'scene-error') {
    $('#loading').hidden = true;
    const box = $('#sceneErr'); box.hidden = false;
    box.innerHTML = `<span>El visor ha dado un error: ${esc(e.data.message)}</span>` + (st.sess ? '<button id="fixIt">Pedir arreglo</button>' : '');
    const fix = () => send(`El visor da este error al cargar la escena: ${e.data.message}. Arréglalo sin perder los cambios anteriores.`);
    $('#fixIt')?.addEventListener('click', fix);
    if (st.sess && !st.autoFixed && !st.busy) { st.autoFixed = true; fix(); }
  }
});
viewer.addEventListener('load', () => setTimeout(() => ($('#loading').hidden = true), 6000));

/* ---------- estado y cabecera ---------- */
const pending = () => (st.sess?.turns || []).filter(t => t.changed && !t.undone).length;
function updateState() {
  const v = st.versions.find(x => x.id === (st.sess ? st.sess.baseVersion : st.view)) || {};
  const n = pending();
  $('#viewing').textContent = st.peek ? st.peek.label : st.sess ? `Borrador sobre v${st.sess.baseVersion} · ${v.title || ''}` : `v${v.id ?? '—'} · ${v.title || ''}`;
  $('#state').textContent = st.busy ? 'El asistente está aplicando el cambio…'
    : st.peek ? `Modo administrador · ${st.peek.label} · solo lectura (pulsa «Volver» para salir)`
    : st.sess ? `Sesión de cambios sobre v${st.sess.baseVersion} · ${n} ${n === 1 ? 'cambio' : 'cambios'} sin guardar`
    : `Viendo v${v.id ?? '—'}${v.id === st.versions.at(-1)?.id ? ' (la más reciente)' : ''} · escribe abajo para empezar una sesión de cambios`;
  $('#dot').className = 'dot' + (st.busy ? ' busy' : st.sess ? ' live' : '');
  $('#btnUndo').disabled = st.busy || !st.sess || !st.sess.stack;
  $('#btnSave').disabled = st.busy || !st.sess || !n;
  $('#btnDiscard').disabled = st.busy || !st.sess;
  $('#btnSend').disabled = st.busy;
  $('#who').textContent = st.author || 'Sin nombre';
  $('#vcount').textContent = st.versions.length; renderFoot();
  if (st.sess) store.set('nave.sid', st.sess.id); else store.set('nave.sid', null);
}

/* ---------- registro del chat ---------- */
function add(kind, html) { log.querySelector('.empty')?.remove(); const d = document.createElement('div'); d.className = kind; d.innerHTML = html; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
function emptyState() {
  log.innerHTML = '';
  const ex = ['Pon un banco de trabajo de 2 m junto a las Fuse, sin tapar el paso', 'Cambia el suelo del showroom a gris claro', 'Añade dos costillas de Adán más en la sala de muestras', 'Mueve el H-WING 1 m hacia la fachada'];
  const d = add('empty', `<h3>Pide un cambio y lo verás en 3D</h3><div>El asistente edita la nave a partir de lo que escribas. Cuando termines, guarda la sesión: se crea una versión nueva y la anterior se conserva.</div><div class="chips">${ex.map(t => `<button class="chip">${esc(t)}</button>`).join('')}</div>`);
  d.querySelectorAll('.chip').forEach(b => b.onclick = () => { msg.value = b.textContent; msg.focus(); autosize(); });
}
function replayTurns() {
  log.innerHTML = '';
  if (!st.sess?.turns.length) return emptyState();
  for (const t of st.sess.turns) { add('msg user', esc(t.instruction)); add('msg bot', `<span class="meta">Asistente${t.undone ? ' · deshecho' : ''}</span>${esc(t.summary)}`); }
}

/* ---------- sesiones ---------- */
async function ensureSession() {
  if (st.sess) return st.sess;
  if (!st.author) { await askName(); }
  st.sess = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ author: st.author, baseVersion: st.view }) });
  return st.sess;
}
async function send(text, image, photos = []) {
  text = text.trim(); if (!text || st.busy) return;
  st.lastActivity = Date.now();
  try { await ensureSession(); } catch (e) { if (e.message !== 'auth') add('msg err', esc(e.message)); return; }
  const tags = [photos.length ? `${photos.length} foto${photos.length > 1 ? 's' : ''}` : '', image ? 'puntos señalados y captura de la vista' : ''].filter(Boolean).join(' · ');
  add('msg user', `${tags ? `<span class="meta">Con ${tags}</span>` : ''}${photos.length ? `<div class="shots">${photos.map(p => `<img src="${p}" alt="">`).join('')}</div>` : ''}${esc(text)}`);
  const steps = add('steps', ''); let live = null;
  const step = t => { live?.classList.remove('live'); live = document.createElement('div'); live.className = 'live'; live.textContent = t; steps.appendChild(live); log.scrollTop = log.scrollHeight; };
  st.busy = true; updateState(); step('enviando');
  try {
    const r = await fetch(`/api/sessions/${st.sess.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-code': st.code }, body: JSON.stringify({ text, image, photos }) });
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `Error ${r.status}`); }
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: ')); if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'tool') step(ev.text);
        if (ev.type === 'note') { const n = document.createElement('div'); n.className = 'note'; n.textContent = ev.text.slice(0, 300); steps.appendChild(n); }
        if (ev.type === 'assistant') {
          live?.classList.remove('live');
          add('msg bot', `<span class="meta">Asistente${ev.changed ? ' · cambio aplicado' : ' · sin cambios'}</span>${esc(ev.text)}${ev.errors?.length ? `\n\n⚠ ${esc(ev.errors.join('\n'))}` : ''}`);
          st.sess = await api(`/api/sessions/${st.sess.id}`); refreshSessions();
          if (ev.changed) { st.autoFixed = text.startsWith('El visor da este error') ? st.autoFixed : false; loadViewer(`/scene/s/${st.sess.id}`, true); }
        }
        if (ev.type === 'error') add('msg err', `<span class="meta">Error</span>${esc(ev.text)}`);
      }
    }
  } catch (e) { if (e.message !== 'auth') add('msg err', `<span class="meta">Error</span>${esc(e.message)}`); }
  live?.classList.remove('live'); st.busy = false; st.lastActivity = Date.now(); updateState();
}
$('#composer').addEventListener('submit', e => {
  e.preventDefault(); let t = msg.value.trim(); let image = null;
  if (!t && !st.points.length && !st.photos.length) return;
  if (st.points.length) {
    if (!t) t = 'Fíjate en los puntos que he señalado.';
    t += '\n\n[Puntos señalados en el visor]\n' + st.points.map(p => `${p.idx}) ${p.zone} · X=${p.X.toFixed(2)} Y=${p.Y.toFixed(2)} Z=${p.Z.toFixed(2)} · superficie: ${p.mat || 'sin material identificado'}${p.face ? ' · ' + p.face : ''}`).join('\n');
    try { image = capture(); } catch {}
    clearPins();
  }
  const photos = st.photos.slice(); if (!t && photos.length) t = 'Mira la foto adjunta.';
  if (!t) return;
  st.photos = []; renderThumbs();
  msg.value = ''; autosize(); setPick(false); send(t, image, photos);
});
msg.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); } });
function autosize() { msg.style.height = 'auto'; msg.style.height = Math.min(140, msg.scrollHeight) + 'px'; }
msg.addEventListener('input', autosize);

$('#btnUndo').onclick = async () => {
  try { st.sess = await api(`/api/sessions/${st.sess.id}/undo`, { method: 'POST' }); replayTurns(); loadViewer(`/scene/s/${st.sess.id}`, true); toast('Último cambio deshecho'); } catch (e) { toast(e.message); }
  updateState();
};
let discardArm = 0;
$('#btnDiscard').onclick = async () => {
  if (Date.now() - discardArm > 4000) { discardArm = Date.now(); $('#btnDiscard').textContent = '¿Seguro? Pulsa otra vez'; setTimeout(() => ($('#btnDiscard').textContent = 'Descartar'), 4000); return; }
  $('#btnDiscard').textContent = 'Descartar';
  await api(`/api/sessions/${st.sess.id}/discard`, { method: 'POST' }).catch(() => {});
  const base = st.sess.baseVersion; st.sess = null; emptyState(); viewVersion(base); toast('Sesión descartada. No se ha guardado nada.');
};
$('#btnSave').onclick = () => openSave();
$('#btnFold').onclick = () => $('#dock').classList.toggle('folded');

function openSave(reason) {
  const applied = st.sess.turns.filter(t => t.changed && !t.undone);
  const latest = st.versions.at(-1)?.id, next = latest + 1;
  modal(`<span class="eyebrow">Guardar sesión</span><h2>Nueva versión v${next}</h2>
    ${reason ? `<p>${esc(reason)}</p>` : '<p>Se guarda siempre como una versión nueva. La versión de partida no se modifica.</p>'}
    ${st.sess.baseVersion !== latest ? `<p class="hint">Partiste de v${st.sess.baseVersion} y ya existe v${latest}. Esta versión quedará como una rama desde v${st.sess.baseVersion}.</p>` : ''}
    <div class="field"><label for="sTitle">Título</label><input id="sTitle" maxlength="120" value="${esc(applied[0]?.instruction.slice(0, 90) || '')}"></div>
    <div class="field"><label for="sNotes">Notas (opcional)</label><textarea id="sNotes" rows="3" placeholder="Por qué se hace el cambio, quién lo pidió…"></textarea></div>
    <div class="field"><label>Cambios que incluye (${applied.length})</label><ul>${applied.map(t => `<li>${esc(t.instruction)}</li>`).join('')}</ul></div>
    <div class="row"><button class="ghost" data-close>Seguir editando</button><button id="doSave" class="primary">Guardar como v${next}</button></div>`);
  $('#doSave').onclick = async () => {
    $('#doSave').disabled = true;
    try {
      const v = await api(`/api/sessions/${st.sess.id}/save`, { method: 'POST', body: JSON.stringify({ title: $('#sTitle').value, notes: $('#sNotes').value }) });
      closeModal(); st.sess = null; await refreshVersions(); emptyState(); viewVersion(v.id); toast(`Guardado como v${v.id}`);
    } catch (e) { $('#doSave').disabled = false; toast(e.message); }
  };
}

/* ---------- versiones ---------- */
async function refreshVersions() { st.versions = await api('/api/versions'); renderVersions(); updateState(); }
function viewVersion(id) { st.view = id; loadViewer(`/scene/v/${id}`, true); renderVersions(); updateState(); }
function renderVersions() {
  $('#vlist').innerHTML = [...st.versions].reverse().map(v => `<li class="v${!st.sess && v.id === st.view ? ' current' : ''}">
    <div class="v-top"><span class="vid">v${v.id}</span><span class="v-title">${esc(v.title)}</span></div>
    <div class="v-meta">${esc(v.author)} · ${fmtDate(v.createdAt)}${v.parent ? ` · basada en v${v.parent}` : ''}${v.added || v.removed ? ` · +${v.added} −${v.removed} líneas` : ''}</div>
    ${v.notes ? `<div>${esc(v.notes)}</div>` : ''}
    ${v.instructions?.length ? `<ul>${v.instructions.slice(0, 4).map(i => `<li>${esc(i.instruction)}</li>`).join('')}${v.instructions.length > 4 ? `<li>y ${v.instructions.length - 4} más</li>` : ''}</ul>` : ''}
    <div class="v-act"><button class="ghost" data-view="${v.id}">Ver</button>${v.parent ? `<button class="ghost" data-diff="${v.id}">Cambios en código</button>` : ''}<button class="ghost" data-branch="${v.id}" ${st.sess ? 'disabled' : ''}>Editar desde aquí</button></div></li>`).join('');
}
$('#vlist').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.view) { if (st.sess && !st.cfg?.admin) return toast('Guarda o descarta la sesión abierta antes de cambiar de versión.'); if (st.sess) loadViewer(`/scene/v/${b.dataset.view}`, true, { label: `Viendo v${b.dataset.view} (tu sesión sigue abierta)` }); else viewVersion(+b.dataset.view); }
  if (b.dataset.branch) { viewVersion(+b.dataset.branch); $('#hist').hidden = true; msg.focus(); toast(`Tu próximo mensaje empezará una sesión sobre v${b.dataset.branch}`); }
  if (b.dataset.diff) {
    const t = await api(`/api/versions/${b.dataset.diff}/diff`);
    const html = esc(t).split('\n').map(l => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'd' : l.startsWith('@@') ? 'h' : ''}">${l}</span>`).join('\n');
    modal(`<span class="eyebrow">Trazabilidad</span><h2>Cambios de v${b.dataset.diff}</h2><pre class="diff">${html}</pre><div class="row"><button class="ghost" data-close>Cerrar</button></div>`, true);
  }
});
/* ---------- administrador: pruebas del equipo ---------- */
st.adminSessions = [];
const STATUS = { open: 'en curso', saved: 'guardada', discarded: 'descartada' };
async function refreshSessions() { if (!st.cfg?.admin) return; try { st.adminSessions = await api('/api/admin/sessions'); } catch (e) { return toast(e.message); } renderSessions(); }
function renderSessions() {
  if (!st.cfg?.admin) return;
  const L = st.adminSessions.filter(s => s.turns.length);
  $('#scount').textContent = L.length;
  $('#slist').innerHTML = L.length ? L.map(s => {
    const n = s.turns.filter(t => t.changed && !t.undone).length, nums = s.turns.map(t => t.n).filter(Boolean), fin = s.turns.find(t => t.draft === s.stack)?.n;
    const badge = s.status === 'saved' ? `guardada como v${s.savedAs}` : STATUS[s.status] || s.status;
    return `<li class="v"><div class="v-top">${nums.length ? `<span class="vid">#${nums[0]}${nums.length > 1 ? '–' + nums.at(-1) : ''}</span>` : ''}<span class="v-title">${esc(s.author)}</span><span class="badge ${s.status}">${esc(badge)}</span></div>
    <div class="v-meta">${fmtDate(s.createdAt)} · sobre v${s.baseVersion} · ${s.turns.length} mensaje${s.turns.length > 1 ? 's' : ''} · ${n} cambio${n === 1 ? '' : 's'} vivo${n === 1 ? '' : 's'}${s.promoted.length ? ' · rescatada: ' + s.promoted.map(p => 'v' + p.version).join(', ') : ''}</div>
    <ol class="turns">${s.turns.map((t, i) => `<li class="${t.undone ? 'undone' : ''}${st.peek?.sid === s.id && st.peek?.k === t.draft ? ' cur' : ''}">${t.n ? `<span class="tn">#${t.n}</span>` : '<span class="tn"></span>'}<div><span class="ti">${esc(t.instruction.split('\n\n[Puntos')[0])}</span><span class="ts">${fmtDate(t.at)}${t.photos ? ` · ${t.photos} foto${t.photos > 1 ? 's' : ''}` : ''}${t.changed ? (t.undone ? ' · deshecho' : '') : ' · sin cambios'}</span></div>${t.changed ? `<button class="ghost" data-peek="${s.id}" data-k="${t.draft}" data-n="${t.n}">Ver</button>` : ''}</li>`).join('')}</ol>
    <div class="v-act">${s.stack ? `<button class="ghost" data-peek="${s.id}" data-k="${s.stack}" data-n="${fin || ''}">Ver resultado final${fin ? ` (#${fin})` : ''}</button>` : ''}${s.stack && s.status !== 'saved' ? `<button class="ghost" data-promote="${s.id}">Guardar como versión</button>` : ''}</div></li>`;
  }).join('') : '<li class="v-meta">Aún nadie ha probado cambios.</li>';
}
$('#slist').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  const s = st.adminSessions.find(x => x.id === (b.dataset.peek || b.dataset.promote)); if (!s) return;
  if (b.dataset.peek) {
    const k = +b.dataset.k, label = `Prueba #${b.dataset.n} · ${s.author}`;
    loadViewer(`/scene/d/${s.id}/${k}`, true, { sid: s.id, k, label }); updateState();
  }
  if (b.dataset.promote) {
    const k = st.peek?.sid === s.id ? st.peek.k : s.stack, live = s.turns.filter(t => t.changed && !t.undone);
    modal(`<span class="eyebrow">Rescatar prueba</span><h2>Guardar la prueba de ${esc(s.author)}</h2>
      <p>Se crea una versión nueva a partir de ${st.peek?.sid === s.id ? 'lo que estás viendo ahora' : 'su resultado final'}, basada en v${s.baseVersion}. La autoría queda a nombre de ${esc(s.author)}.</p>
      <div class="field"><label for="pTitle">Título</label><input id="pTitle" maxlength="120" value="${esc((live[0] || s.turns[0]).instruction.split('\n')[0].slice(0, 90))}"></div>
      <div class="field"><label for="pNotes">Notas (opcional)</label><textarea id="pNotes" rows="2"></textarea></div>
      <div class="row"><button class="ghost" data-close>Cancelar</button><button id="doPromote" class="primary">Guardar versión</button></div>`);
    $('#doPromote').onclick = async () => {
      $('#doPromote').disabled = true;
      try { const v = await api(`/api/admin/sessions/${s.id}/promote`, { method: 'POST', body: JSON.stringify({ draft: k, title: $('#pTitle').value, notes: $('#pNotes').value, by: st.author }) });
        closeModal(); await refreshVersions(); await refreshSessions(); toast(`Guardada como v${v.id}`); }
      catch (err) { $('#doPromote').disabled = false; toast(err.message); }
    };
  }
});
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  $('#tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  $('#vlist').hidden = b.dataset.tab !== 'v'; $('#slist').hidden = b.dataset.tab !== 's';
  if (b.dataset.tab === 's') refreshSessions();
});
$('#peekBack').onclick = () => { if (st.sess) loadViewer(`/scene/s/${st.sess.id}`, true); else viewVersion(st.view); };

$('#btnHist').onclick = () => { $('#hist').hidden = !$('#hist').hidden; };
$('#histClose').onclick = () => ($('#hist').hidden = true);

/* ---------- señalar puntos en el visor ---------- */
st.points = []; st.photos = [];
const ZONES = [['Almacén y taller', 0, 0.3, 13.46, 0.3, 16.9], ['Impresión polvo', 0, 13.67, 35.3, 8.81, 16.9], ['Procesado SLS', 0, 13.67, 17.5, 0.3, 8.71], ['Procesado HP', 0, 17.6, 26.2, 0.3, 8.71],
  ['Sala polivalente', 0, 26.3, 35.29, 0.3, 8.71], ['Baños PB', 0, 35.4, 39.19, 11.83, 16.9], ['Vestíbulo', 0, 35.4, 39.19, 8.71, 11.83], ['Sala de muestras', 0, 39.19, 43.94, 8.43, 16.9], ['Hall / showroom', 0, 35.39, 43.94, 0.3, 8.43],
  ['Resina', 1, 22.01, 26.43, 0.3, 8.71], ['Oficina de trabajadores', 1, 26.53, 35.3, 0.3, 8.71], ['Despacho de dirección', 1, 39.19, 43.94, 8.48, 16.9], ['Baño y vestuario', 1, 34, 39.91, 14.78, 16.9],
  ['Galería', 1, 35.3, 36.43, 3.79, 8.43], ['Vacío del showroom', 1, 36.43, 43.94, 0.3, 8.43], ['Mesa de juntas', 1, 35.9, 39.19, 9.6, 14.78], ['Granja Bambu', 1, 12.01, 39.19, 0.3, 16.9], ['Vacío de la nave', 1, 0, 12.01, 0, 17.2]];
const LEVELS = ['planta baja', 'planta primera', 'cubierta'];
function zoneAt(x, y, z) {
  if (x < 0 || x > 43.95 || y < 0 || y > 17.21) return 'Exterior';
  const lv = z < 3.2 ? 0 : z < 6.6 ? 1 : 2;
  if (lv === 2) return 'Cubierta / terraza';
  const q = ZONES.find(q => q[1] === lv && x >= q[2] && x <= q[3] && y >= q[4] && y <= q[5]);
  return `${q ? q[0] : 'Sin zona'} · ${LEVELS[lv]}`;
}
function faceName(n) {
  const x = n.x, y = -n.z, z = n.y;
  if (Math.abs(z) > .7) return z > 0 ? 'cara superior (suelo o tablero)' : 'cara inferior (techo)';
  return Math.abs(x) > Math.abs(y) ? (x > 0 ? 'cara que mira a +X (hacia la fachada)' : 'cara que mira a −X (hacia el fondo)') : (y > 0 ? 'cara que mira a +Y (lateral derecho)' : 'cara que mira a −Y (lateral izquierdo)');
}
function setPick(on) {
  st.mode = on ? 'pick' : null; if (on) setMeasure(false, true);
  if (!on) { cancelMeasure(); $('#btnMeasure').classList.remove('on'); }
  $('#pickTxt').textContent = 'Haz clic en la escena para marcar un punto · Esc para terminar';
  if (on) { const N = viewer.contentWindow?.__nave; if (!N?.scene) return toast('Espera a que cargue la escena para señalar.'); try { viewer.contentWindow.document.exitPointerLock?.(); } catch {} }
  $('#pick').hidden = !on; $('#btnPick').classList.toggle('on', on);
}
$('#btnPick').onclick = () => setPick(st.mode !== 'pick');
window.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#pick').hidden) { if (st.mode === 'measure') { if (st.mA) cancelMeasure(); else setMeasure(false); } else setPick(false); } });
$('#pick').addEventListener('click', e => {
  if (st.mode === 'measure') return measureClick(e);
  const w = viewer.contentWindow, N = w.__nave, T = w.THREE; if (!N?.scene) return;
  const r = viewer.getBoundingClientRect();
  const rc = new T.Raycaster(); rc.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), N.camera);
  const hit = rc.intersectObjects(N.scene.children, true).find(h => h.distance < 400 && !h.object.userData.pin && !(h.object.material?.transparent && (h.object.material.opacity ?? 1) < .45));
  if (!hit) return toast('Ahí no hay nada que señalar.');
  const p = hit.point, X = p.x, Y = -p.z, Z = p.y, idx = (st.points.at(-1)?.idx || 0) + 1;
  const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
  const mat = Object.keys(N.MAT || {}).find(k => N.MAT[k] === hit.object.material) || '';
  const c = w.document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  g.fillStyle = '#1ec29b'; g.beginPath(); g.arc(64, 64, 54, 0, 7); g.fill(); g.lineWidth = 9; g.strokeStyle = '#fff'; g.stroke();
  g.fillStyle = '#00140e'; g.font = 'bold 66px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(idx), 64, 69);
  const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.renderOrder = 999; sp.userData.pin = true; sp.scale.set(.34, .34, 1); sp.position.copy(p); if (n) sp.position.addScaledVector(n, .14); N.scene.add(sp);
  st.points.push({ idx, X, Y, Z, zone: zoneAt(X, Y, Z), mat, face: n ? faceName(n) : '', sprite: sp });
  renderPins(); msg.focus();
});
/* ---------- herramienta MEDIR ---------- */
st.meas = []; st.mA = null; st.mTmp = null;
const fm = n => n.toFixed(2).replace('.', ',');
function setMeasure(on, silent) {
  if (on) { const N = viewer.contentWindow?.__nave; if (!N?.scene) return toast('Espera a que cargue la escena para medir.'); try { viewer.contentWindow.document.exitPointerLock?.(); } catch {} }
  if (!on) cancelMeasure();
  if (on) { st.mode = 'measure'; setPick0(); $('#pickTxt').textContent = 'Medir: clic en el punto de partida y luego en el de llegada · Esc para terminar'; }
  else if (st.mode === 'measure') st.mode = null;
  $('#btnMeasure').classList.toggle('on', on);
  if (!silent) { $('#pick').hidden = !on; }
  else if (on) $('#pick').hidden = false;
}
function setPick0() { $('#btnPick').classList.remove('on'); $('#pick').hidden = false; }
$('#btnMeasure').onclick = () => setMeasure(st.mode !== 'measure');
function rayAt(e) {
  const w = viewer.contentWindow, N = w.__nave, T = w.THREE, r = viewer.getBoundingClientRect();
  const rc = new T.Raycaster(); rc.setFromCamera(new T.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), N.camera);
  const hit = rc.intersectObjects(N.scene.children, true).find(h => h.distance < 400 && !h.object.userData.pin && !(h.object.material?.transparent && (h.object.material.opacity ?? 1) < .45));
  return hit ? { p: hit.point.clone(), w, N, T } : null;
}
function mkLabel(T, text) {
  const c = document.createElement('canvas'); c.width = 320; c.height = 110; const g = c.getContext('2d');
  g.fillStyle = 'rgba(0,20,14,.92)'; g.strokeStyle = '#1ec29b'; g.lineWidth = 6;
  g.beginPath(); g.roundRect ? g.roundRect(6, 6, 308, 98, 26) : g.rect(6, 6, 308, 98); g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.font = '700 58px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 160, 57);
  const sp = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(c), depthTest: false, transparent: true }));
  sp.renderOrder = 1000; sp.userData.pin = true; return sp;
}
function mkSeg(T, a, b) {
  const grp = new T.Group(); grp.userData.pin = true;
  const mat = new T.MeshBasicMaterial({ color: 0x1ec29b, depthTest: false, transparent: true });
  const cyl = new T.Mesh(new T.CylinderGeometry(.014, .014, 1, 6), mat); cyl.userData.pin = true; cyl.renderOrder = 998; grp.add(cyl);
  for (let i = 0; i < 2; i++) { const s = new T.Mesh(new T.SphereGeometry(.05, 12, 8), mat); s.userData.pin = true; s.renderOrder = 998; grp.add(s); }
  const lab = mkLabel(T, '0,00 m'); grp.add(lab); grp.userData.lab = lab; grp.userData.T = T;
  setSeg(grp, a, b); return grp;
}
function setSeg(grp, a, b) {
  const T = grp.userData.T, d = b.clone().sub(a), len = d.length(), [cyl, s1, s2] = grp.children;
  cyl.position.copy(a).add(b).multiplyScalar(.5); cyl.scale.set(1, Math.max(len, .0001), 1);
  if (len > 1e-6) cyl.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.clone().normalize());
  s1.position.copy(a); s2.position.copy(b);
  const lab = grp.userData.lab; lab.position.copy(a).add(b).multiplyScalar(.5); lab.position.y += .22;
  const k = Math.min(1.4, Math.max(.5, len * .09 + .45)); lab.scale.set(.95 * k, .33 * k, 1);
  const old = lab.material.map; lab.material.map = mkLabel(T, fm(len) + ' m').material.map; old?.dispose();
}
function measureClick(e) {
  const r = rayAt(e); if (!r) return toast('Ahí no hay nada que medir.');
  if (!st.mA) { st.mA = r.p; st.mTmp = mkSeg(r.T, r.p, r.p); r.N.scene.add(st.mTmp); return; }
  const a = st.mA, b = r.p, grp = st.mTmp; setSeg(grp, a, b); st.mA = null; st.mTmp = null;
  const idx = (st.meas.at(-1)?.idx || 0) + 1;
  st.meas.push({ idx, grp, d: b.clone().sub(a), len: a.distanceTo(b) }); renderMeas();
}
$('#pick').addEventListener('mousemove', e => {
  if (st.mode !== 'measure' || !st.mA || st.mMoving) return; st.mMoving = true;
  requestAnimationFrame(() => { st.mMoving = false; if (!st.mA || !st.mTmp) return; const r = rayAt(e); if (r) setSeg(st.mTmp, st.mA, r.p); });
});
function cancelMeasure() { if (st.mTmp) { try { st.mTmp.parent?.remove(st.mTmp); } catch {} } st.mA = null; st.mTmp = null; }
function clearMeas() { cancelMeasure(); for (const m of st.meas) { try { m.grp.parent?.remove(m.grp); } catch {} } st.meas = []; renderMeas(); }
function renderMeas() {
  // En la escena, X es el eje largo, Y el ancho y Z la altura: la escena usa (x, z, -y).
  $('#meas').innerHTML = st.meas.map(m => `<span class="pin m"><b>${m.idx}</b><span>${fm(m.len)} m · largo ${fm(Math.abs(m.d.x))} · ancho ${fm(Math.abs(m.d.z))} · alto ${fm(Math.abs(m.d.y))}</span><button type="button" data-unmeas="${m.idx}" aria-label="Quitar medida ${m.idx}">✕</button></span>`).join('')
    + (st.meas.length > 1 ? '<span class="pin clear" data-clearmeas>Borrar todas</span>' : '');
}
$('#meas').addEventListener('click', e => {
  if (e.target.closest('[data-clearmeas]')) return clearMeas();
  const b = e.target.closest('[data-unmeas]'); if (!b) return;
  const i = st.meas.findIndex(m => m.idx === +b.dataset.unmeas); if (i < 0) return;
  try { st.meas[i].grp.parent?.remove(st.meas[i].grp); } catch {} st.meas.splice(i, 1); renderMeas();
});
function renderPins() {
  $('#pins').innerHTML = st.points.map(p => `<span class="pin"><b>${p.idx}</b><span>${esc(p.zone)} · X ${p.X.toFixed(2)} Y ${p.Y.toFixed(2)} Z ${p.Z.toFixed(2)}${p.mat ? ' · ' + esc(p.mat) : ''}</span><button type="button" data-unpin="${p.idx}" aria-label="Quitar punto ${p.idx}">✕</button></span>`).join('');
}
$('#pins').addEventListener('click', e => {
  const b = e.target.closest('[data-unpin]'); if (!b) return;
  const i = st.points.findIndex(p => p.idx === +b.dataset.unpin); if (i < 0) return;
  try { st.points[i].sprite.parent?.remove(st.points[i].sprite); } catch {}
  st.points.splice(i, 1); renderPins();
});
function clearPins() { for (const p of st.points) { try { p.sprite.parent?.remove(p.sprite); } catch {} } st.points = []; renderPins(); }
function capture() {
  const N = viewer.contentWindow.__nave; N.renderer.render(N.scene, N.camera);
  const src = N.renderer.domElement, W = 1024, H = Math.round(src.height / src.width * W);
  const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').drawImage(src, 0, 0, W, H);
  return c.toDataURL('image/jpeg', .82);
}

/* ---------- fotos de referencia ---------- */
function shrink(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', .85)); };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('No se ha podido leer la imagen.')); };
    img.src = url;
  });
}
async function addPhotos(files) {
  for (const f of [...files].filter(f => f.type.startsWith('image/'))) {
    if (st.photos.length >= 4) { toast('Máximo 4 fotos por mensaje.'); break; }
    try { st.photos.push(await shrink(f)); } catch (e) { toast(e.message); }
  }
  renderThumbs(); msg.focus();
}
function renderThumbs() { $('#thumbs').innerHTML = st.photos.map((p, i) => `<span class="thumb"><img src="${p}" alt="Foto ${i + 1}"><button type="button" data-unphoto="${i}" aria-label="Quitar foto ${i + 1}">✕</button></span>`).join(''); }
$('#thumbs').addEventListener('click', e => { const b = e.target.closest('[data-unphoto]'); if (b) { st.photos.splice(+b.dataset.unphoto, 1); renderThumbs(); } });
$('#btnAttach').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = e => { addPhotos(e.target.files); e.target.value = ''; };
msg.addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addPhotos(fs); } });
const dock = $('#dock');
['dragenter', 'dragover'].forEach(ev => dock.addEventListener(ev, e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dock.classList.add('drop'); } }));
['dragleave', 'drop'].forEach(ev => dock.addEventListener(ev, () => dock.classList.remove('drop')));
dock.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addPhotos(e.dataTransfer.files); } });

/* ---------- modales: acceso y nombre ---------- */
function modal(html, wide) { $('#modalBody').innerHTML = html; $('#modal .sheet').classList.remove('xl'); $('#modal .sheet').classList.toggle('wide', !!wide); $('#modal').hidden = false; $('#modal').querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal); $('#modal').querySelector('input,textarea')?.focus(); }
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' && !$('#modal').dataset.locked) closeModal(); });
function showLogin(err) {
  return new Promise(res => {
    $('#modal').dataset.locked = '1';
    modal(`<span class="eyebrow">Additium3D · acceso</span><h2>Nave Da Vinci 16</h2><p>Visor 3D de la nueva sede. Escribe tu nombre: quedará registrado en cada versión que guardes.</p>
      <div class="field"><label for="lName">Tu nombre</label><input id="lName" maxlength="60" value="${esc(st.author)}" autocomplete="name"></div>
      ${st.cfg?.requiresCode ? `<div class="field"><label for="lCode">Código de acceso</label><input id="lCode" type="password" value="${esc(st.code)}"></div>` : ''}
      ${err ? `<p class="hint">${esc(err)}</p>` : ''}<div class="row"><button id="lGo" class="primary">Entrar</button></div>`);
    const go = async () => {
      const name = $('#lName').value.trim(); if (!name) return $('#lName').focus();
      const code = $('#lCode')?.value || '';
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (!r.ok) return showLogin('El código de acceso no es válido.').then(res);
      const lr = await r.json().catch(() => ({})); if (st.cfg) st.cfg.admin = !!lr.admin; applyAdmin();
      st.author = name; st.code = code; store.set('nave.author', name); store.set('nave.code', code);
      delete $('#modal').dataset.locked; closeModal(); updateState(); res();
    };
    $('#lGo').onclick = go; $('#modalBody').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}
const askName = () => showLogin();
function renderFoot() {
  const b = st.cfg?.build || {}, latest = st.versions.at(-1)?.id, cur = st.peek ? '' : st.sess ? `borrador sobre v${st.sess.baseVersion}` : st.view ? `viendo v${st.view}` : '';
  $('#build').innerHTML = `Web <b>v${esc(b.version || '?')}</b>${b.commit ? ` · commit ${esc(b.commit)}` : ''} · última versión de la nave <b>v${latest ?? '—'}</b>${cur ? ` · ${esc(cur)}` : ''}`;
  $('#adm').innerHTML = st.cfg?.admin ? '<span class="on">● Modo administrador</span>' : '<button id="admLink" type="button">Acceso administrador</button>';
  $('#admLink')?.addEventListener('click', adminLogin);
}
function adminLogin() {
  if (!st.cfg?.adminConfigured) return modal('<span class="eyebrow">Administrador</span><h2>Falta configurar el código</h2><p>El servidor no tiene la variable <b>ADMIN_CODE</b>. Añádela en Render → Environment y espera a que se reinicie el servicio.</p><div class="row"><button class="ghost" data-close>Cerrar</button></div>');
  modal('<span class="eyebrow">Administrador</span><h2>Código de administrador</h2><p>Con él verás las pruebas de todo el equipo, paso a paso, y podrás rescatarlas como versión.</p><div class="field"><label for="aCode">Código</label><input id="aCode" type="password" autocomplete="off"></div><p id="aErr" class="hint" hidden></p><div class="row"><button class="ghost" data-close>Cancelar</button><button id="aGo" class="primary">Entrar</button></div>');
  const go = async () => {
    const code = $('#aCode').value;
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.admin) { $('#aErr').hidden = false; $('#aErr').textContent = 'Ese no es el código de administrador.'; return; }
    st.code = code; store.set('nave.code', code); st.cfg.admin = true; closeModal(); applyAdmin(); renderFoot(); $('#hist').hidden = false; $('#tabs [data-tab="s"]').click(); toast('Modo administrador activado');
  };
  $('#aGo').onclick = go; $('#aCode').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
}
function applyAdmin() { const a = !!st.cfg?.admin; $('#tabs').hidden = !a; $('#btnHist').firstChild.textContent = a ? 'Historial y pruebas ' : 'Historial '; if (a) refreshSessions(); else { $('#slist').hidden = true; $('#vlist').hidden = false; } renderFoot(); }
$('#btnWho').onclick = () => showLogin();

/* ---------- fin de sesión: pedir guardar ---------- */
window.addEventListener('beforeunload', e => { if (st.sess && pending()) { e.preventDefault(); e.returnValue = ''; } });
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => (st.lastActivity = Date.now())));
setInterval(() => {
  if (st.sess && pending() && !st.busy && $('#modal').hidden && Date.now() - st.lastActivity > 8 * 60e3) {
    st.lastActivity = Date.now(); openSave('Llevas un rato sin hacer cambios. ¿Guardamos esta sesión como una versión nueva?');
  }
}, 30e3);

/* ---------- arranque ---------- */
(async function init() {
  st.cfg = await fetch('/api/config').then(r => r.json());
  if (st.cfg.requiresCode && st.code && !st.cfg.authed) { const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: st.code }) }); if (r.ok) { st.cfg.authed = true; st.cfg.admin = !!(await r.json().catch(() => ({}))).admin; } else st.code = ''; }
  if ((st.cfg.requiresCode && !st.cfg.authed) || !st.author) await showLogin();
  applyAdmin(); await refreshVersions();
  const sid = store.get('nave.sid');
  if (sid) { try { const s = await api(`/api/sessions/${sid}`); if (s.status === 'open') st.sess = s; } catch {} }
  if (st.sess) { st.view = st.sess.baseVersion; replayTurns(); loadViewer(`/scene/s/${st.sess.id}`); add('msg bot', `<span class="meta">Sesión recuperada</span>Tienes ${pending()} cambios sin guardar sobre v${st.sess.baseVersion}. Sigue pidiendo cambios o guarda la versión.`); }
  else { emptyState(); viewVersion(st.versions.at(-1).id); }
  if (st.cfg.mock) add('msg bot', '<span class="meta">Modo demostración</span>El servidor no tiene ANTHROPIC_API_KEY configurada: el asistente solo añade un bloque de prueba para comprobar el flujo de versiones.');
  updateState();
})();
