'use strict';
/* Vistas generales · fotografía. Independiente del visor 3D: fotografía la escena de cualquier versión y guarda las imágenes. */
const VIEWS = [
  { key: 'fachada', title: 'Fachada', pose: [60, 8.6, .6, -1, 0, .14], fov: 56 },
  { key: 'hall', title: 'Hall y showroom', pose: [43.25, 5.3, 0, -1, -.32, .03], fov: 70 },
  { key: 'muestras', title: 'Sala de muestras', pose: [39.8, 9.4, 0, 1, .75, 0], fov: 70 },
  { key: 'almacen', title: 'Almacén y taller', pose: [7.4, 9.9, 0, -1, .42, .1], fov: 70 },
  { key: 'polvo', title: 'Impresión polvo · HP y Fuse', pose: [34.4, 12.3, 0, -1, .32, .02], fov: 70 },
  { key: 'acabados', title: 'Procesado y acabados', pose: [17.8, 8.3, 0, 1, -.9, .05], fov: 75 },
  { key: 'bambu', title: 'Granja Bambu', pose: [33.4, 11.6, 3.35, -1, .55, 0], fov: 70 },
  { key: 'oficina', title: 'Oficina de trabajadores', pose: [34.9, 7.9, 3.35, -1, -.62, -.05], fov: 70 },
  { key: 'despacho', title: 'Despacho de dirección', pose: [39.6, 9.0, 3.35, 3.9, 7.5, 0], fov: 70 },
  { key: 'terraza', title: 'Terraza', pose: [32.6, 15.4, 6.85, 1, -.55, .03], fov: 70 }
];
const RES = { hd: [1920, 1080], qhd: [2560, 1440], uhd: [3840, 2160] };
const gal = { ver: null, photos: [], busy: false, sv: null, items: [] };
const gslug = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'vista';
const poseOf = v => { const [x, y, f, dx, dy, p] = v.pose; return [x, y, f, Math.atan2(-dx, dy), p]; };

/* ---------- pestañas ---------- */
function setSection(sec) {
  if (sec === 'foto' && st.busy) return toast('Espera a que el asistente termine el cambio en curso.');
  try { setPick(false); } catch {}
  document.body.classList.toggle('view-foto', sec === 'foto');
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.sec === sec));
  $('#gallery').hidden = sec !== 'foto';
  if (sec === 'foto') { fillVersions(); refreshPhotos(); }
  else { try { $('#viewing').textContent; updateState(); } catch {} }
}
document.querySelector('.seg').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setSection(b.dataset.sec); });
function fillVersions() {
  const sel = $('#galVer'), keep = gal.ver ?? st.versions.at(-1)?.id;
  sel.innerHTML = [...st.versions].reverse().map(v => `<option value="${v.id}">v${v.id} · ${esc(v.title).slice(0, 60)}</option>`).join('');
  gal.ver = st.versions.some(v => v.id === keep) ? keep : st.versions.at(-1)?.id; sel.value = gal.ver;
  $('#viewing').textContent = 'Vistas generales · fotografía';
}
$('#galVer').onchange = e => { gal.ver = +e.target.value; refreshPhotos(); };

