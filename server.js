// Twelfth Man Manager — API communautaire autonome (Boîte à idées + salons de Défi entre amis).
// Zéro dépendance (Node >= 18). Stockage : fichier JSON (écriture atomique). NON DÉPLOYÉ : l'hébergement est décidé par Sylvain.
//
//   GET  /health
//   GET  /ideas?sort=top|new           idées publiques (sans identifiants d'appareil)
//   POST /ideas                        { title, description, category, pseudo?, deviceId }
//   POST /ideas/:id/vote               { deviceId }            (1 vote par appareil et par idée)
//   --- modération (en-tête x-admin-key = ADMIN_KEY) ---
//   GET    /admin/ideas                toutes les idées (y compris masquées)
//   PATCH  /ideas/:id                  { status?: proposee|acceptee|dev|livree, adminNote?, hidden? }
//   DELETE /ideas/:id
//   --- Défi entre amis (codes de défi TMM1-…, aucun compte) ---
//   POST /duels                        { code }  -> { id }     crée un salon (expire après 7 jours)
//   GET  /duels/:id                    -> { codeA, codeB|null }
//   POST /duels/:id/join               { code }                 l'ami dépose son code ; les deux téléphones calculent le même match
import http from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const DB_FILE = join(DATA_DIR, 'db.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const SALT = process.env.DEVICE_SALT || 'tmm-' + (ADMIN_KEY ? createHash('sha256').update(ADMIN_KEY).digest('hex').slice(0, 16) : 'dev');
// Origines autorisées : domaines du jeu (à compléter quand l'hébergement sera choisi). « null » = jeu ouvert en double-clic (file://).
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://twelfth-man-manager.surge.sh,https://localhost,capacitor://localhost,http://localhost:5173,null').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_BODY = 8 * 1024;
export const CATEGORIES = ['gameplay', 'donnees', 'interface', 'live', 'multijoueur', 'autre'];
export const STATUSES = ['proposee', 'acceptee', 'dev', 'livree'];

// ------------------------------------------------------------------ stockage
mkdirSync(DATA_DIR, { recursive: true });
let db = existsSync(DB_FILE) ? JSON.parse(readFileSync(DB_FILE, 'utf8')) : { ideas: [], duels: [] };
db.ideas ||= []; db.duels ||= [];
let saveTimer = null;
function persist(now = false) {
  const w = () => { const tmp = DB_FILE + '.tmp'; writeFileSync(tmp, JSON.stringify(db)); renameSync(tmp, DB_FILE); saveTimer = null; };
  if (now) return w();
  if (!saveTimer) saveTimer = setTimeout(w, 200);
}
const hashDev = (d) => createHash('sha256').update(SALT + ':' + d).digest('hex').slice(0, 32);

// ------------------------------------------------------------------ limitation de débit (fenêtre glissante par IP)
const hits = new Map();
function limited(ip, bucket, max, windowMs) {
  const k = bucket + '|' + ip; const now = Date.now();
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

// ------------------------------------------------------------------ anti-spam
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const BANNED = /(casino|viagra|crypto ?airdrop|porn|xxx|bet365|paris sportifs? en ligne|onlyfans)/i;
export function checkIdea(b) {
  const title = String(b.title || '').trim(), description = String(b.description || '').trim();
  if (b.website) return 'spam'; // pot de miel
  if (title.length < 5 || title.length > 90) return 'Le titre doit faire entre 5 et 90 caractères.';
  if (description.length < 10 || description.length > 1500) return 'La description doit faire entre 10 et 1500 caractères.';
  if (!CATEGORIES.includes(b.category)) return 'Catégorie inconnue.';
  if (!/^[a-z0-9-]{8,64}$/i.test(String(b.deviceId || ''))) return 'Identifiant d\'appareil invalide.';
  if ((description.match(/https?:\/\//g) || []).length > 2) return 'Trop de liens.';
  if (BANNED.test(title + ' ' + description)) return 'Contenu refusé.';
  if (/(.)\1{9,}/.test(title + description)) return 'Contenu refusé.';
  if (b.pseudo && String(b.pseudo).length > 24) return 'Pseudo trop long (24 caractères max).';
  return null;
}
const publicIdea = (i) => ({ id: i.id, title: i.title, description: i.description, category: i.category, pseudo: i.pseudo, status: i.status, votes: i.voters.length, createdAt: i.createdAt, updatedAt: i.updatedAt, adminNote: i.adminNote || null });

// ------------------------------------------------------------------ HTTP
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('Requête trop volumineuse'), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Object.assign(new Error('JSON invalide'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const isAdmin = (req) => { const k = String(req.headers['x-admin-key'] || ''); return ADMIN_KEY.length >= 16 && k.length === ADMIN_KEY.length && timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY)); };
const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
const newId = (n = 8) => randomBytes(n).toString('base64url').replace(/[-_]/g, '').slice(0, n).toLowerCase();

export async function handle(req, res) {
  const origin = req.headers.origin;
  const cors = {};
  if (origin !== undefined) {
    if (!ORIGINS.includes(origin)) return send(res, 403, { error: 'Origine non autorisée' });
    Object.assign(cors, { 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type,x-admin-key', 'access-control-max-age': '600' });
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const ip = ipOf(req);
  const url = new URL(req.url, 'http://x'); const parts = url.pathname.split('/').filter(Boolean);
  const out = (code, obj) => send(res, code, obj, cors);
  if (limited(ip, 'all', 120, 60e3)) return out(429, { error: 'Trop de requêtes, réessayez dans une minute.' });
  try {
    if (req.method === 'GET' && url.pathname === '/health') return out(200, { ok: true, ideas: db.ideas.length, version: 1 });

    // ---- idées
    if (parts[0] === 'ideas' && parts.length === 1 && req.method === 'GET') {
      const sort = url.searchParams.get('sort') === 'new' ? 'new' : 'top';
      const list = db.ideas.filter((i) => !i.hidden).map(publicIdea)
        .sort((a, b) => (sort === 'new' ? b.createdAt.localeCompare(a.createdAt) : b.votes - a.votes || b.createdAt.localeCompare(a.createdAt)));
      return out(200, { ideas: list.slice(0, 500), sort });
    }
    if (parts[0] === 'ideas' && parts.length === 1 && req.method === 'POST') {
      if (limited(ip, 'post', 5, 10 * 60e3)) return out(429, { error: 'Trop de propositions : patientez quelques minutes.' });
      const b = await readBody(req);
      const err = checkIdea(b); if (err) return out(err === 'spam' ? 201 : 400, err === 'spam' ? { ok: true } : { error: err });
      const dev = hashDev(b.deviceId);
      const today = new Date().toISOString().slice(0, 10);
      if (db.ideas.filter((i) => i.author === dev && i.createdAt.startsWith(today)).length >= 3) return out(429, { error: 'Maximum 3 idées par jour et par appareil.' });
      const nt = norm(b.title);
      const dup = db.ideas.find((i) => !i.hidden && norm(i.title) === nt);
      if (dup) return out(409, { error: 'Une idée identique existe déjà : votez pour elle !', id: dup.id });
      const now = new Date().toISOString();
      const idea = { id: newId(), title: b.title.trim(), description: b.description.trim(), category: b.category, pseudo: String(b.pseudo || '').trim().slice(0, 24) || null, status: 'proposee', voters: [dev], author: dev, createdAt: now, updatedAt: now, hidden: false };
      db.ideas.push(idea); persist();
      return out(201, { idea: publicIdea(idea) });
    }
    if (parts[0] === 'ideas' && parts.length === 3 && parts[2] === 'vote' && req.method === 'POST') {
      if (limited(ip, 'vote', 40, 10 * 60e3)) return out(429, { error: 'Trop de votes, patientez.' });
      const b = await readBody(req);
      if (!/^[a-z0-9-]{8,64}$/i.test(String(b.deviceId || ''))) return out(400, { error: 'Identifiant d\'appareil invalide.' });
      const idea = db.ideas.find((i) => i.id === parts[1] && !i.hidden); if (!idea) return out(404, { error: 'Idée introuvable.' });
      const dev = hashDev(b.deviceId);
      if (idea.voters.includes(dev)) return out(409, { error: 'Vous avez déjà voté pour cette idée.', votes: idea.voters.length });
      idea.voters.push(dev); persist();
      return out(200, { votes: idea.voters.length });
    }
    // ---- modération
    if (parts[0] === 'admin' && parts[1] === 'ideas' && req.method === 'GET') {
      if (!isAdmin(req)) return out(401, { error: 'Clé admin requise.' });
      return out(200, { ideas: db.ideas.map((i) => ({ ...publicIdea(i), hidden: i.hidden })) });
    }
    if (parts[0] === 'ideas' && parts.length === 2 && (req.method === 'PATCH' || req.method === 'DELETE')) {
      if (!isAdmin(req)) return out(401, { error: 'Clé admin requise.' });
      const idx = db.ideas.findIndex((i) => i.id === parts[1]); if (idx < 0) return out(404, { error: 'Idée introuvable.' });
      if (req.method === 'DELETE') { db.ideas.splice(idx, 1); persist(); return out(200, { ok: true }); }
      const b = await readBody(req); const i = db.ideas[idx];
      if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return out(400, { error: 'Statut inconnu.' }); i.status = b.status; }
      if (b.adminNote !== undefined) i.adminNote = String(b.adminNote).slice(0, 300) || null;
      if (b.hidden !== undefined) i.hidden = !!b.hidden;
      i.updatedAt = new Date().toISOString(); persist();
      return out(200, { idea: { ...publicIdea(i), hidden: i.hidden } });
    }
    // ---- salons de duel
    if (parts[0] === 'duels') {
      const now = Date.now(); db.duels = db.duels.filter((d) => now - d.at < 7 * 86400e3);
      const okCode = (c) => /^TMM1-[A-Za-z0-9_-]{10,1800}\.[a-z0-9]{1,8}$/.test(String(c || ''));
      if (parts.length === 1 && req.method === 'POST') {
        if (limited(ip, 'duel', 20, 10 * 60e3)) return out(429, { error: 'Trop de salons créés.' });
        const b = await readBody(req); if (!okCode(b.code)) return out(400, { error: 'Code de défi invalide.' });
        const d = { id: newId(6), codeA: b.code, codeB: null, at: now }; db.duels.push(d); persist();
        return out(201, { id: d.id });
      }
      const d = db.duels.find((x) => x.id === parts[1]); if (!d) return out(404, { error: 'Salon introuvable ou expiré.' });
      if (parts.length === 2 && req.method === 'GET') return out(200, { id: d.id, codeA: d.codeA, codeB: d.codeB });
      if (parts.length === 3 && parts[2] === 'join' && req.method === 'POST') {
        const b = await readBody(req); if (!okCode(b.code)) return out(400, { error: 'Code de défi invalide.' });
        if (d.codeB && d.codeB !== b.code) return out(409, { error: 'Salon déjà complet.' });
        d.codeB = b.code; persist();
        return out(200, { id: d.id, codeA: d.codeA, codeB: d.codeB });
      }
    }
    return out(404, { error: 'Route inconnue.' });
  } catch (e) {
    return out(e.code && e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code ? e.message : 'Erreur serveur' });
  }
}

export function start(port = PORT) {
  const srv = http.createServer((req, res) => { handle(req, res); });
  srv.listen(port, () => console.log(`Twelfth Man API sur :${srv.address().port} — données ${DB_FILE} — origines ${ORIGINS.join(', ')}${ADMIN_KEY.length >= 16 ? '' : ' — ⚠ ADMIN_KEY absente ou < 16 caractères : modération désactivée'}`));
  const stop = () => { persist(true); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  return srv;
}
if (import.meta.url === `file://${process.argv[1]}`) start();
