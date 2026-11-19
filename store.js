// Almacenamiento: Supabase (si hay SUPABASE_URL) o carpeta local (DATA_DIR) para desarrollo.
import fs from 'node:fs';
import path from 'node:path';

const clean = v => String(v || '').trim().replace(/^["']+|["']+$/g, '').trim();
const SB_URL = clean(process.env.SUPABASE_URL).replace(/\/+(rest\/v1)?\/*$/, '');
const SB_KEY = clean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
const PMETA = 'id,version,view_key,title,kind,author,created_at,w,h,bytes';
const toP = r => r && ({ id: r.id, version: r.version, key: r.view_key, title: r.title, kind: r.kind, author: r.author, createdAt: r.created_at, w: r.w, h: r.h, bytes: r.bytes });
const META = 'id,parent,title,notes,author,created_at,session_id,instructions,added,removed';

const toV = r => r && ({ id: r.id, parent: r.parent, title: r.title, notes: r.notes, author: r.author, createdAt: r.created_at, session: r.session_id, instructions: r.instructions || [], added: r.added, removed: r.removed });
const toS = r => r && ({ id: r.id, author: r.author, baseVersion: r.base_version, status: r.status, stack: r.stack, turns: r.turns || [], history: r.history || [], savedAs: r.saved_as, promoted: r.promoted || [], createdAt: r.created_at, updatedAt: r.updated_at });
const fromS = s => ({ id: s.id, author: s.author, base_version: s.baseVersion, status: s.status, stack: s.stack, turns: s.turns, history: s.history, saved_as: s.savedAs ?? null, promoted: s.promoted || [], updated_at: new Date().toISOString() });

function supabaseStore() {
  async function q(p, { method = 'GET', body, prefer } = {}) {
    let r;
    try { r = await fetch(`${SB_URL}/rest/v1/${p}`, { method, body: body && JSON.stringify(body),
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) } }); }
    catch (e) { throw new Error(`no se puede conectar con ${SB_URL || '(SUPABASE_URL vacía)'}: ${e.cause?.code || e.cause?.message || e.message}. Revisa que SUPABASE_URL sea exactamente https://<ref>.supabase.co`); }
    if (!r.ok) { const t = await r.text(); const e = new Error(`Supabase ${r.status}${r.status === 401 ? ' (clave SUPABASE_SERVICE_ROLE_KEY incorrecta)' : ''}: ${t.slice(0, 300)}`); e.status = r.status; throw e; }
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
  return {
    kind: 'supabase',
    async listVersions() { return (await q(`nave_versions?select=${META}&order=id`)).map(toV); },
    async getScene(id) { const r = await q(`nave_versions?select=scene&id=eq.${+id}`); return r[0]?.scene ?? null; },
    async addVersion(v, scene) {
      await q('nave_versions', { method: 'POST', prefer: 'return=minimal', body: { id: v.id, parent: v.parent, title: v.title, notes: v.notes || '', author: v.author, session_id: v.session || null, instructions: v.instructions || [], added: v.added || 0, removed: v.removed || 0, scene } });
    },
    async listPhotos(version) { return (await q(`nave_photos?select=${PMETA}&version=eq.${+version}&order=created_at`)).map(toP); },
    async getPhoto(id, thumb) { const r = await q(`nave_photos?select=mime,${thumb ? 'thumb' : 'data'},version,view_key,title&id=eq.${+id}`); const x = r[0]; if (!x) return null; return { mime: x.mime || 'image/jpeg', b64: thumb ? (x.thumb || null) : x.data, version: x.version, key: x.view_key, title: x.title }; },
    async addPhoto(m, data, thumb) {
      if (m.kind === 'std') await q(`nave_photos?version=eq.${+m.version}&view_key=eq.${encodeURIComponent(m.key)}&kind=eq.std`, { method: 'DELETE' });
      const r = await q('nave_photos?select=id', { method: 'POST', prefer: 'return=representation', body: { version: m.version, view_key: m.key, title: m.title, kind: m.kind, author: m.author, pose: m.pose || null, w: m.w, h: m.h, bytes: Math.round(data.length * 3 / 4), mime: m.mime || 'image/jpeg', data, thumb: thumb || null } });
      return r[0].id;
    },
    async delPhoto(id) { await q(`nave_photos?id=eq.${+id}`, { method: 'DELETE' }); },
    async listSessions() { return (await q('nave_sessions?select=id,author,base_version,status,stack,turns,saved_as,promoted,created_at,updated_at&order=created_at.desc&limit=500')).map(toS); },
    async getSession(id) { const r = await q(`nave_sessions?select=*&id=eq.${encodeURIComponent(id)}`); return toS(r[0]); },
    async saveSession(s) { await q('nave_sessions?on_conflict=id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: fromS(s) }); },
    async getDraft(sid, k) { const r = await q(`nave_drafts?select=scene&session_id=eq.${encodeURIComponent(sid)}&k=eq.${+k}`); return r[0]?.scene ?? null; },
    async putDraft(sid, k, scene) { await q('nave_drafts?on_conflict=session_id,k', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { session_id: sid, k, scene } }); },
    async delDraft(sid, k) { await q(`nave_drafts?session_id=eq.${encodeURIComponent(sid)}&k=eq.${+k}`, { method: 'DELETE' }); }
  };
}

function fileStore(DATA) {
  const V = path.join(DATA, 'versions'), S = path.join(DATA, 'sessions');
  fs.mkdirSync(V, { recursive: true }); fs.mkdirSync(S, { recursive: true });
  const IDX = path.join(V, 'index.json'), PH = path.join(DATA, 'photos'), PIDX = path.join(PH, 'index.json'); fs.mkdirSync(PH, { recursive: true });
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f); };
  const sf = id => path.join(S, id, 'session.json'), df = (id, k) => path.join(S, id, `draft-${k}.html`);
  return {
    kind: 'local',
    async listVersions() { return rj(IDX, []); },
    async getScene(id) { const f = path.join(V, `v${+id}.html`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; },
    async addVersion(v, scene) { const l = rj(IDX, []); if (l.some(x => x.id === v.id)) { const e = new Error('duplicada'); e.status = 409; throw e; }
      fs.writeFileSync(path.join(V, `v${v.id}.html`), scene); l.push({ ...v, createdAt: v.createdAt || new Date().toISOString() }); wj(IDX, l); },
    async listPhotos(version) { return rj(PIDX, []).filter(p => p.version === +version).map(({ pose, mime, ...p }) => p); },
    async getPhoto(id, thumb) { const l = rj(PIDX, []), p = l.find(x => x.id === +id); if (!p) return null; const f = path.join(PH, `${p.id}${thumb ? '-t' : ''}.jpg`); if (!fs.existsSync(f)) return null; return { mime: p.mime || 'image/jpeg', b64: fs.readFileSync(f).toString('base64'), version: p.version, key: p.key, title: p.title }; },
    async addPhoto(m, data, thumb) {
      let l = rj(PIDX, []);
      if (m.kind === 'std') { for (const o of l.filter(x => x.version === m.version && x.key === m.key && x.kind === 'std')) { fs.rmSync(path.join(PH, `${o.id}.jpg`), { force: true }); fs.rmSync(path.join(PH, `${o.id}-t.jpg`), { force: true }); } l = l.filter(x => !(x.version === m.version && x.key === m.key && x.kind === 'std')); }
      const id = Math.max(0, ...l.map(x => x.id)) + 1;
      fs.writeFileSync(path.join(PH, `${id}.jpg`), Buffer.from(data, 'base64')); if (thumb) fs.writeFileSync(path.join(PH, `${id}-t.jpg`), Buffer.from(thumb, 'base64'));
      l.push({ id, version: m.version, key: m.key, title: m.title, kind: m.kind, author: m.author, createdAt: new Date().toISOString(), w: m.w, h: m.h, bytes: Math.round(data.length * 3 / 4), mime: m.mime || 'image/jpeg', pose: m.pose || null }); wj(PIDX, l); return id;
    },
    async delPhoto(id) { const l = rj(PIDX, []); fs.rmSync(path.join(PH, `${+id}.jpg`), { force: true }); fs.rmSync(path.join(PH, `${+id}-t.jpg`), { force: true }); wj(PIDX, l.filter(x => x.id !== +id)); },
    async listSessions() { return fs.readdirSync(S).map(id => rj(sf(id), null)).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); },
    async getSession(id) { return rj(sf(id), null); },
    async saveSession(s) { fs.mkdirSync(path.join(S, s.id), { recursive: true }); wj(sf(s.id), { ...s, updatedAt: new Date().toISOString() }); },
    async getDraft(sid, k) { const f = df(sid, k); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; },
    async putDraft(sid, k, scene) { fs.mkdirSync(path.join(S, sid), { recursive: true }); fs.writeFileSync(df(sid, k), scene); },
    async delDraft(sid, k) { fs.rmSync(df(sid, k), { force: true }); }
  };
}

export function makeStore(dataDir) {
  if (SB_URL && SB_KEY) return supabaseStore();
  if (SB_URL && !SB_KEY) console.warn('SUPABASE_URL sin SUPABASE_SERVICE_ROLE_KEY: uso almacenamiento local.');
  return fileStore(dataDir);
}
