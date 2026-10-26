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
const G = require('./lib/guerres');
const A = require('./lib/activite');
const R = require('./lib/raids');
const L = require('./lib/ldc');
const SC = require('./lib/scout');
const N = require('./lib/notifs');
const ARMEE = require('./lib/armee');
let webpush = null;
try { webpush = require('web-push'); } catch (e) { /* notifications push indisponibles */ }
// NOTIFS_TEST (tests automatiques uniquement) autorise des adresses locales en http pour Discord et les notifications.
const LOCAL_TEST = (u) => process.env.NOTIFS_TEST === '1' && /^http:\/\/127\.0\.0\.1:\d+\//.test(u || '');
const DISCORD = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(process.env.DISCORD_WEBHOOK_URL || '') || LOCAL_TEST(process.env.DISCORD_WEBHOOK_URL) ? process.env.DISCORD_WEBHOOK_URL : '';

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
let guerres = [];     // archives des guerres (classiques et ligue), pour l'historique et les statistiques
let activite = A.nouvelEtat(); // relevés d'activité des membres
let chat = [];        // messages du chat de l'appli
let abonnements = []; // abonnements aux notifications { id, sub, tag, prefs, cree }
let vapid = null;     // clés des notifications (créées une fois)
let notifsEnvoyees = {}; // registre anti-doublon des notifications
const MAX_GUERRES = 40;

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
  if (Array.isArray(d.guerres)) guerres = d.guerres.filter((g) => g && typeof g.id === 'string' && Array.isArray(g.m));
  if (d.activite && typeof d.activite === 'object' && d.activite.membres) activite = d.activite;
  if (Array.isArray(d.chat)) chat = d.chat.slice(-300);
  if (Array.isArray(d.abonnements)) abonnements = d.abonnements.filter((a) => a && a.sub && a.sub.endpoint);
  if (d.vapid && d.vapid.publicKey) vapid = d.vapid;
  if (d.notifsEnvoyees && typeof d.notifsEnvoyees === 'object') notifsEnvoyees = d.notifsEnvoyees;
  for (const [t, v] of Object.entries(assignments)) {
    if (!normTag(t) || !Number.isInteger(v) || v < 1 || v > 50) delete assignments[t];
  }
  const limite = Date.now() - SESSION_JOURS * D.JOUR;
  for (const [k, v] of Object.entries(sessions)) if (!v || Date.parse(v.vu || v.cree) < limite) delete sessions[k];
}
const save = () => stockage.enregistrer({ version: 4, warKey, assignments, periodes, reponses, sessions, guerres, activite, chat, abonnements, vapid, notifsEnvoyees });

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
  if (CACHE_MS === 0) ttl = 0; // CACHE_MS=0 : aucun cache (tests, diagnostic)
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

