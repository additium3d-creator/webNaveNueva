// Nave Da Vinci 16 · visor 3D + agente de cambios con versionado
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createTwoFilesPatch } from 'diff';
import { SYSTEM_GUIDE } from './agent-guide.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const MOCK = !process.env.ANTHROPIC_API_KEY || process.env.MOCK_AGENT === '1';
const MAX_STEPS = +(process.env.AGENT_MAX_STEPS || 30);
const VDIR = path.join(DATA, 'versions');
const SDIR = path.join(DATA, 'sessions');
fs.mkdirSync(VDIR, { recursive: true });
fs.mkdirSync(SDIR, { recursive: true });
const anthropic = MOCK ? null : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/* ---------------- almacenamiento ---------------- */
const INDEX = path.join(VDIR, 'index.json');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2)); fs.renameSync(t, f); };
let lock = Promise.resolve();
const serial = fn => (lock = lock.then(fn, fn));

function versions() { return readJSON(INDEX, []); }
function versionFile(id) { return path.join(VDIR, `v${id}.html`); }
if (!versions().length) {
  fs.copyFileSync(path.join(__dirname, 'scene', 'base.html'), versionFile(1));
  writeJSON(INDEX, [{ id: 1, parent: null, title: 'Versión inicial', notes: 'Modelo construido a partir de los planos E-481 y el boceto de distribución.', author: 'Additium3D', createdAt: new Date().toISOString(), instructions: [], added: 0, removed: 0 }]);
}

const sidOk = s => /^[a-z0-9]{10,40}$/.test(s);
const sessFile = sid => path.join(SDIR, sid, 'session.json');
const draftFile = (sid, k) => path.join(SDIR, sid, `draft-${k}.html`);
function loadSession(sid) { if (!sidOk(sid)) return null; return readJSON(sessFile(sid), null); }
function saveSession(s) { s.updatedAt = new Date().toISOString(); writeJSON(sessFile(s.id), s); }
function currentDraft(s) { return fs.readFileSync(draftFile(s.id, s.stack), 'utf8'); }

/* ---------------- comprobación de sintaxis ---------------- */
async function checkSyntax(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const errors = [];
  for (let i = 0; i < scripts.length; i++) {
    const f = path.join(os.tmpdir(), `chk-${crypto.randomUUID()}.js`);
    await fsp.writeFile(f, scripts[i]);
    await new Promise(res => execFile(process.execPath, ['--check', f], { timeout: 15000 }, (err, _o, se) => {
      if (err) errors.push(`script ${i + 1}: ` + String(se || err.message).split('\n').slice(0, 6).join('\n').replaceAll(f, 'escena.js'));
      res();
    }));
    fsp.unlink(f).catch(() => {});
  }
  return errors;
}

