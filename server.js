const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const express = require('express');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');

// Lecture du fichier .env. Les variables déjà définies ne sont pas écrasées (la démo et les tests s'en servent).
// Piège connu : une valeur qui commence par # sans guillemets est prise pour un commentaire et devient vide.
const ENV_PIEGES = [];
try {
  const brut = fs.readFileSync(path.join(__dirname, '.env'), 'utf8').replace(/^﻿/, ''); // le Bloc-notes peut ajouter un BOM
  for (const [k, v] of Object.entries(dotenv.parse(brut))) if (process.env[k] === undefined) process.env[k] = v;
  for (const m of brut.matchAll(/^[ \t]*([A-Z_]+)[ \t]*=[ \t]*#/gm)) ENV_PIEGES.push(m[1]);
} catch (e) { /* pas de fichier .env */ }

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = (process.env.CLASH_API_TOKEN || '').trim();
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

try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (d && typeof d === 'object') {
    warKey = typeof d.warKey === 'string' ? d.warKey : null;
    if (d.assignments && typeof d.assignments === 'object') assignments = d.assignments;
  }
} catch (e) { /* premier lancement */ }
for (const [t, v] of Object.entries(assignments)) {
  if (!normTag(t) || !Number.isInteger(v) || v < 1 || v > 50) delete assignments[t];
}
const save = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify({ warKey, assignments })); } catch (e) { /* pas bloquant */ }
};

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

app.get('/api/status', (req, res) => res.json({ api: Boolean(TOKEN), clan: CLAN_TAG || null, chef: Boolean(CHEF_CODE) }));
app.get('/api/war', async (req, res) => {
  try {
    const war = simplifyWar(await coc(`/clans/${encodeURIComponent(CLAN_TAG)}/currentwar`));
    suivreGuerre(war);
    res.json(war);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Code chef : comparaison à temps constant, blocage après trop d'essais ----------
const fails = new Map(); // ip -> { n, until }
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function ipOf(socket) {
  const direct = socket.handshake.address || '';
  const h = socket.handshake.headers || {};
  const viaLocalProxy = direct === '::1' || direct === '127.0.0.1' || direct === '::ffff:127.0.0.1';
  // Les en-têtes d'un tunnel (Cloudflare, ngrok) ne sont crus que s'ils viennent du tunnel local.
  return (viaLocalProxy && (h['cf-connecting-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim())) || direct;
}

function checkCode(socket, code) {
  if (!CHEF_CODE) return 'off';
  const ip = ipOf(socket);
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

server.listen(PORT, '0.0.0.0', () => {
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
});