// ---------- Archives des guerres ----------
// Chaque fois que la guerre en cours est lue, son état est enregistré : à la fin, toutes les attaques restent consultables.
function archiver(brute, type, warTag) {
  const id = type === 'l' ? 'l-' + String(warTag || '').replace('#', '') : 'c-' + (brute && (brute.preparationStartTime || brute.startTime));
  const i = guerres.findIndex((g) => g.id === id);
  const a = G.archiverGuerre(brute, { type, warTag, ancienne: i >= 0 ? guerres[i] : null });
  if (!a || a.etat === 'preparation') return null;
  if (i >= 0) {
    const sans = (g) => JSON.stringify({ ...g, maj: 0 });
    if (sans(guerres[i]) === sans(a)) return guerres[i]; // rien de neuf : pas d'écriture
    guerres[i] = a;
  } else guerres.push(a);
  guerres.sort((x, y) => Date.parse(y.debut || y.prep) - Date.parse(x.debut || x.prep));
  if (guerres.length > MAX_GUERRES) guerres.length = MAX_GUERRES;
  save();
  return a;
}
// Ligue de guerre de clans : 7 journées, une attaque par joueur. Les guerres terminées ne changent plus (cache long).
async function suivreLigue() {
  let groupe;
  try { groupe = await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/currentwar/leaguegroup`, 5 * 60e3); } catch (e) { return; }
  if (!groupe || !Array.isArray(groupe.rounds)) return;
  for (const r of groupe.rounds) for (const tag of r.warTags || []) {
    if (!tag || tag === '#0') continue;
    const deja = guerres.find((g) => g.id === 'l-' + tag.replace('#', ''));
    if (deja && deja.etat === 'warEnded') continue;
    let w;
    try { w = await coc(`/clanwarleagues/wars/${encodeURIComponent(tag)}`, 5 * 60e3); } catch (e) { continue; }
    if (!w || !w.clan || !w.opponent) continue;
    if (w.opponent.tag === CLAN_TAG) [w.clan, w.opponent] = [w.opponent, w.clan]; // notre clan toujours à gauche
    if (w.clan.tag === CLAN_TAG) archiver(w, 'l', tag);
  }
}
// Relève automatique toutes les 5 minutes tant que le serveur est réveillé.
// ---------- Notifications (push + Discord) ----------
let envoyeur = N.creerEnvoyeur({ discordUrl: DISCORD });
// Appelé une fois les données chargées : les clés VAPID sont créées une seule fois puis réutilisées.
// Sauvegarde GitHub (branche « donnees » du dépôt, écrite par le relevé automatique) : relue au démarrage,
// pour qu'aucune guerre ne soit perdue si l'hébergeur a effacé ses fichiers.
const SAUVEGARDE_URL = process.env.SAUVEGARDE_URL || (process.env.RENDER_GIT_REPO_SLUG ? `https://raw.githubusercontent.com/${process.env.RENDER_GIT_REPO_SLUG}/donnees/guerres.json` : '');
async function restaurerSauvegarde() {
  if (!SAUVEGARDE_URL) return;
  try {
    const r = await fetch(SAUVEGARDE_URL, { signal: AbortSignal.timeout(15000), cache: 'no-store' });
    if (!r.ok) return;
    const d = await r.json();
    if (d.clan && CLAN_TAG && d.clan !== CLAN_TAG) return; // sauvegarde d'un autre clan
    const f = G.fusionner(guerres, d.guerres);
    if (f.ajouts) { guerres = f.guerres; save(); console.log(`Sauvegarde GitHub : ${f.ajouts} guerre(s) récupérée(s).`); }
  } catch (e) { console.error('Sauvegarde GitHub illisible :', e.message); }
}

function initNotifs() {
  if (webpush && !vapid) { vapid = webpush.generateVAPIDKeys(); save(); }
  envoyeur = N.creerEnvoyeur({ webpush, vapid, contact: process.env.VAPID_CONTACT, discordUrl: DISCORD,
    retirer: (id) => { abonnements = abonnements.filter((a) => a.id !== id); save(); } });
}
async function notifier(evenements) {
  const nouveaux = N.filtrerNouveaux(evenements, notifsEnvoyees);
  if (!nouveaux.length) return [];
  save();
  for (const e of nouveaux) {
    await envoyeur.pousser(abonnements, e);
    if (e.discord) await envoyeur.discord(`**${e.titre}**\n${e.corps}`);
  }
  return nouveaux;
}

// Relevé de l'activité : liste des membres à chaque relève, profils détaillés toutes les 6 heures.
let profilsEnCours = false;
async function releverActivite() {
  const clan = await clanActuel();
  const brut = (await coc(`/clans/${encodeURIComponent(CLAN_TAG)}`, 60000)).memberList || [];
  const evts = A.releverMembres(activite, brut);
  if (evts.length) {
    save();
    const lignes = evts.filter((e) => e.type === 'arrivee' || e.type === 'depart').map((e) => (e.type === 'arrivee' ? `➕ ${e.nom} a rejoint le clan` : `➖ ${e.nom} a quitté le clan`));
    if (lignes.length) envoyeur.discord(lignes.join('\n'));
  }
  const dernier = activite.dernierProfil ? Date.parse(activite.dernierProfil) : 0;
  if (!profilsEnCours && Date.now() - dernier > 6 * 3600e3) {
    profilsEnCours = true;
    try { A.releverProfils(activite, await profils(clan.members.map((m) => m.tag), 3 * 3600e3)); save(); } finally { profilsEnCours = false; }
  }
}
// Profils de plusieurs joueurs, 5 appels à la fois au plus (l'API limite le nombre de requêtes par seconde).
async function profils(tags, ttl = 30 * 60e3) {
  const out = [], file = [...tags];
  await Promise.all(Array.from({ length: 5 }, async () => {
    while (file.length) {
      const t = file.shift();
      try { out.push(await coc(`/players/${encodeURIComponent(t)}`, ttl)); } catch (e) { /* joueur indisponible */ }
    }
  }));
  return out;
}

async function releve() {
  if (!TOKEN || !CLAN_TAG) return;
  try {
    const w = await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/currentwar`);
    archiver(w, 'c');
    await notifier(N.evenementsGuerre(w));
    if (!w || w.state === 'notInWar') await suivreLigue();
  } catch (e) { /* API indisponible : prochaine fois */ }
  try { await releverActivite(); } catch (e) { /* idem */ }
  try {
    const r = await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/capitalraidseasons?limit=1`, 30 * 60e3);
    const membres = (await clanActuel()).members;
    await notifier(N.evenementsRaids((r.items || [])[0], membres));
  } catch (e) { /* idem */ }
  try {
    const p = D.periodeCourante(periodes);
    if (p) {
      let membres = [];
      try { membres = (await clanActuel()).members; } catch (e) { /* liste indisponible */ }
      await notifier(N.evenementsDispos(p, D.statutPeriode(p), reponses[p.id], membres));
    }
  } catch (e) { /* idem */ }
}
setInterval(releve, 5 * 60e3).unref();
// Ligue : vérifiée au plus une fois par minute quand quelqu'un ouvre l'appli hors guerre classique.
let derniereLigue = 0;
function ligueSiBesoin() {
  if (Date.now() - derniereLigue < (CACHE_MS === 0 ? 0 : 60e3) || !TOKEN || !CLAN_TAG) return Promise.resolve();
  derniereLigue = Date.now();
  return suivreLigue().catch(() => {});
}

const FR_HEROS = { 'Barbarian King': 'Roi des Barbares', 'Archer Queen': 'Reine des Archers', 'Grand Warden': 'Grand Gardien', 'Royal Champion': 'Championne Royale', 'Minion Prince': 'Prince Gargouille' };
const SIEGES = { 'Wall Wrecker': 'Démolisseur', 'Battle Blimp': 'Dirigeable de combat', 'Stone Slammer': 'Stone Slammer', 'Siege Barracks': 'Caserne de siège', 'Log Launcher': 'Lance-bûches', 'Flame Flinger': 'Flame Flinger', 'Battle Drill': 'Battle Drill', 'Troop Launcher': 'Troop Launcher' };
const FAMILIERS = new Set(['L.A.S.S.I', 'Electro Owl', 'Mighty Yak', 'Unicorn', 'Frosty', 'Diggy', 'Poison Lizard', 'Phoenix', 'Spirit Fox', 'Angry Jelly', 'Sneezy']);
const ROLES_API = { leader: 'leader', coLeader: 'coLeader', admin: 'admin', member: 'member' };
function profilJoueur(p) {
  const maison = (l) => (l || []).filter((x) => x.village === 'home');
  const troupes = maison(p.troops);
  return {
    tag: p.tag, nom: p.name, th: p.townHallLevel || null, armeHdv: p.townHallWeaponLevel || null, niveau: p.expLevel || null,
    trophees: p.trophies || 0, recordTrophees: p.bestTrophies || 0, etoilesGuerre: p.warStars || 0,
    attaquesGagnees: p.attackWins || 0, defensesGagnees: p.defenseWins || 0, dons: p.donations || 0, donsRecus: p.donationsReceived || 0,
    role: ROLES_API[p.role] || null, preferenceGuerre: p.warPreference === 'in' ? 'in' : p.warPreference === 'out' ? 'out' : null,
    ligue: p.league && p.league.name ? p.league.name : null, clan: p.clan ? p.clan.name : null,
    heros: maison(p.heroes).map((h) => ({ nom: h.name, nomFr: FR_HEROS[h.name] || h.name, niveau: h.level, max: h.maxLevel,
      equipements: (h.equipment || []).map((e) => ({ nom: e.name, niveau: e.level, max: e.maxLevel })) })),
    sieges: troupes.filter((t) => SIEGES[t.name]).map((t) => ({ nom: SIEGES[t.name], niveau: t.level, max: t.maxLevel })),
    familiers: troupes.filter((t) => FAMILIERS.has(t.name)).map((t) => ({ nom: t.name, niveau: t.level, max: t.maxLevel })),
    troupes: { total: troupes.filter((t) => !SIEGES[t.name] && !FAMILIERS.has(t.name) && !/^Super /.test(t.name)).length,
      auMax: troupes.filter((t) => !SIEGES[t.name] && !FAMILIERS.has(t.name) && !/^Super /.test(t.name) && t.level >= t.maxLevel).length },
    sorts: { total: maison(p.spells).length, auMax: maison(p.spells).filter((t) => t.level >= t.maxLevel).length },
  };
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
    const brute = await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/currentwar`);
    archiver(brute, 'c');
    notifier(N.evenementsGuerre(brute)).catch(() => {});
    if (!brute || brute.state === 'notInWar') ligueSiBesoin();
    const war = simplifyWar(brute);
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

// ---------- Historique, statistiques, fiches joueurs ----------
const entier = (v, def, max) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : def; };
const typeGuerre = (v) => (v === 'c' || v === 'l' ? v : 'tous');
api.get('/guerres', async (req, res) => {
  await ligueSiBesoin();
  // Journal officiel (résultats seuls, y compris avant l'installation de l'appli) fusionné avec nos archives détaillées.
  let journal = [], erreurJournal = null;
  try { journal = ((await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/warlog?limit=40`, 10 * 60e3)).items) || []; } catch (e) { erreurJournal = e.message; }
  const liste = guerres.map(G.resume);
  const fins = new Set(guerres.map((g) => g.fin));
  for (const w of journal) {
    const fin = G.tdate(w.endTime);
    if (!fin || fins.has(fin)) continue;
    const ligue = !w.opponent || !w.opponent.name;
    const clan = { n: w.clan && w.clan.name, t: w.clan && w.clan.tag, e: (w.clan && w.clan.stars) || 0, p: Math.round(((w.clan && w.clan.destructionPercentage) || 0) * 100) / 100, a: (w.clan && w.clan.attacks) || 0, b: null };
    const adv = { n: ligue ? 'Ligue de guerre' : w.opponent.name, t: (w.opponent && w.opponent.tag) || '', e: (w.opponent && w.opponent.stars) || 0, p: Math.round(((w.opponent && w.opponent.destructionPercentage) || 0) * 100) / 100, b: w.opponent && w.opponent.badgeUrls ? w.opponent.badgeUrls.small : null };
    liste.push({ id: 'j-' + w.endTime, type: ligue ? 'l' : 'c', etat: 'warEnded', debut: null, fin, taille: w.teamSize, apm: w.attacksPerMember || (ligue ? 1 : 2), clan, adv,
      res: w.result === 'win' ? 'victoire' : w.result === 'lose' ? 'defaite' : w.result === 'tie' ? 'egalite' : null, details: false, mvp: null });
  }
  liste.sort((a, b) => Date.parse(b.fin || b.debut) - Date.parse(a.fin || a.debut));
  res.json({ guerres: liste, archives: guerres.length, erreurJournal });
});
api.get('/guerres/:id', (req, res) => {
  const g = guerres.find((x) => x.id === req.params.id);
  if (!g) return erreur(res, 404, 'Guerre introuvable (seules les guerres suivies par l’appli ont le détail des attaques).');
  res.json({ guerre: { ...g, m: g.m.map((m) => ({ ...m, a: m.a.map((a) => ({ ...a, armee: ARMEE.detailler(a.ar) })) })) }, mvp: G.mvp(g) });
});
api.get('/stats', async (req, res) => {
  const opts = { derniers: entier(req.query.derniers, 0, MAX_GUERRES), type: typeGuerre(req.query.type) };
  const { joueurs, guerres: n } = G.statsJoueurs(guerres, opts);
  let actuels = null;
  try { actuels = new Set((await clanActuel()).members.map((m) => m.tag)); } catch (e) { /* liste indisponible */ }
  res.json({ joueurs: joueurs.map((j) => ({ ...j, membre: actuels ? actuels.has(j.tag) : null })), clan: G.statsClan(guerres, opts), guerres: n, poids: G.POIDS });
});
api.get('/compos', (req, res) => res.json({ compos: G.COMPOS }));
api.get('/joueurs/:tag', async (req, res) => {
  const tag = normTag(req.params.tag);
  if (!tag) return erreur(res, 400, 'Joueur invalide.');
  let profil = null, erreurProfil = null;
  try { profil = profilJoueur(await coc(`/players/${encodeURIComponent(tag)}`, 10 * 60e3)); } catch (e) { erreurProfil = e.message; }
  const stats = G.statsJoueurs(guerres).joueurs.find((j) => j.tag === tag) || null;
  const attaques = [];
  for (const g of guerres) {
    const m = g.m.find((x) => x.t === tag);
    if (!m) continue;
    attaques.push({ guerre: g.id, type: g.type, debut: g.debut, adv: g.adv.n, res: g.res, apm: g.apm, finie: g.etat === 'warEnded', pos: m.pos, th: m.th, a: m.a.map((a) => ({ ...a, armee: ARMEE.detailler(a.ar) })), de: m.de });
  }
  if (!profil && !stats) return erreur(res, erreurProfil ? 502 : 404, erreurProfil || 'Joueur introuvable.');
  res.json({ tag, profil, erreurProfil, stats, guerres: attaques.slice(0, 20), compos: G.COMPOS });
});
// La compo utilisée n'est pas fournie par l'API : le joueur (pour lui-même) ou le chef la renseigne.
api.put('/guerres/:id/compo', (req, res) => {
  const g = guerres.find((x) => x.id === req.params.id);
  if (!g) return erreur(res, 404, 'Guerre introuvable.');
  const tag = normTag(req.body && req.body.tag), ordre = Number(req.body && req.body.ordre);
  let compo = req.body && req.body.compo, armee = null;
  if (!tag || !Number.isInteger(ordre)) return erreur(res, 400, 'Attaque invalide.');
  if (req.body && req.body.lien) { // lien d'armée du jeu : compo devinée et composition exacte enregistrée
    const d = ARMEE.decoderLien(req.body.lien);
    if (!d) return erreur(res, 400, 'Lien d’armée illisible.');
    compo = d.compo; armee = ARMEE.compacter(d);
  }
  if (compo !== null && !G.COMPOS.includes(compo)) return erreur(res, 400, 'Compo inconnue.');
  const s = sessionDe(req);
  const chef = req.get('x-chef') ? checkCode(ipReq(req), req.get('x-chef')) === 'ok' : false;
  if (!chef && !(s && s.tag === tag)) return erreur(res, 403, 'Seul le joueur lui-même (identifié) ou le chef peut indiquer sa compo.');
  const m = g.m.find((x) => x.t === tag), a = m && m.a.find((x) => x.o === ordre);
  if (!a) return erreur(res, 404, 'Attaque introuvable.');
  if (compo === null) { delete a.c; delete a.ar; } else { a.c = compo; if (armee) a.ar = armee; else if (req.body.lien === undefined) delete a.ar; }
  save(); io.emit('guerres');
  res.json({ ok: true, compo, armee: armee ? ARMEE.detailler(armee) : null });
});

