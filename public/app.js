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
function loadViewer(url, keepPose) {
  if (keepPose) { try { st.pose = viewer.contentWindow.__nave.getPose(); } catch { st.pose = null; } } else st.pose = null;
  $('#loading').hidden = false; $('#sceneErr').hidden = true;
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
  $('#viewing').textContent = st.sess ? `Borrador sobre v${st.sess.baseVersion} · ${v.title || ''}` : `v${v.id ?? '—'} · ${v.title || ''}`;
  $('#state').textContent = st.busy ? 'El asistente está aplicando el cambio…'
    : st.sess ? `Sesión de cambios sobre v${st.sess.baseVersion} · ${n} ${n === 1 ? 'cambio' : 'cambios'} sin guardar`
    : `Viendo v${v.id ?? '—'}${v.id === st.versions.at(-1)?.id ? ' (la más reciente)' : ''} · escribe abajo para empezar una sesión de cambios`;
  $('#dot').className = 'dot' + (st.busy ? ' busy' : st.sess ? ' live' : '');
  $('#btnUndo').disabled = st.busy || !st.sess || !st.sess.stack;
  $('#btnSave').disabled = st.busy || !st.sess || !n;
  $('#btnDiscard').disabled = st.busy || !st.sess;
  $('#btnSend').disabled = st.busy;
  $('#who').textContent = st.author || 'Sin nombre';
  $('#vcount').textContent = st.versions.length;
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
async function send(text) {
  text = text.trim(); if (!text || st.busy) return;
  st.lastActivity = Date.now();
  try { await ensureSession(); } catch (e) { if (e.message !== 'auth') add('msg err', esc(e.message)); return; }
  add('msg user', esc(text));
  const steps = add('steps', ''); let live = null;
  const step = t => { live?.classList.remove('live'); live = document.createElement('div'); live.className = 'live'; live.textContent = t; steps.appendChild(live); log.scrollTop = log.scrollHeight; };
  st.busy = true; updateState(); step('enviando');
  try {
    const r = await fetch(`/api/sessions/${st.sess.id}/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-access-code': st.code }, body: JSON.stringify({ text }) });
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
          st.sess = await api(`/api/sessions/${st.sess.id}`);
          if (ev.changed) { st.autoFixed = text.startsWith('El visor da este error') ? st.autoFixed : false; loadViewer(`/scene/s/${st.sess.id}`, true); }
        }
        if (ev.type === 'error') add('msg err', `<span class="meta">Error</span>${esc(ev.text)}`);
      }
    }
  } catch (e) { if (e.message !== 'auth') add('msg err', `<span class="meta">Error</span>${esc(e.message)}`); }
  live?.classList.remove('live'); st.busy = false; st.lastActivity = Date.now(); updateState();
}
$('#composer').addEventListener('submit', e => { e.preventDefault(); const t = msg.value; msg.value = ''; autosize(); send(t); });
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
  if (b.dataset.view) { if (st.sess) return toast('Guarda o descarta la sesión abierta antes de cambiar de versión.'); viewVersion(+b.dataset.view); }
  if (b.dataset.branch) { viewVersion(+b.dataset.branch); $('#hist').hidden = true; msg.focus(); toast(`Tu próximo mensaje empezará una sesión sobre v${b.dataset.branch}`); }
  if (b.dataset.diff) {
    const t = await api(`/api/versions/${b.dataset.diff}/diff`);
    const html = esc(t).split('\n').map(l => `<span class="${l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'd' : l.startsWith('@@') ? 'h' : ''}">${l}</span>`).join('\n');
    modal(`<span class="eyebrow">Trazabilidad</span><h2>Cambios de v${b.dataset.diff}</h2><pre class="diff">${html}</pre><div class="row"><button class="ghost" data-close>Cerrar</button></div>`, true);
  }
});
$('#btnHist').onclick = () => { $('#hist').hidden = !$('#hist').hidden; };
$('#histClose').onclick = () => ($('#hist').hidden = true);

/* ---------- modales: acceso y nombre ---------- */
function modal(html, wide) { $('#modalBody').innerHTML = html; $('#modal .sheet').classList.toggle('wide', !!wide); $('#modal').hidden = false; $('#modal').querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal); $('#modal').querySelector('input,textarea')?.focus(); }
function closeModal() { $('#modal').hidden = true; }
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
      st.author = name; st.code = code; store.set('nave.author', name); store.set('nave.code', code);
      delete $('#modal').dataset.locked; closeModal(); updateState(); res();
    };
    $('#lGo').onclick = go; $('#modalBody').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}
const askName = () => showLogin();
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
  if (st.cfg.requiresCode && st.code && !st.cfg.authed) { const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: st.code }) }); if (r.ok) st.cfg.authed = true; else st.code = ''; }
  if ((st.cfg.requiresCode && !st.cfg.authed) || !st.author) await showLogin();
  await refreshVersions();
  const sid = store.get('nave.sid');
  if (sid) { try { const s = await api(`/api/sessions/${sid}`); if (s.status === 'open') st.sess = s; } catch {} }
  if (st.sess) { st.view = st.sess.baseVersion; replayTurns(); loadViewer(`/scene/s/${st.sess.id}`); add('msg bot', `<span class="meta">Sesión recuperada</span>Tienes ${pending()} cambios sin guardar sobre v${st.sess.baseVersion}. Sigue pidiendo cambios o guarda la versión.`); }
  else { emptyState(); viewVersion(st.versions.at(-1).id); }
  if (st.cfg.mock) add('msg bot', '<span class="meta">Modo demostración</span>El servidor no tiene ANTHROPIC_API_KEY configurada: el asistente solo añade un bloque de prueba para comprobar el flujo de versiones.');
  updateState();
})();