/* ---------------- herramientas del agente ---------------- */
const clip = (t, n) => (t.length > n ? t.slice(0, n) + `… [línea de ${t.length} caracteres recortada]` : t);
function outline(src) {
  return src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\/\*\s*[-=]{2,}|^\s*\/\/\s*---|^\s*\/\*\s*----/.test(l))
    .map(([n, l]) => `L${n}: ${l.trim().slice(0, 140)}`).join('\n');
}
const TOOLS = [
  { name: 'buscar', description: 'Busca texto (o una expresión regular) en el código de la escena. Devuelve números de línea y un extracto de cada coincidencia (máx. 80).',
    input_schema: { type: 'object', properties: { patron: { type: 'string' }, regex: { type: 'boolean', description: 'true si el patrón es una expresión regular JS' } }, required: ['patron'] } },
  { name: 'leer', description: 'Lee un rango de líneas (máx. 200). Las líneas muy largas salen recortadas; usa leer_linea para verlas enteras.',
    input_schema: { type: 'object', properties: { desde: { type: 'integer' }, hasta: { type: 'integer' } }, required: ['desde', 'hasta'] } },
  { name: 'leer_linea', description: 'Devuelve una línea completa (hasta 8000 caracteres).',
    input_schema: { type: 'object', properties: { linea: { type: 'integer' } }, required: ['linea'] } },
  { name: 'reemplazar', description: 'Sustituye un fragmento exacto del código. texto_antiguo debe aparecer exactamente una vez (incluye contexto suficiente). texto_nuevo vacío lo borra.',
    input_schema: { type: 'object', properties: { texto_antiguo: { type: 'string' }, texto_nuevo: { type: 'string' } }, required: ['texto_antiguo', 'texto_nuevo'] } },
  { name: 'insertar', description: 'Inserta texto como líneas nuevas justo después de la línea indicada (0 = al principio).',
    input_schema: { type: 'object', properties: { despues_de_linea: { type: 'integer' }, texto: { type: 'string' } }, required: ['despues_de_linea', 'texto'] } },
  { name: 'comprobar', description: 'Comprueba la sintaxis JavaScript de la escena tras tus cambios. Llámala siempre antes de terminar.',
    input_schema: { type: 'object', properties: {} } }
];
async function runTool(name, input, ctx) {
  const lines = ctx.src.split('\n');
  switch (name) {
    case 'buscar': {
      let re; try { re = input.regex ? new RegExp(input.patron) : null; } catch (e) { return `Expresión regular no válida: ${e.message}`; }
      const out = [];
      lines.forEach((l, i) => {
        const at = re ? l.search(re) : l.indexOf(input.patron);
        if (at >= 0 && out.length < 80) { const a = Math.max(0, at - 120); out.push(`${i + 1}: ${a ? '…' : ''}${l.slice(a, at + 220)}${l.length > at + 220 ? '…' : ''}`); }
      });
      return out.length ? out.join('\n') : 'Sin coincidencias.';
    }
    case 'leer': {
      const a = Math.max(1, input.desde | 0), b = Math.min(lines.length, Math.max(a, input.hasta | 0), a + 199);
      return lines.slice(a - 1, b).map((l, i) => `${a + i}: ${clip(l, 600)}`).join('\n') + `\n(fichero de ${lines.length} líneas)`;
    }
    case 'leer_linea': { const l = lines[(input.linea | 0) - 1]; return l === undefined ? 'Esa línea no existe.' : clip(l, 8000); }
    case 'reemplazar': {
      const o = input.texto_antiguo ?? '', n = input.texto_nuevo ?? '';
      if (!o) return 'texto_antiguo vacío.';
      const c = ctx.src.split(o).length - 1;
      if (c !== 1) return `texto_antiguo aparece ${c} veces; debe aparecer exactamente una. Amplía el contexto.`;
      ctx.src = ctx.src.replace(o, () => n); ctx.edits++;
      return 'Hecho.';
    }
    case 'insertar': {
      const k = Math.max(0, Math.min(lines.length, input.despues_de_linea | 0));
      lines.splice(k, 0, ...(input.texto ?? '').split('\n')); ctx.src = lines.join('\n'); ctx.edits++;
      return `Insertado tras la línea ${k}.`;
    }
    case 'comprobar': { const e = await checkSyntax(ctx.src); ctx.checked = true; ctx.lastErrors = e; return e.length ? 'ERRORES:\n' + e.join('\n') : 'Sintaxis correcta.'; }
  }
  return 'Herramienta desconocida.';
}
const toolLabel = (n, i) => ({
  buscar: `buscando «${String(i.patron).slice(0, 40)}»`, leer: `leyendo líneas ${i.desde}–${i.hasta}`, leer_linea: `leyendo línea ${i.linea}`,
  reemplazar: 'editando la escena', insertar: `insertando tras la línea ${i.despues_de_linea}`, comprobar: 'comprobando la sintaxis'
}[n] || n);