// ---------- Guerres d'avant l'appli : saisie par le chef ----------
api.post('/guerres/manuelle', exigerChef, async (req, res) => {
  let clan = null;
  try { clan = await clanActuel(); } catch (e) { /* nom du clan par défaut */ }
  const v = G.guerreManuelle(req.body, clan || {});
  if (v.erreur) return erreur(res, 400, v.erreur);
  guerres = guerres.filter((g) => g.id !== v.valeur.id);
  guerres.push(v.valeur);
  guerres.sort((x, y) => Date.parse(y.debut || y.prep) - Date.parse(x.debut || x.prep));
  save(); io.emit('guerres');
  res.status(201).json({ guerre: G.resume(v.valeur) });
});
api.delete('/guerres/:id', exigerChef, (req, res) => {
  const g = guerres.find((x) => x.id === req.params.id);
  if (!g) return erreur(res, 404, 'Guerre introuvable.');
  if (!g.manuelle) return erreur(res, 403, 'Seules les guerres saisies à la main peuvent être supprimées.');
  guerres = guerres.filter((x) => x !== g); save(); io.emit('guerres');
  res.json({ ok: true });
});
// Tableau joueurs × guerres : qui a attaqué, combien d'étoiles, qui a raté ses attaques.
api.get('/grille', async (req, res) => {
  const type = typeGuerre(req.query.type), n = entier(req.query.derniers, 10, MAX_GUERRES) || MAX_GUERRES;
  const liste = guerres.filter((g) => g.etat !== 'preparation' && (type === 'tous' || g.type === type))
    .sort((a, b) => Date.parse(b.fin || b.debut || b.prep) - Date.parse(a.fin || a.debut || a.prep)).slice(0, n);
  let actuels = null;
  try { actuels = (await clanActuel()).members; } catch (e) { /* liste indisponible */ }
  const joueurs = new Map();
  const ligne = (tag, nom, th) => { if (!joueurs.has(tag)) joueurs.set(tag, { tag, nom, th, cellules: {}, totaux: { attaques: 0, possibles: 0, etoiles: 0, triples: 0, manquees: 0, guerres: 0 } }); return joueurs.get(tag); };
  for (const m of actuels || []) ligne(m.tag, m.name, m.th);
  for (const g of liste) {
    const finie = g.etat === 'warEnded';
    for (const m of g.m) {
      const l = ligne(m.t, m.n, m.th);
      const rate = finie ? Math.max(0, g.apm - m.a.length) : 0;
      l.cellules[g.id] = { a: m.a.map((a) => ({ e: a.e, p: Math.round(a.p), b: a.dpos })), rate, enCours: !finie };
      const t = l.totaux;
      t.guerres++; t.attaques += m.a.length; t.possibles += finie ? Math.max(g.apm, m.a.length) : m.a.length; t.manquees += rate;
      for (const a of m.a) { t.etoiles += a.e; if (a.e === 3) t.triples++; }
    }
  }
  const membres = actuels ? new Set(actuels.map((m) => m.tag)) : null;
  const res2 = [...joueurs.values()].map((j) => ({ ...j, membre: membres ? membres.has(j.tag) : null }))
    .filter((j) => j.totaux.guerres > 0 || j.membre)
    .sort((a, b) => (b.membre === true) - (a.membre === true) || b.totaux.etoiles - a.totaux.etoiles || a.nom.localeCompare(b.nom));
  res.json({ guerres: liste.map((g) => ({ id: g.id, fin: g.fin, debut: g.debut, adv: g.adv.n, res: g.res, apm: g.apm, type: g.type, manuelle: Boolean(g.manuelle), enCours: g.etat !== 'warEnded', nous: g.clan.e, eux: g.adv.e })), joueurs: res2 });
});
// Export public des archives (données de jeu publiques) : utilisé par la sauvegarde automatique sur GitHub.
api.get('/export/guerres', (req, res) => res.json({ version: 1, exporte: new Date().toISOString(), clan: CLAN_TAG, guerres }));

