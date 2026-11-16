// Almacenamiento: Supabase (si hay SUPABASE_URL) o carpeta local (DATA_DIR) para desarrollo.
import fs from 'node:fs';
import path from 'node:path';

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const META = 'id,parent,title,notes,author,created_at,session_id,instructions,added,removed';

const toV = r => r && ({ id: r.id, parent: r.parent, title: r.title, notes: r.notes, author: r.author, createdAt: r.created_at, session: r.session_id, instructions: r.instructions || [], added: r.added, removed: r.removed });
const toS = r => r && ({ id: r.id, author: r.author, baseVersion: r.base_version, status: r.status, stack: r.stack, turns: r.turns || [], history: r.history || [], savedAs: r.saved_as, createdAt: r.created_at, updatedAt: r.updated_at });
const fromS = s => ({ id: s.id, author: s.author, base_version: s.baseVersion, status: s.status, stack: s.stack, turns: s.turns, history: s.history, saved_as: s.savedAs ?? null, updated_at: new Date().toISOString() });

function supabaseStore() {
  async function q(p, { method = 'GET', body, prefer } = {}) {
    const r = await fetch(`${SB_URL}/rest/v1/${p}`, { method, body: body && JSON.stringify(body),
      headers: { apikey: SB_KEY, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) } });
    if (!r.ok) { const t = await r.text(); const e = new Error(`Supabase ${r.status}: ${t.slice(0, 300)}`); e.status = r.status; throw e; }
    const t = await r.text(); return t ? JSON.parse(t) : null;
  }
  return {
    kind: 'supabase',
    async listVersions() { return (await q(`nave_versions?select=${META}&order=id`)).map(toV); },
    async getScene(id) { const r = await q(`nave_versions?select=scene&id=eq.${+id}`); return r[0]?.scene ?? null; },
    async addVersion(v, scene) {
      await q('nave_versions', { method: 'POST', prefer: 'return=minimal', body: { id: v.id, parent: v.parent, title: v.title, notes: v.notes || '', author: v.author, session_id: v.session || null, instructions: v.instructions || [], added: v.added || 0, removed: v.removed || 0, scene } });
    },
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
  const IDX = path.join(V, 'index.json');
  const rj = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const wj = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2)); fs.renameSync(f + '.tmp', f); };
  const sf = id => path.join(S, id, 'session.json'), df = (id, k) => path.join(S, id, `draft-${k}.html`);
  return {
    kind: 'local',
    async listVersions() { return rj(IDX, []); },
    async getScene(id) { const f = path.join(V, `v${+id}.html`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; },
    async addVersion(v, scene) { const l = rj(IDX, []); if (l.some(x => x.id === v.id)) { const e = new Error('duplicada'); e.status = 409; throw e; }
      fs.writeFileSync(path.join(V, `v${v.id}.html`), scene); l.push({ ...v, createdAt: v.createdAt || new Date().toISOString() }); wj(IDX, l); },
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