async function runAgent(sess, instruction, send) {
  const ctx = { src: currentDraft(sess), edits: 0, checked: false, lastErrors: [] };
  if (MOCK) {
    send({ type: 'tool', text: 'modo demostración: sin clave de API' });
    const tag = `/* ---- cambio de demostración ${sess.turns.length + 1} ---- */`;
    ctx.src = ctx.src.replace('/* ---------- Volcado de geometría a mallas ---------- */',
      `${tag}\nbox(40.6,41.2,4.0,4.6,0,${(0.4 + 0.2 * sess.turns.length).toFixed(2)},'red');\n/* ---------- Volcado de geometría a mallas ---------- */`);
    ctx.edits = 1;
    const errs = await checkSyntax(ctx.src);
    return { text: `Modo demostración (no hay ANTHROPIC_API_KEY): he añadido un bloque rojo en el hall para probar el flujo de versiones.${errs.length ? ' Error: ' + errs[0] : ''}`, ctx };
  }
  const history = sess.history.slice(-8).flatMap(h => [{ role: 'user', content: h.user }, { role: 'assistant', content: h.assistant }]);
  const messages = [...history, { role: 'user', content: instruction }];
  let finalText = '', fixes = 0;
  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await anthropic.messages.create({
      model: MODEL, max_tokens: 8000,
      system: [{ type: 'text', text: SYSTEM_GUIDE, cache_control: { type: 'ephemeral' } },
               { type: 'text', text: `Índice de secciones del fichero actual (${ctx.src.split('\n').length} líneas):\n${outline(ctx.src)}` }],
      tools: TOOLS, messages
    });
    messages.push({ role: 'assistant', content: r.content });
    const texts = r.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    const uses = r.content.filter(b => b.type === 'tool_use');
    if (!uses.length) {
      finalText = texts;
      if (ctx.edits) {
        const e = await checkSyntax(ctx.src);
        if (e.length && fixes < 2) { fixes++; send({ type: 'tool', text: 'la comprobación ha fallado, corrigiendo' }); messages.push({ role: 'user', content: 'La comprobación de sintaxis falla:\n' + e.join('\n') + '\nCorrígelo.' }); continue; }
        ctx.lastErrors = e;
      }
      break;
    }
    if (texts) send({ type: 'note', text: texts });
    const results = [];
    for (const u of uses) {
      send({ type: 'tool', text: toolLabel(u.name, u.input || {}) });
      let out; try { out = await runTool(u.name, u.input || {}, ctx); } catch (e) { out = 'Error: ' + e.message; }
      results.push({ type: 'tool_result', tool_use_id: u.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!finalText) finalText = ctx.edits ? 'He aplicado los cambios.' : 'No he hecho cambios.';
  return { text: finalText, ctx };
}

/* ---------------- servidor ---------------- */
const app = express();
app.use(express.json({ limit: '1mb' }));
const cookieCode = req => decodeURIComponent((req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('nave_ac='))?.slice(8) || '');
const authed = req => !ACCESS_CODE || req.get('x-access-code') === ACCESS_CODE || cookieCode(req) === ACCESS_CODE;
const guard = (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: 'Código de acceso incorrecto.' }));
const hits = new Map();
const rate = (req, res, next) => { const k = req.ip, now = Date.now(), h = (hits.get(k) || []).filter(t => now - t < 3600e3); if (h.length >= 60) return res.status(429).json({ error: 'Demasiadas peticiones en la última hora.' }); h.push(now); hits.set(k, h); next(); };