// ---------- Lien d'armée → compo ----------
api.post('/armee', (req, res) => {
  const d = ARMEE.decoderLien(req.body && req.body.lien);
  if (!d) return erreur(res, 400, 'Ce n’est pas un lien d’armée Clash of Clans (bouton « Partager » de l’armée dans le jeu).');
  res.json(d);
});

// ---------- Raids du Capital ----------
api.get('/raids', async (req, res) => {
  let brut;
  try { brut = await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/capitalraidseasons?limit=10`, 15 * 60e3); } catch (e) { return erreur(res, e.status || 502, e.message); }
  const saisons = (brut.items || []).map(R.saison);
  let membres = null;
  try { membres = (await clanActuel()).members; } catch (e) { /* liste indisponible */ }
  res.json({ saisons, bilan: R.bilanRaids(saisons, membres, { derniers: entier(req.query.derniers, 0, 10) }) });
});

// ---------- Activité des membres (réservé au chef) ----------
api.get('/activite', exigerChef, async (req, res) => {
  try { await releverActivite(); } catch (e) { /* on affiche le dernier relevé connu */ }
  res.json(A.vueActivite(activite));
});

// ---------- Ligue de guerre : groupe, classement, calendrier ----------
api.get('/ldc', async (req, res) => {
  let groupe;
  try { groupe = await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/currentwar/leaguegroup`, 5 * 60e3); }
  catch (e) { return res.json({ groupe: null, raison: e.status === 404 ? 'Pas de ligue de guerre en cours.' : e.message }); }
  const guerresParTag = {};
  for (const r of groupe.rounds || []) for (const tag of r.warTags || []) {
    if (!tag || tag === '#0') continue;
    const deja = guerres.find((g) => g.id === 'l-' + tag.replace('#', ''));
    try { guerresParTag[tag] = await coc(`/clanwarleagues/wars/${encodeURIComponent(tag)}`, deja && deja.etat === 'warEnded' ? 12 * 3600e3 : 5 * 60e3); } catch (e) { /* guerre indisponible */ }
  }
  const liste = Object.values(guerresParTag);
  res.json({ saison: groupe.season || null, etat: groupe.state || null, classement: L.classementGroupe(groupe, liste), calendrier: L.calendrier(groupe, guerresParTag, CLAN_TAG),
    clans: (groupe.clans || []).map((c) => ({ tag: c.tag, nom: c.name, niveau: c.clanLevel, badge: c.badgeUrls ? c.badgeUrls.small : null,
      hdv: (c.members || []).reduce((h, m) => { h[m.townHallLevel] = (h[m.townHallLevel] || 0) + 1; return h; }, {}) })) });
});

