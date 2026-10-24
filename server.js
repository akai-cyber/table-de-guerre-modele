const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { creerStockage } = require('./lib/stockage');
const D = require('./lib/dispos');

// Lecture du fichier .env. Les variables déjà définies ne sont pas écrasées (la démo et les tests s'en servent).
// Piège connu : une valeur qui commence par # sans guillemets est prise pour un commentaire et devient vide.
const ENV_PIEGES = [];
try {
  const brut = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').replace(/^﻿/, ''); // le Bloc-notes peut ajouter un BOM
  for (const [k, v] of Object.entries(dotenv.parse(brut))) if (process.env[k] === undefined) process.env[k] = v;
  for (const m of brut.matchAll(/^[ \t]*([A-Z_]+)[ \t]*=[ \t]*#/gm)) ENV_PIEGES.push(m[1]);
} catch (e) { /* pas de fichier .env */ }

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = (process.env.CLASH_API_TOKEN || '').replace(/\s+/g, '').replace(/^Bearer/i, '');
const API_BASE = (process.env.CLASH_API_BASE || 'https://api.clashofclans.com/v1').replace(/\/+$/, '');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const CACHE_MS = process.env.CACHE_MS !== undefined ? Number(process.env.CACHE_MS) : 15000; // l'API est interrogée au plus une fois par 15 s
const MAX_IMAGE_CHARS = 4_000_000; // ~3 Mo d'image en base64
const MAX_STROKES = 500;

// Sans code chef valide, le mode chef est désactivé (les valeurs d'exemple ne comptent pas).
const PLACEHOLDERS = ['', 'changeme', 'choisis-un-code-secret'];
const CHEF_CODE = PLACEHOLDERS.includes(process.env.CHEF_CODE || '') ? '' : process.env.CHEF_CODE;

// Les tags Clash n'utilisent que ces caractères.
const normTag = (t) => {
  const s = String(t || '').trim().toUpperCase().replace(/^#/, '');
  return /^[0289PYLQGRJCUV]{3,15}$/.test(s) ? '#' + s : '';
};
const CLAN_TAG = normTag(process.env.CLAN_TAG);
// Identité des membres pour « Signe / Non » :
//  - jeton (par défaut) : le joueur prouve qui il est avec le jeton API affiché dans les paramètres du jeu ;
//  - libre : il choisit simplement son nom (pratique, mais n'importe qui peut répondre à la place d'un autre).
const IDENTITE = process.env.IDENTITE === 'libre' ? 'libre' : 'jeton';
const SESSION_JOURS = 180;

// ---------- Serveur et état ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const boards = new Map(); // une salle par base ennemie, en mémoire
const getBoard = (id) => {
  if (!boards.has(id)) boards.set(id, { image: null, strokes: [] });
  return boards.get(id);
};

let assignments = {}; // { '#TAGJOUEUR': numéroDeBase }
let warKey = null;    // identifie la guerre dont viennent les assignations
let periodes = [];    // périodes « Signe / Non »
let reponses = {};    // { idPériode: { '#TAG': { r: 'oui'|'non', le, par: 'membre'|'chef', nom } } }
let sessions = {};    // { empreinte du jeton de session: { tag, nom, cree, vu } }

const stockage = creerStockage({
  fichier: DATA_FILE,
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL,
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function appliquerDonnees(d) {
  if (!d || typeof d !== 'object') return;
  warKey = typeof d.warKey === 'string' ? d.warKey : null;
  if (d.assignments && typeof d.assignments === 'object') assignments = d.assignments;
  if (Array.isArray(d.periodes)) periodes = d.periodes.filter((p) => p && typeof p.id === 'string' && p.debut && p.fin);
  if (d.reponses && typeof d.reponses === 'object') reponses = d.reponses;
  if (d.sessions && typeof d.sessions === 'object') sessions = d.sessions;
  for (const [t, v] of Object.entries(assignments)) {
    if (!normTag(t) || !Number.isInteger(v) || v < 1 || v > 50) delete assignments[t];
  }
  const limite = Date.now() - SESSION_JOURS * D.JOUR;
  for (const [k, v] of Object.entries(sessions)) if (!v || Date.parse(v.vu || v.cree) < limite) delete sessions[k];
}
const save = () => stockage.enregistrer({ version: 2, warKey, assignments, periodes, reponses, sessions });

// ---------- API Clash of Clans ----------
// La clé reste sur le serveur : elle n'est jamais envoyée aux téléphones.
const cache = new Map();

function frMessage(status, body) {
  const reason = (body && body.reason) || '';
  if (status === 403 && /invalidIp/i.test(reason)) {
    return 'Clé API refusée pour l’adresse IP de ce PC : crée une clé sur developer.clashofclans.com avec l’IP publique actuelle du PC qui lance le serveur.';
  }
  if (status === 403 && /invalidAuth/i.test(reason)) {
    return 'Clé API invalide (raison : invalidAuth) : la clé enregistrée dans CLASH_API_TOKEN est fausse, incomplète ou a été supprimée.';
  }
  if (status === 403) return 'Accès refusé (raison : ' + (reason || 'inconnue') + ') : vérifie la clé API et que le journal de guerre du clan est public.';
  if (status === 404) return 'Clan introuvable : vérifie CLAN_TAG dans le fichier .env.';
  if (status === 429) return 'Trop de requêtes vers l’API Clash : réessaie dans quelques secondes.';
  if (status === 503) return 'L’API Clash of Clans est en maintenance.';
  return (body && body.message) || `Erreur de l’API Clash (${status}).`;
}

async function coc(route, ttl = CACHE_MS) {
  if (!TOKEN) throw Object.assign(new Error('Clé API manquante : renseigne CLASH_API_TOKEN dans le fichier .env.'), { status: 503 });
  if (!CLAN_TAG) throw Object.assign(new Error('Tag du clan manquant ou invalide : renseigne CLAN_TAG dans le fichier .env, entre guillemets (par exemple CLAN_TAG="#2PP0JCCL").'), { status: 503 });
  const hit = cache.get(route);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  let res;
  try {
    res = await fetch(API_BASE + route, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw Object.assign(new Error('Impossible de joindre l’API Clash of Clans.'), { status: 502 });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(frMessage(res.status, body)), { status: res.status });
  cache.set(route, { t: Date.now(), data: body });
  return body;
}

const camp = (s = {}) => ({
  tag: s.tag, name: s.name, stars: s.stars || 0, pct: s.destructionPercentage || 0, attacks: s.attacks || 0,
  members: (s.members || []).map((m) => ({
    tag: m.tag, name: m.name, th: m.townhallLevel, pos: m.mapPosition,
    attacks: (m.attacks || []).map((a) => ({ defender: a.defenderTag, stars: a.stars || 0, pct: a.destructionPercentage || 0 })),
    best: m.bestOpponentAttack
      ? { stars: m.bestOpponentAttack.stars || 0, pct: m.bestOpponentAttack.destructionPercentage || 0 }
      : null,
  })).sort((a, b) => a.pos - b.pos),
});

const simplifyWar = (w) => (!w || w.state === 'notInWar' || !w.clan)
  ? { state: 'notInWar' }
  : {
      state: w.state, teamSize: w.teamSize, attacksPerMember: w.attacksPerMember || 2,
      preparationStartTime: w.preparationStartTime, startTime: w.startTime, endTime: w.endTime,
      clan: camp(w.clan), opponent: camp(w.opponent),
    };

// Nouvelle guerre détectée : on repart de zéro (assignations et dessins de l'ancienne guerre).
function suivreGuerre(war) {
  if (war.state === 'notInWar') return;
  const key = war.preparationStartTime || war.startTime || null;
  if (!key || key === warKey) return;
  if (warKey !== null) {
    assignments = {};
    for (const [id, b] of boards) {
      b.image = null; b.strokes = [];
      io.to(id).emit('state', b);
    }
    io.emit('assignments', assignments);
  }
  warKey = key;
  save();
}

app.get('/api/status', (req, res) => res.json({ api: Boolean(TOKEN), clan: CLAN_TAG || null, chef: Boolean(CHEF_CODE), identite: IDENTITE, stockage: { type: stockage.etat.type, ok: stockage.etat.ok } }));
// Diagnostic : teste trois appels à l'API Clash et dit lequel est refusé (aucun secret n'est affiché).
app.get('/api/diag', async (req, res) => {
  const out = { clan: CLAN_TAG || null, base: API_BASE, cleLongueur: TOKEN.length, tests: {} };
  for (const [nom, route] of [['clan', ''], ['journal', '/warlog'], ['guerreEnCours', '/currentwar']]) {
    try {
      const r = await fetch(API_BASE + '/clans/' + encodeURIComponent(CLAN_TAG) + route, {
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      const b = await r.json().catch(() => ({}));
      out.tests[nom] = { statut: r.status, raison: b.reason || null, nom: route === '' ? b.name || null : undefined };
    } catch (e) { out.tests[nom] = { statut: 'injoignable' }; }
  }
  res.json(out);
});
app.get('/api/war', async (req, res) => {
  try {
    const war = simplifyWar(await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/currentwar`));
    suivreGuerre(war);
    res.json(war);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---------- Clan (en-tête, membres) ----------
const simplifyClan = (c) => ({
  tag: c.tag, name: c.name, level: c.clanLevel || 0, count: c.members || (c.memberList || []).length,
  badge: c.badgeUrls ? c.badgeUrls.medium || c.badgeUrls.small || null : null,
  description: typeof c.description === 'string' ? c.description.slice(0, 300) : '',
  warLeague: c.warLeague && c.warLeague.name ? c.warLeague.name : null,
  warLogPublic: c.isWarLogPublic !== false, warWins: c.warWins || 0, type: c.type || null,
  members: (c.memberList || []).map((m) => ({
    tag: m.tag, name: m.name, role: m.role, th: m.townHallLevel || null, exp: m.expLevel || null,
    rang: m.clanRank || null, trophees: m.trophies || 0,
  })),
});
const clanActuel = async () => simplifyClan(await coc(`/clans/${encodeURIComponent(CLAN_TAG)}`, 60000));

app.get('/api/clan', async (req, res) => {
  try { res.json(await clanActuel()); } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ---------- Signe / Non ----------
const api = express.Router();
api.use(express.json({ limit: '16kb' }));
const erreur = (res, code, message) => res.status(code).json({ error: message });
const empreinte = (jeton) => crypto.createHash('sha256').update(String(jeton)).digest('hex');
const notifierDispos = () => io.emit('dispos');

function sessionDe(req) {
  const j = req.get('x-session');
  if (typeof j !== 'string' || j.length < 20 || j.length > 100) return null;
  const k = empreinte(j), s = sessions[k];
  if (!s) return null;
  if (Date.now() - Date.parse(s.vu || s.cree) > 6 * 3600e3) { s.vu = new Date().toISOString(); save(); }
  return { ...s, cle: k };
}
// Le code chef voyage dans l'en-tête X-Chef (jamais dans l'adresse) et passe par le même anti-force brute.
function exigerChef(req, res, next) {
  const r = checkCode(ipReq(req), req.get('x-chef') || '');
  if (r === 'ok') return next();
  const msg = { off: 'Le mode chef n’est pas activé sur ce serveur.', blocked: 'Trop d’essais : réessaie dans 10 minutes.' }[r] || 'Réservé au chef : code chef manquant ou incorrect.';
  return erreur(res, r === 'blocked' ? 429 : 403, msg);
}
const trouverPeriode = (id) => periodes.find((p) => p.id === id) || null;
const publier = (p, now) => p && { id: p.id, titre: p.titre, debut: p.debut, fin: p.fin, cloturee: Boolean(p.cloturee), statut: D.statutPeriode(p, now), creeLe: p.creeLe, modifieLe: p.modifieLe || null };

api.get('/dispos', async (req, res) => {
  const now = Date.now();
  let clan = null, erreurClan = null;
  try { clan = await clanActuel(); } catch (e) { erreurClan = e.message; }
  const demandee = typeof req.query.periode === 'string' ? trouverPeriode(req.query.periode) : null;
  const p = demandee || D.periodeCourante(periodes, now);
  const rep = p ? reponses[p.id] || {} : {};
  const moi = sessionDe(req);
  // Sans la liste du clan (API indisponible), on se rabat sur les personnes qui ont répondu.
  const membres = clan ? clan.members : Object.entries(rep).map(([tag, v]) => ({ tag, name: v.nom || tag, role: null, th: null, exp: null, rang: null }));
  res.json({
    maintenant: new Date(now).toISOString(), identite: IDENTITE,
    clan: clan && { ...clan, members: undefined }, erreurClan,
    membres, membresFiables: Boolean(clan),
    periode: publier(p, now),
    periodes: [...periodes].sort((a, b) => Date.parse(b.debut) - Date.parse(a.debut)).slice(0, 30).map((x) => publier(x, now)),
    reponses: rep, stats: D.calculerStats(membres, rep),
    moi: moi ? { tag: moi.tag, nom: moi.nom, verifie: moi.verifie !== false } : null,
  });
});

// Identification d'un membre. Mode « jeton » : vérification auprès de Supercell (POST /players/{tag}/verifytoken).
const essaisJeton = new Map();
api.post('/moi', async (req, res) => {
  const ip = ipReq(req), e = essaisJeton.get(ip) || { n: 0, depuis: Date.now() };
  if (Date.now() - e.depuis > 10 * 60e3) { e.n = 0; e.depuis = Date.now(); }
  if (e.n >= 10) return erreur(res, 429, 'Trop d’essais : réessaie dans 10 minutes.');
  const tag = normTag(req.body && req.body.tag);
  if (!tag) return erreur(res, 400, 'Choisis ton nom dans la liste.');
  let clan;
  try { clan = await clanActuel(); } catch (err) { return erreur(res, err.status || 502, err.message); }
  const m = clan.members.find((x) => x.tag === tag);
  if (!m) return erreur(res, 404, 'Ce joueur ne fait pas partie du clan.');
  if (IDENTITE === 'jeton') {
    const jeton = String((req.body && req.body.jeton) || '').trim();
    if (!/^[A-Za-z0-9]{6,16}$/.test(jeton)) return erreur(res, 400, 'Jeton invalide : recopie les 8 caractères affichés dans le jeu.');
    e.n++; essaisJeton.set(ip, e);
    if (essaisJeton.size > 2000) essaisJeton.clear();
    let r;
    try {
      r = await fetch(`${API_BASE}/players/${encodeURIComponent(tag)}/verifytoken`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: jeton }), signal: AbortSignal.timeout(10000),
      });
    } catch (err) { return erreur(res, 502, 'Impossible de joindre l’API Clash of Clans pour vérifier le jeton.'); }
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return erreur(res, r.status === 404 ? 404 : 502, r.status === 404 ? 'Joueur introuvable.' : 'Vérification refusée par l’API Clash (' + frMessage(r.status, b) + ').');
    if (b.status !== 'ok') return erreur(res, 401, 'Jeton incorrect ou expiré : affiche un nouveau jeton dans le jeu et réessaie.');
  }
  const jetonSession = crypto.randomBytes(24).toString('base64url');
  const cles = Object.keys(sessions);
  if (cles.length >= 3000) cles.sort((a, b) => Date.parse(sessions[a].vu) - Date.parse(sessions[b].vu)).slice(0, 500).forEach((k) => delete sessions[k]);
  const maintenant = new Date().toISOString();
  sessions[empreinte(jetonSession)] = { tag, nom: m.name, cree: maintenant, vu: maintenant, verifie: IDENTITE === 'jeton' };
  save();
  res.json({ session: jetonSession, moi: { tag, nom: m.name, verifie: IDENTITE === 'jeton' } });
});
api.delete('/moi', (req, res) => {
  const s = sessionDe(req);
  if (s) { delete sessions[s.cle]; save(); }
  res.json({ ok: true });
});

// Réponse d'un membre identifié, pour lui-même uniquement, pendant que la période est ouverte.
api.put('/dispos/periodes/:id/ma-reponse', async (req, res) => {
  const s = sessionDe(req);
  if (!s) return erreur(res, 401, 'Identifie-toi d’abord pour répondre.');
  const p = trouverPeriode(req.params.id);
  if (!p) return erreur(res, 404, 'Période introuvable.');
  if (D.statutPeriode(p) !== 'ouverte') return erreur(res, 409, 'Les réponses sont fermées pour cette période.');
  const r = req.body && req.body.r;
  if (r !== 'oui' && r !== 'non' && r !== null) return erreur(res, 400, 'Réponse invalide.');
  try {
    const clan = await clanActuel();
    if (!clan.members.some((m) => m.tag === s.tag)) return erreur(res, 403, 'Tu ne fais plus partie du clan.');
  } catch (e) { /* API momentanément indisponible : la session suffit */ }
  const rep = reponses[p.id] || (reponses[p.id] = {});
  if (r === null) delete rep[s.tag];
  else rep[s.tag] = { r, le: new Date().toISOString(), par: 'membre', nom: s.nom };
  save(); notifierDispos();
  res.json({ ok: true, reponse: rep[s.tag] || null });
});

// --- Outils du chef
api.post('/dispos/periodes', exigerChef, (req, res) => {
  const v = D.validerPeriode(req.body);
  if (v.erreur) return erreur(res, 400, v.erreur);
  const conflits = D.chevauchements(periodes, v.valeur.debut, v.valeur.fin);
  if (conflits.length && !(req.body && req.body.remplacer === true)) {
    return res.status(409).json({ error: 'Une autre période est déjà prévue sur ces dates.', conflits: conflits.map((p) => publier(p)) });
  }
  const maintenant = new Date().toISOString();
  conflits.forEach((p) => { p.cloturee = true; p.modifieLe = maintenant; }); // « renouveler » : l'ancienne est close
  const p = { id: crypto.randomBytes(6).toString('hex'), ...v.valeur, cloturee: false, creeLe: maintenant };
  periodes.push(p);
  if (periodes.length > 60) { // historique borné : on oublie les plus anciennes
    periodes.sort((a, b) => Date.parse(b.debut) - Date.parse(a.debut));
    periodes.splice(60).forEach((x) => delete reponses[x.id]);
  }
  save(); notifierDispos();
  res.status(201).json({ periode: publier(p) });
});
api.patch('/dispos/periodes/:id', exigerChef, (req, res) => {
  const p = trouverPeriode(req.params.id);
  if (!p) return erreur(res, 404, 'Période introuvable.');
  const v = D.validerPeriode(req.body, p);
  if (v.erreur) return erreur(res, 400, v.erreur);
  if (!p.cloturee && D.chevauchements(periodes, v.valeur.debut, v.valeur.fin, p.id).length) return erreur(res, 409, 'Ces dates chevauchent une autre période.');
  Object.assign(p, v.valeur, { modifieLe: new Date().toISOString() });
  save(); notifierDispos();
  res.json({ periode: publier(p) });
});
api.post('/dispos/periodes/:id/cloture', exigerChef, (req, res) => {
  const p = trouverPeriode(req.params.id);
  if (!p) return erreur(res, 404, 'Période introuvable.');
  const cloturee = !(req.body && req.body.cloturee === false);
  if (!cloturee && D.chevauchements(periodes, p.debut, p.fin, p.id).length) return erreur(res, 409, 'Impossible de rouvrir : une autre période occupe ces dates.');
  p.cloturee = cloturee; p.modifieLe = new Date().toISOString();
  save(); notifierDispos();
  res.json({ periode: publier(p) });
});
api.delete('/dispos/periodes/:id', exigerChef, (req, res) => {
  const i = periodes.findIndex((p) => p.id === req.params.id);
  if (i < 0) return erreur(res, 404, 'Période introuvable.');
  delete reponses[periodes[i].id];
  periodes.splice(i, 1);
  save(); notifierDispos();
  res.json({ ok: true });
});
// Le chef peut corriger la réponse d'un membre (réponse donnée dans le chat du jeu, erreur…) : c'est indiqué « saisi par le chef ».
api.put('/dispos/periodes/:id/reponses/:tag', exigerChef, async (req, res) => {
  const p = trouverPeriode(req.params.id), tag = normTag(req.params.tag);
  if (!p) return erreur(res, 404, 'Période introuvable.');
  if (!tag) return erreur(res, 400, 'Joueur invalide.');
  const r = req.body && req.body.r;
  if (r !== 'oui' && r !== 'non' && r !== null) return erreur(res, 400, 'Réponse invalide.');
  const rep = reponses[p.id] || (reponses[p.id] = {});
  if (r === null) delete rep[tag];
  else {
    let nom = rep[tag] && rep[tag].nom;
    try { const m = (await clanActuel()).members.find((x) => x.tag === tag); if (m) nom = m.name; else if (!rep[tag]) return erreur(res, 404, 'Ce joueur ne fait pas partie du clan.'); } catch (e) { /* hors ligne */ }
    rep[tag] = { r, le: new Date().toISOString(), par: 'chef', nom: nom || tag };
  }
  save(); notifierDispos();
  res.json({ ok: true, reponse: rep[tag] || null });
});
api.get('/dispos/periodes/:id/export.csv', exigerChef, async (req, res) => {
  const p = trouverPeriode(req.params.id);
  if (!p) return erreur(res, 404, 'Période introuvable.');
  let membres = [];
  try { membres = (await clanActuel()).members; } catch (e) { /* export des seules réponses */ }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="signe-non-${p.debut.slice(0, 10)}.csv"`);
  res.send(D.exporterCSV(p, membres, reponses[p.id] || {}));
});
app.use('/api', api);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Code chef : comparaison à temps constant, blocage après trop d'essais ----------
const fails = new Map(); // ip -> { n, until }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Adresse du visiteur, pour limiter les essais de code. Les en-têtes ne sont crus que derrière un relais de confiance :
// un tunnel local (Cloudflare, ngrok) ou l'hébergeur Render (variable RENDER posée par Render lui-même).
function ipDepuis(direct, h = {}) {
  const viaLocalProxy = direct === '::1' || direct === '127.0.0.1' || direct === '::ffff:127.0.0.1';
  const xff = String(h['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (process.env.RENDER) return h['cf-connecting-ip'] || h['true-client-ip'] || xff[0] || direct;
  return (viaLocalProxy && (h['cf-connecting-ip'] || xff[0])) || direct;
}
const ipOf = (socket) => ipDepuis(socket.handshake.address || '', socket.handshake.headers || {});
const ipReq = (req) => ipDepuis(req.socket.remoteAddress || '', req.headers || {});

function checkCode(socketOuIp, code) {
  if (!CHEF_CODE) return 'off';
  const ip = typeof socketOuIp === 'string' ? socketOuIp : ipOf(socketOuIp);
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return 'blocked';
  if (typeof code !== 'string' || !code) return 'bad'; // visiteur sans code : pas compté comme un échec
  if (crypto.timingSafeEqual(sha(code), sha(CHEF_CODE))) { fails.delete(ip); return 'ok'; }
  if (fails.size > 1000) fails.clear();
  const cur = f || { n: 0, until: 0 };
  cur.n += 1;
  if (cur.n >= 8) { cur.until = Date.now() + 10 * 60 * 1000; cur.n = 0; }
  fails.set(ip, cur);
  return 'bad';
}

// ---------- Temps réel : assignations et table de dessin ----------
const validTarget = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(t);
const validStroke = (s, min) =>
  s && (s.type === 'pen' || s.type === 'arrow') &&
  typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) &&
  Array.isArray(s.points) && s.points.length >= min && s.points.length <= 2000 &&
  s.points.every((p) => Array.isArray(p) && p.length === 2 &&
    p.every((n) => typeof n === 'number' && n >= 0 && n <= 1));

io.on('connection', (socket) => {
  let room = null;
  let isChef = false; // le rôle est toujours décidé par le serveur

  socket.emit('assignments', assignments);

  socket.on('auth', (code, ack) => {
    const r = checkCode(socket, code);
    if (r === 'ok') isChef = true;
    if (typeof ack === 'function') ack({ chef: isChef, error: r === 'ok' ? null : r });
  });

  socket.on('assign', (d) => {
    if (!isChef || !d) return;
    const tag = normTag(d.tag);
    if (!tag) return;
    if (Number.isInteger(d.target) && d.target >= 1 && d.target <= 50) assignments[tag] = d.target;
    else delete assignments[tag];
    save();
    io.emit('assignments', assignments);
  });

  socket.on('assign-reset', () => {
    if (!isChef) return;
    assignments = {};
    save();
    io.emit('assignments', assignments);
  });

  socket.on('join', (data, ack) => {
    const { target, code } = data || {};
    if (typeof ack !== 'function') return;
    if (!validTarget(target)) return ack({ ok: false, error: 'Numéro de base invalide.' });
    if (room) socket.leave(room);
    room = target;
    if (checkCode(socket, code) === 'ok') isChef = true;
    socket.join(room);
    ack({ ok: true, chef: isChef, state: getBoard(room) });
  });

  // Aperçu en direct pendant que le chef dessine (non conservé)
  socket.on('live', (s) => {
    if (!isChef || !room || !validStroke(s, 1)) return;
    socket.to(room).emit('live', { id: socket.id, stroke: { type: s.type, color: s.color, points: s.points } });
  });

  // Tracé terminé : conservé et envoyé à tous
  socket.on('stroke', (s) => {
    if (!isChef || !room || !validStroke(s, 2)) return;
    const b = getBoard(room);
    const stroke = { type: s.type, color: s.color, points: s.points, by: socket.id };
    b.strokes.push(stroke);
    if (b.strokes.length > MAX_STROKES) b.strokes.shift();
    io.to(room).emit('stroke', stroke);
  });

  socket.on('undo', () => {
    if (!isChef || !room) return;
    const b = getBoard(room);
    b.strokes.pop();
    io.to(room).emit('strokes', b.strokes);
  });

  socket.on('clear', () => {
    if (!isChef || !room) return;
    const b = getBoard(room);
    b.strokes = [];
    io.to(room).emit('strokes', b.strokes);
  });

  socket.on('image', (dataUrl) => {
    if (!isChef || !room) return;
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_CHARS) return;
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return;
    const b = getBoard(room);
    b.image = dataUrl;
    b.strokes = []; // nouvelle capture = nouveau tableau
    io.to(room).emit('state', b);
  });

  socket.on('disconnect', () => {
    if (room && isChef) socket.to(room).emit('live-end', socket.id);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Le port ${PORT} est déjà utilisé : change PORT dans le fichier .env.`);
  else console.error(e);
  process.exit(1);
});

// Arrêt demandé par l'hébergeur (mise à jour, mise en veille) : on termine l'écriture en cours avant de quitter.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stockage.vider().finally(() => process.exit(0)); });

stockage.charger().then(appliquerDonnees).finally(() => server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`Appli de guerre sur ce PC : http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`Sur ton téléphone (même Wi-Fi) : http://${ip}:${PORT}`));
  try {
    if (ips[0]) require('qrcode-terminal').generate(`http://${ips[0]}:${PORT}`, { small: true });
  } catch (e) { /* le QR code est facultatif */ }
  ENV_PIEGES.forEach((k) => console.log(`Attention : dans .env, ${k} commence par # sans guillemets : il est pris pour un commentaire et ignoré. Écris-le entre guillemets, par exemple ${k}="#2PP0JCCL".`));
  if (!TOKEN) console.log('Attention : CLASH_API_TOKEN manquant, la guerre ne se chargera pas (voir README).');
  if (!CLAN_TAG) console.log('Attention : CLAN_TAG manquant ou invalide (voir README).');
  if (!CHEF_CODE) console.log('Attention : CHEF_CODE manquant, le mode chef est désactivé (voir README).');
  console.log(stockage.etat.type === 'upstash' ? 'Données enregistrées dans Upstash (durables).' : 'Données enregistrées dans un fichier local (effacé si l’hébergeur redémarre le service).');
}));