/* ---------- galería ---------- */
async function refreshPhotos() {
  try { gal.photos = await api(`/api/photos?version=${gal.ver}`); } catch (e) { if (e.message !== 'auth') toast(e.message); gal.photos = []; }
  renderGallery();
}
function card(p, n) {
  const d = new Date(p.createdAt);
  return `<article class="ph"><button class="ph-img" data-open="${p.id}" aria-label="Ampliar ${esc(p.title)}"><img loading="lazy" src="/photo/${p.id}?thumb=1" data-full="/photo/${p.id}" onerror="this.onerror=null;this.src=this.dataset.full" alt="${esc(p.title)}"></button>
    <div class="ph-meta"><b>${n ? String(n).padStart(2, '0') + ' · ' : ''}${esc(p.title)}</b><span>v${p.version} · ${esc(p.author || '')} · ${fmtDate(d)}${p.w ? ` · ${p.w}×${p.h}` : ''}</span></div>
    <div class="ph-act"><a class="ghost" href="/photo/${p.id}?dl=1" download>Descargar</a>${p.kind === 'std' ? `<button class="ghost" data-retake="${p.key}">Repetir</button>` : ''}<button class="ghost x" data-del="${p.id}" aria-label="Borrar">✕</button></div></article>`;
}
function renderGallery() {
  const std = VIEWS.map((v, i) => ({ v, i, p: gal.photos.find(p => p.kind === 'std' && p.key === v.key) }));
  const custom = gal.photos.filter(p => p.kind !== 'std');
  gal.items = [...std.filter(x => x.p).map(x => x.p), ...custom];
  const have = std.filter(x => x.p).length;
  $('#galCount').textContent = `${have}/${VIEWS.length} vistas · ${custom.length} nuevas`;
  $('#galZip').disabled = gal.busy || !gal.items.length;
  $('#galGen').textContent = have ? 'Rehacer las 10 vistas' : 'Generar las 10 vistas';
  $('#galStd').innerHTML = std.map(x => x.p ? card(x.p, x.i + 1)
    : `<article class="ph empty"><div class="ph-img ph-ph"><span>Sin generar</span></div><div class="ph-meta"><b>${String(x.i + 1).padStart(2, '0')} · ${esc(x.v.title)}</b><span>v${gal.ver}</span></div><div class="ph-act"><button class="ghost" data-retake="${x.v.key}" ${gal.busy ? 'disabled' : ''}>Generar</button></div></article>`).join('');
  $('#galCustomHead').hidden = !custom.length;
  $('#galCustom').innerHTML = custom.map(p => card(p, 0)).join('');
}

/* ---------- fotografiar ---------- */
function loadShooter(ver) {
  const f = $('#shooter');
  if (gal.sv === ver && f.contentWindow?.__nave?.scene) return Promise.resolve(f.contentWindow);
  return new Promise((res, rej) => {
    const t = setTimeout(() => { removeEventListener('message', on); rej(new Error('La escena tarda demasiado en cargar.')); }, 120000);
    const on = e => { if (e.source !== f.contentWindow) return;
      if (e.data?.type === 'scene-ready') { clearTimeout(t); removeEventListener('message', on); gal.sv = ver; res(f.contentWindow); }
      if (e.data?.type === 'scene-error') { clearTimeout(t); removeEventListener('message', on); rej(new Error('Error en la escena: ' + e.data.message)); } };
    addEventListener('message', on); gal.sv = null; f.src = `/scene/v/${ver}?embed=1&t=${Date.now()}`;
  });
}
// Renderiza la escena de la ventana w a W×H píxeles y devuelve la imagen y una miniatura.
function snap(w, pose, fov, W, H) {
  const N = w.__nave, cam = N.camera, r = N.renderer;
  if (pose) N.setPose(pose);
  const old = { fov: cam.fov, asp: cam.aspect, pr: r.getPixelRatio(), size: r.getSize(new w.THREE.Vector2()) };
  if (fov) cam.fov = fov; cam.aspect = W / H; cam.updateProjectionMatrix(); r.setPixelRatio(1); r.setSize(W, H, false);
  r.render(N.scene, cam);
  const image = r.domElement.toDataURL('image/jpeg', .9), fovUsed = cam.fov;
  const c = document.createElement('canvas'); c.width = 640; c.height = Math.round(640 * H / W); c.getContext('2d').drawImage(r.domElement, 0, 0, c.width, c.height);
  const thumb = c.toDataURL('image/jpeg', .82);
  r.setPixelRatio(old.pr); r.setSize(old.size.x, old.size.y, false); cam.fov = old.fov; cam.aspect = old.asp; cam.updateProjectionMatrix();
  return { image, thumb, fov: fovUsed, pose: N.getPose() };
}
function progress(txt, pct) { const el = $('#galProg'); el.hidden = txt == null; if (txt != null) { el.querySelector('span').textContent = txt; el.querySelector('i').style.width = (pct || 0) + '%'; } }
async function shootViews(list) {
  if (gal.busy || !list.length) return;
  if (!st.author) await askName();
  gal.busy = true; renderGallery(); const [W, H] = RES[$('#galRes').value] || RES.hd;
  try {
    progress('Cargando la escena de v' + gal.ver + '…', 2);
    const w = await loadShooter(gal.ver); await new Promise(r => setTimeout(r, 400));
    for (let i = 0; i < list.length; i++) {
      const v = list[i]; progress(`Fotografiando ${i + 1}/${list.length} · ${v.title}`, 5 + 95 * i / list.length);
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
      const s = snap(w, poseOf(v), v.fov, W, H);
      await api('/api/photos', { method: 'POST', body: JSON.stringify({ version: gal.ver, key: v.key, title: v.title, kind: 'std', author: st.author, image: s.image, thumb: s.thumb, w: W, h: H, pose: [...poseOf(v), v.fov] }) });
      await refreshPhotos();
    }
    toast(list.length > 1 ? 'Vistas generadas' : 'Vista generada');
  } catch (e) { if (e.message !== 'auth') toast(e.message); }
  gal.busy = false; progress(null); renderGallery(); $('#shooter').src = 'about:blank'; gal.sv = null;
}
$('#galGen').onclick = () => shootViews(VIEWS);
$('#galStd').addEventListener('click', e => { const b = e.target.closest('[data-retake]'); if (b) shootViews(VIEWS.filter(v => v.key === b.dataset.retake)); });