// ---------- Repérage de l'adversaire et proposition de cibles ----------
api.get('/reperage', async (req, res) => {
  let w;
  try { w = await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/currentwar`); } catch (e) { return erreur(res, e.status || 502, e.message); }
  if (!w || !w.opponent || !['preparation', 'inWar'].includes(w.state)) return res.json({ guerre: null });
  const tous = [...(w.clan.members || []), ...(w.opponent.members || [])].map((m) => m.tag);
  const p = new Map((await profils(tous, 30 * 60e3)).map((x) => [x.tag, x]));
  const fiche = (m) => {
    const f = p.get(m.tag) ? SC.force(p.get(m.tag)) : { th: m.townhallLevel, heros: 0, force: (m.townhallLevel || 0) * 100, detailHeros: [], etoilesGuerre: 0 };
    return { tag: m.tag, nom: m.name, pos: m.mapPosition, ...f, th: m.townhallLevel || f.th, triplee: (m.bestOpponentAttack && m.bestOpponentAttack.stars === 3) || false, attaques: (m.attacks || []).length };
  };
  const nous = (w.clan.members || []).map(fiche).sort((a, b) => a.pos - b.pos);
  const eux = (w.opponent.members || []).map(fiche).sort((a, b) => a.pos - b.pos);
  // Les bases déjà à 3 étoiles (côté adverse) sont celles visées par des attaques à 3 étoiles de notre clan.
  const triplees = new Set();
  for (const m of w.clan.members || []) for (const a of m.attacks || []) if (a.stars === 3) triplees.add(a.defenderTag);
  let clanAdv = null, journalAdv = null;
  try {
    const c = await coc(`/clans/${encodeURIComponent(w.opponent.tag)}`, 60 * 60e3);
    clanAdv = { nom: c.name, niveau: c.clanLevel, victoires: c.warWins || 0, serie: c.warWinStreak || 0, defaites: c.warLosses ?? null, ligue: c.warLeague ? c.warLeague.name : null, journalPublic: c.isWarLogPublic !== false, pays: c.location ? c.location.name : null };
    if (c.isWarLogPublic) {
      const j = ((await coc(`/clans/${encodeURIComponent(w.opponent.tag)}/warlog?limit=10`, 60 * 60e3)).items) || [];
      const finies = j.filter((x) => x.result);
      journalAdv = { guerres: finies.length, victoires: finies.filter((x) => x.result === 'win').length, moyEtoiles: finies.length ? Math.round((10 * finies.reduce((s2, x) => s2 + (x.clan.stars || 0), 0)) / finies.length) / 10 : null };
    }
  } catch (e) { /* clan adverse indisponible */ }
  const plan = SC.proposer(nous.filter((m) => m.attaques < (w.attacksPerMember || 2)), eux, { dejaTriplees: triplees });
  res.json({ guerre: { etat: w.state, taille: w.teamSize, adv: w.opponent.name }, nous, eux: eux.map((o) => ({ ...o, triplee: triplees.has(o.tag) })), clanAdv, journalAdv, plan });
});

// ---------- Saison (Pass or) ----------
api.get('/saison', async (req, res) => {
  try { const g = await coc('/goldpass/seasons/current', 6 * 3600e3); res.json({ debut: G.tdate(g.startTime), fin: G.tdate(g.endTime) }); }
  catch (e) { erreur(res, e.status || 502, e.message); }
});

// ---------- Chat de l'appli ----------
const dernierMessage = new Map();
const auteurDe = (req) => {
  const s = sessionDe(req);
  const chef = req.get('x-chef') ? checkCode(ipReq(req), req.get('x-chef')) === 'ok' : false;
  if (!s && !chef) return null;
  return { tag: s ? s.tag : null, nom: s ? s.nom : 'Chef', chef };
};
api.get('/chat', (req, res) => res.json({ messages: chat.slice(-100) }));
api.post('/chat', async (req, res) => {
  const auteur = auteurDe(req);
  if (!auteur) return erreur(res, 401, 'Identifie-toi (écran Signe / Non) pour écrire dans le chat.');
  const texte = String((req.body && req.body.texte) || '').replace(/\s+$/g, '').slice(0, 500);
  if (!texte.trim()) return erreur(res, 400, 'Message vide.');
  const annonce = Boolean(req.body && req.body.annonce);
  if (annonce && !auteur.chef) return erreur(res, 403, 'Seul le chef peut faire une annonce.');
  const cleAuteur = auteur.tag || 'chef';
  if (Date.now() - (dernierMessage.get(cleAuteur) || 0) < 2000) return erreur(res, 429, 'Doucement : un message toutes les 2 secondes.');
  dernierMessage.set(cleAuteur, Date.now());
  const m = { id: crypto.randomBytes(6).toString('hex'), le: new Date().toISOString(), auteur, texte, annonce };
  chat.push(m); if (chat.length > 300) chat.splice(0, chat.length - 300);
  save(); io.emit('chat', m);
  let envoyes = 0, discord = false;
  if (annonce) {
    envoyes = await envoyeur.pousser(abonnements, { cle: 'annonce:' + m.id, type: 'annonces', titre: '📣 Annonce du chef', corps: texte.slice(0, 180), url: '/chat.html' });
    discord = await envoyeur.discord(`📣 **Annonce du chef**\n${texte}`);
  }
  res.status(201).json({ message: m, envoyes, discord });
});
api.delete('/chat/:id', exigerChef, (req, res) => {
  const i = chat.findIndex((m) => m.id === req.params.id);
  if (i < 0) return erreur(res, 404, 'Message introuvable.');
  chat.splice(i, 1); save(); io.emit('chat-suppr', req.params.id);
  res.json({ ok: true });
});

// ---------- Abonnements aux notifications ----------
const idAbonnement = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);
const prefsValides = (p) => Object.fromEntries(N.TYPES.map((t) => [t, !(p && p[t] === false)]));
api.get('/notifs', (req, res) => res.json({ disponible: Boolean(webpush && vapid), cle: vapid ? vapid.publicKey : null, discord: Boolean(DISCORD), types: N.TYPES }));
api.post('/notifs/abonnement', (req, res) => {
  const sub = req.body && req.body.sub;
  if (!sub || typeof sub.endpoint !== 'string' || !(/^https:\/\//.test(sub.endpoint) || LOCAL_TEST(sub.endpoint)) || sub.endpoint.length > 1000 || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return erreur(res, 400, 'Abonnement invalide.');
  const s = sessionDe(req), id = idAbonnement(sub.endpoint);
  abonnements = abonnements.filter((a) => a.id !== id);
  abonnements.push({ id, sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh.slice(0, 200), auth: sub.keys.auth.slice(0, 100) } }, tag: s ? s.tag : null, prefs: prefsValides(req.body.prefs), cree: new Date().toISOString() });
  if (abonnements.length > 500) abonnements.shift();
  save();
  res.status(201).json({ id, tag: s ? s.tag : null });
});
api.patch('/notifs/abonnement', (req, res) => {
  const a = abonnements.find((x) => x.id === idAbonnement(req.body && req.body.endpoint));
  if (!a) return erreur(res, 404, 'Abonnement introuvable.');
  a.prefs = prefsValides(req.body.prefs);
  const s = sessionDe(req); if (s) a.tag = s.tag;
  save(); res.json({ ok: true, prefs: a.prefs });
});
api.delete('/notifs/abonnement', (req, res) => {
  const id = idAbonnement(req.body && req.body.endpoint);
  abonnements = abonnements.filter((a) => a.id !== id); save();
  res.json({ ok: true });
});
api.post('/notifs/test', async (req, res) => {
  const a = abonnements.find((x) => x.id === idAbonnement(req.body && req.body.endpoint));
  if (!a) return erreur(res, 404, 'Abonnement introuvable.');
  const n = await envoyeur.pousser([a], { cle: 'test', type: 'annonces', titre: '✅ Notifications actives', corps: 'Tu recevras les alertes de guerre ici.', url: '/menu.html' });
  res.json({ envoyes: n });
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

stockage.charger().then(appliquerDonnees).finally(initNotifs).finally(() => server.listen(PORT, '0.0.0.0', () => {
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
  restaurerSauvegarde();
  setTimeout(releve, 60e3).unref();
  console.log(stockage.etat.type === 'upstash' ? 'Données enregistrées dans Upstash (durables).' : 'Données enregistrées dans un fichier local (effacé si l’hébergeur redémarre le service).');
}));