app.get('/api/config', (req, res) => res.json({ model: MODEL, mock: MOCK, requiresCode: !!ACCESS_CODE, authed: authed(req), latest: versions().at(-1)?.id }));
app.post('/api/login', (req, res) => {
  if (ACCESS_CODE && req.body?.code !== ACCESS_CODE) return res.status(401).json({ error: 'Código de acceso incorrecto.' });
  res.setHeader('Set-Cookie', `nave_ac=${encodeURIComponent(req.body?.code || '')}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true });
});
app.get('/api/versions', guard, (_q, res) => res.json(versions()));
app.get('/api/versions/:id/diff', guard, (req, res) => {
  const v = versions().find(x => x.id === +req.params.id); if (!v) return res.status(404).json({ error: 'No existe.' });
  const cut = t => t.split('\n').map(l => (l.length > 300 ? l.slice(0, 300) + '…' : l)).join('\n');
  const a = v.parent ? cut(fs.readFileSync(versionFile(v.parent), 'utf8')) : '', b = cut(fs.readFileSync(versionFile(v.id), 'utf8'));
  res.type('text/plain').send(createTwoFilesPatch(v.parent ? `v${v.parent}` : 'vacío', `v${v.id}`, a, b, '', '', { context: 2 }));
});
app.get('/scene/v/:id', guard, (req, res) => { const f = versionFile(+req.params.id | 0); if (!fs.existsSync(f)) return res.status(404).send('No existe'); res.type('html').set('Cache-Control', 'no-store').send(fs.readFileSync(f)); });
app.get('/scene/s/:sid', guard, (req, res) => { const s = loadSession(req.params.sid); if (!s) return res.status(404).send('No existe'); res.type('html').set('Cache-Control', 'no-store').send(currentDraft(s)); });

app.post('/api/sessions', guard, (req, res) => {
  const base = +req.body?.baseVersion || versions().at(-1).id;
  if (!fs.existsSync(versionFile(base))) return res.status(400).json({ error: 'Versión base inexistente.' });
  const id = crypto.randomBytes(9).toString('hex');
  fs.mkdirSync(path.join(SDIR, id), { recursive: true });
  fs.copyFileSync(versionFile(base), draftFile(id, 0));
  const s = { id, author: String(req.body?.author || 'Anónimo').slice(0, 60), baseVersion: base, createdAt: new Date().toISOString(), stack: 0, turns: [], history: [], status: 'open' };
  saveSession(s); res.json(s);
});
app.get('/api/sessions/:sid', guard, (req, res) => { const s = loadSession(req.params.sid); s ? res.json(s) : res.status(404).json({ error: 'No existe.' }); });

const busy = new Set();
app.post('/api/sessions/:sid/message', guard, rate, async (req, res) => {
  const s = loadSession(req.params.sid); const text = String(req.body?.text || '').trim().slice(0, 4000);
  if (!s || s.status !== 'open') return res.status(404).json({ error: 'Sesión no disponible.' });
  if (!text) return res.status(400).json({ error: 'Mensaje vacío.' });
  if (busy.has(s.id)) return res.status(409).json({ error: 'Esta sesión ya está procesando un cambio.' });
  busy.add(s.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  try {
    send({ type: 'tool', text: MOCK ? 'preparando' : `pensando con ${MODEL}` });
    const { text: answer, ctx } = await runAgent(s, text, send);
    const changed = ctx.edits > 0 && !ctx.lastErrors.length;
    if (changed) { s.stack += 1; fs.writeFileSync(draftFile(s.id, s.stack), ctx.src); }
    s.turns.push({ at: new Date().toISOString(), instruction: text, summary: answer, changed, stack: s.stack });
    s.history.push({ user: text, assistant: answer + (changed ? '' : '\n(No se ha aplicado ningún cambio en este turno.)') });
    saveSession(s);
    send({ type: 'assistant', text: answer, changed, errors: ctx.lastErrors, pending: s.turns.filter(t => t.changed).length });
  } catch (e) {
    console.error(e); send({ type: 'error', text: e?.error?.error?.message || e.message || 'Error del agente.' });
  } finally { clearInterval(ping); busy.delete(s.id); send({ type: 'done' }); res.end(); }
});
app.post('/api/sessions/:sid/undo', guard, (req, res) => {
  const s = loadSession(req.params.sid); if (!s || s.status !== 'open') return res.status(404).json({ error: 'Sesión no disponible.' });
  if (s.stack === 0) return res.status(400).json({ error: 'No hay cambios que deshacer.' });
  fs.rmSync(draftFile(s.id, s.stack), { force: true }); s.stack -= 1;
  const t = [...s.turns].reverse().find(t => t.changed && !t.undone); if (t) t.undone = true;
  s.history.push({ user: '(deshacer)', assistant: 'Se ha deshecho el último cambio aplicado.' });
  saveSession(s); res.json(s);
});
app.post('/api/sessions/:sid/discard', guard, (req, res) => {
  const s = loadSession(req.params.sid); if (!s) return res.status(404).json({ error: 'No existe.' });
  s.status = 'discarded'; saveSession(s); res.json({ ok: true });
});
app.post('/api/sessions/:sid/save', guard, (req, res) => serial(async () => {
  const s = loadSession(req.params.sid); if (!s || s.status !== 'open') return res.status(404).json({ error: 'Sesión no disponible.' });
  const applied = s.turns.filter(t => t.changed && !t.undone);
  if (!applied.length || s.stack === 0) return res.status(400).json({ error: 'No hay cambios que guardar.' });
  const list = versions(), id = Math.max(...list.map(v => v.id)) + 1, src = currentDraft(s);
  const base = fs.readFileSync(versionFile(s.baseVersion), 'utf8').split('\n'), now = src.split('\n');
  const setB = new Set(base), setN = new Set(now);
  fs.writeFileSync(versionFile(id), src);
  const v = { id, parent: s.baseVersion, title: String(req.body?.title || applied[0].instruction).slice(0, 120), notes: String(req.body?.notes || '').slice(0, 4000),
    author: s.author, createdAt: new Date().toISOString(), session: s.id,
    instructions: applied.map(t => ({ instruction: t.instruction, summary: t.summary.slice(0, 1500), at: t.at })),
    added: now.filter(l => !setB.has(l)).length, removed: base.filter(l => !setN.has(l)).length };
  list.push(v); writeJSON(INDEX, list);
  fs.appendFileSync(path.join(VDIR, 'CHANGELOG.md'), `\n## v${id} · ${v.title}\n${v.createdAt} · ${v.author} · basada en v${v.parent}\n${v.notes ? v.notes + '\n' : ''}${v.instructions.map(i => `- ${i.instruction}`).join('\n')}\n`);
  s.status = 'saved'; s.savedAs = id; saveSession(s);
  res.json(v);
}));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.listen(PORT, () => console.log(`Nave Da Vinci 16 en :${PORT} · modelo ${MOCK ? 'DEMO (sin API)' : MODEL} · datos en ${DATA}`));