/* ---------- borrar, ampliar, descargar ---------- */
async function delPhoto(b) {
  if (b.dataset.arm !== '1') { b.dataset.arm = '1'; b.textContent = '¿Borrar?'; setTimeout(() => { b.dataset.arm = ''; b.textContent = '✕'; }, 3000); return; }
  try { await api(`/api/photos/${b.dataset.del}`, { method: 'DELETE' }); await refreshPhotos(); toast('Foto borrada'); } catch (e) { toast(e.message); }
}
function openLB(id) {
  const i = gal.items.findIndex(p => p.id === +id); if (i < 0) return; gal.lb = i;
  const p = gal.items[i], lb = $('#lb');
  lb.hidden = false; lb.querySelector('img').src = `/photo/${p.id}`; $('#lbTitle').textContent = `${p.title} · v${p.version}`;
  $('#lbDl').href = `/photo/${p.id}?dl=1`; $('#lbPos').textContent = `${i + 1} / ${gal.items.length}`;
}
const stepLB = d => { if (!gal.items.length) return; openLB(gal.items[(gal.lb + d + gal.items.length) % gal.items.length].id); };
function closeLB() { $('#lb').hidden = true; $('#lb img').src = ''; }
$('#gallery').addEventListener('click', e => {
  const o = e.target.closest('[data-open]'); if (o) return openLB(o.dataset.open);
  const d = e.target.closest('[data-del]'); if (d) delPhoto(d);
});
$('#lbPrev').onclick = () => stepLB(-1); $('#lbNext').onclick = () => stepLB(1); $('#lbClose').onclick = closeLB;
$('#lb').addEventListener('click', e => { if (e.target.id === 'lb') closeLB(); });
addEventListener('keydown', e => { if ($('#lb').hidden) return; if (e.key === 'Escape') closeLB(); if (e.key === 'ArrowLeft') stepLB(-1); if (e.key === 'ArrowRight') stepLB(1); });

/* ---------- ZIP (sin compresión: los JPG ya van comprimidos) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xFFFFFFFF; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const d = new Date(), dt = ((d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate()) & 0xFFFF, tm = (d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1) & 0xFFFF;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, tm, true); h.setUint16(12, dt, true);
    h.setUint32(14, crc, true); h.setUint32(18, sz, true); h.setUint32(22, sz, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, nm, f.data);
    const c = new DataView(new ArrayBuffer(46)); c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, tm, true); c.setUint16(14, dt, true);
    c.setUint32(16, crc, true); c.setUint32(20, sz, true); c.setUint32(24, sz, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cen.push(c.buffer, nm); off += 30 + nm.length + sz;
  }
  const csz = cen.reduce((a, b) => a + b.byteLength, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csz, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, e.buffer], { type: 'application/zip' });
}
$('#galZip').onclick = async () => {
  if (!gal.items.length || gal.busy) return; gal.busy = true; renderGallery();
  try {
    const files = [];
    for (let i = 0; i < gal.items.length; i++) {
      const p = gal.items[i]; progress(`Preparando el ZIP ${i + 1}/${gal.items.length}`, 100 * i / gal.items.length);
      const r = await fetch(`/photo/${p.id}`, { headers: { 'x-access-code': st.code } }); if (!r.ok) throw new Error('No se ha podido descargar ' + p.title);
      files.push({ name: `${String(i + 1).padStart(2, '0')}-${gslug(p.title)}.jpg`, data: new Uint8Array(await r.arrayBuffer()) });
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = `AdditiumDaVinci16_vistas_v${gal.ver}.zip`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { toast(e.message); }
  gal.busy = false; progress(null); renderGallery();
};

/* ---------- vista nueva: te mueves por la nave y fotografías lo que encuadres ---------- */
$('#galNew').onclick = async () => {
  if (gal.busy) return; if (!st.author) await askName();
  modal(`<span class="eyebrow">Vista nueva · v${gal.ver}</span><h2>Encuadra y haz la foto</h2>
    <p class="hint-s">Haz clic en la escena y muévete con W A S D y el ratón (Esc suelta el ratón). Los botones numerados te llevan a las zonas principales. La foto sale con exactamente este encuadre.</p>
    <div class="shotwrap"><iframe id="liveShot" title="Escena para fotografiar" allow="fullscreen"></iframe><div class="shotload" id="shotLoad">Cargando escena…</div></div>
    <div class="shotbar"><div class="field"><label for="nvTitle">Nombre de la vista</label><input id="nvTitle" maxlength="80" placeholder="Ej.: Entrada hacia la granja de Bambu"></div>
      <div class="field"><label for="nvFov">Ángulo (zoom)</label><input id="nvFov" type="range" min="40" max="95" value="70"></div></div>
    <div class="row"><button class="ghost" data-close>Cancelar</button><button id="nvGo" class="primary" disabled>Hacer foto</button></div>`);
  $('#modal .sheet').classList.add('xl');
  const f = $('#liveShot'), go = $('#nvGo');
  const on = e => { if (e.source !== f.contentWindow) return;
    if (e.data?.type === 'scene-ready') { $('#shotLoad')?.remove(); go.disabled = false; try { f.contentWindow.__nave.camera.fov = +$('#nvFov').value; f.contentWindow.__nave.camera.updateProjectionMatrix(); } catch {} removeEventListener('message', on); }
    if (e.data?.type === 'scene-error') { $('#shotLoad').textContent = 'Error en la escena: ' + e.data.message; removeEventListener('message', on); } };
  addEventListener('message', on); f.src = `/scene/v/${gal.ver}?embed=1&t=${Date.now()}`;
  $('#nvFov').oninput = e => { try { const c = f.contentWindow.__nave.camera; c.fov = +e.target.value; c.updateProjectionMatrix(); } catch {} };
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Fotografiando…'; const [W, H] = RES[$('#galRes').value] || RES.hd;
    try {
      const s = snap(f.contentWindow, null, null, W, H), title = $('#nvTitle').value.trim() || 'Vista personalizada';
      const r = await api('/api/photos', { method: 'POST', body: JSON.stringify({ version: gal.ver, key: 'custom', title, kind: 'custom', author: st.author, image: s.image, thumb: s.thumb, w: W, h: H, pose: [...s.pose, s.fov] }) });
      closeModal(); await refreshPhotos(); openLB(r.id); toast('Foto guardada en la galería');
    } catch (e) { go.disabled = false; go.textContent = 'Hacer foto'; toast(e.message); }
  };
};
