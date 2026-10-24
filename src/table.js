// Le « serveur » de la table de guerre sur Cloudflare : un seul Durable Object qui garde les cibles, les dessins
// et les connexions temps réel de tout le clan. Même comportement que server.js (version PC), avec en plus :
// tout est enregistré dans la base du Durable Object (cibles, dessins et captures survivent aux mises en veille).
import { DurableObject } from 'cloudflare:workers';
import { createHash, timingSafeEqual } from 'node:crypto';
import { normTag, simplifyWar, validTarget, validStroke, frMessage, lireConfig } from './core.js';

const MAX_IMAGE_CHARS = 1_900_000;    // Cloudflare limite une ligne de stockage à 2 Mo
const MAX_MESSAGE_CHARS = 2_000_000;  // plus gros que la plus grosse capture acceptée : message refusé
const MAX_STROKES = 500;
const MAX_SOCKETS = 300;
const IMAGE_OK = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

const sha = (s) => createHash('sha256').update(String(s)).digest();
const nouvelId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);
const erreur = (status, message) => Object.assign(new Error(message), { status });
const json = (corps, status = 200) => new Response(JSON.stringify(corps), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cfg = lireConfig(env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS strokes (id INTEGER PRIMARY KEY AUTOINCREMENT, board TEXT NOT NULL, data TEXT NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS strokes_board ON strokes (board, id)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS images (board TEXT PRIMARY KEY, data TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS fails (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)');

    // Cibles { '#TAGJOUEUR': numéroDeBase } et identifiant de la guerre dont elles viennent
    this.cibles = {};
    this.warKey = null;
    for (const r of this.sql.exec('SELECT k, v FROM kv')) {
      if (r.k === 'warKey') this.warKey = r.v;
      else if (r.k === 'assignments') { try { this.cibles = JSON.parse(r.v); } catch (e) { /* données illisibles : on repart de zéro */ } }
    }
    if (!this.cibles || typeof this.cibles !== 'object' || Array.isArray(this.cibles)) this.cibles = {};
    for (const [t, v] of Object.entries(this.cibles)) {
      if (!normTag(t) || !Number.isInteger(v) || v < 1 || v > 50) delete this.cibles[t];
    }

    // Une connexion par appareil. Quand le Durable Object se met en veille, les connexions restent ouvertes :
    // on les retrouve ici, avec leur état (identifiant, rôle chef, base regardée) gardé dans « l'attachment ».
    this.sessions = new Map();
    for (const ws of ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      this.sessions.set(ws, a && typeof a === 'object' ? a : { id: nouvelId(), chef: false, room: null, ip: '' });
    }
    // « ping » reçoit « pong » sans réveiller le Durable Object (le téléphone s'en sert pour savoir si la connexion vit encore)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    this.cache = new Map();    // réponses de l'API Clash (en mémoire : un simple gain de temps)
    this.enCours = new Map();  // appels à l'API Clash déjà partis (évite d'en lancer deux pour la même route)
    this.gestionnaires = new Map([
      ['auth', this.#auth], ['assign', this.#assigner], ['assign-reset', this.#toutRetirer], ['join', this.#rejoindre],
      ['live', this.#direct], ['stroke', this.#trait], ['undo', this.#annuler], ['clear', this.#effacer], ['image', this.#image],
    ]);
  }

  // ---------- HTTP ----------
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/ws') return this.#ouvrirSocket(request);
    if (pathname === '/api/status') {
      return json({ api: Boolean(this.cfg.token), clan: this.cfg.clan || null, chef: Boolean(this.cfg.chefCode) });
    }
    if (pathname === '/api/war') {
      try {
        return json(await this.#guerre());
      } catch (e) {
        if (e && e.status) return json({ error: e.message }, e.status);
        console.error('Erreur inattendue sur /api/war :', e && e.message);
        return json({ error: 'Erreur interne du serveur.' }, 500);
      }
    }
    return json({ error: 'Introuvable.' }, 404);
  }

  #ouvrirSocket(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Connexion WebSocket attendue.', { status: 426 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Trop de connexions.', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    // cf-connecting-ip est posé par Cloudflare (un visiteur ne peut pas le falsifier) : il sert au blocage des mauvais codes
    const s = { id: nouvelId(), chef: false, room: null, ip: request.headers.get('cf-connecting-ip') || '' };
    this.#memoriser(server, s);
    this.#envoyer(server, 'assignments', this.cibles);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------- Connexions ----------
  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return; // pas de messages binaires
    if (raw.length > MAX_MESSAGE_CHARS) {
      this.#retirer(ws);
      try { ws.close(1009, 'Message trop gros'); } catch (e) { /* déjà fermée */ }
      return;
    }
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.e !== 'string') return;
    const gestionnaire = this.gestionnaires.get(m.e);
    if (!gestionnaire) return;
    let s = this.sessions.get(ws);
    if (!s) { s = ws.deserializeAttachment() || { id: nouvelId(), chef: false, room: null, ip: '' }; this.sessions.set(ws, s); }
    const ack = Number.isInteger(m.i) ? (res) => this.#repondre(ws, m.i, res) : undefined;
    try {
      gestionnaire.call(this, ws, s, m.d, ack);
    } catch (e) {
      console.error('Erreur dans', m.e, ':', e && e.message);
    }
  }

  webSocketClose(ws, code) {
    this.#retirer(ws);
    try { ws.close(code && code !== 1005 && code !== 1006 ? code : 1000); } catch (e) { /* déjà fermée */ }
  }

  webSocketError(ws) { this.#retirer(ws); }

  #memoriser(ws, s) {
    this.sessions.set(ws, s);
    try { ws.serializeAttachment(s); } catch (e) { /* trop gros ou connexion fermée */ }
  }

  #retirer(ws) {
    const s = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (s && s.room && s.chef) this.#diffuser(s.room, 'live-end', s.id);
  }

  #envoyer(ws, e, d) {
    try { ws.send(JSON.stringify({ e, d })); } catch (err) { /* connexion déjà fermée */ }
  }

  #repondre(ws, i, d) {
    try { ws.send(JSON.stringify({ a: i, d })); } catch (err) { /* connexion déjà fermée */ }
  }

  // room === null : tout le monde. Sinon, seulement ceux qui regardent cette base (sauf l'expéditeur).
  #diffuser(room, e, d, sauf) {
    const msg = JSON.stringify({ e, d });
    for (const [ws, s] of this.sessions) {
      if (ws === sauf || (room !== null && s.room !== room)) continue;
      try { ws.send(msg); } catch (err) { /* connexion déjà fermée */ }
    }
  }

  // ---------- Code chef : comparaison à temps constant, blocage après trop d'essais ----------
  #verifierCode(ip, code) {
    const { chefCode } = this.cfg;
    if (!chefCode) return 'off';
    const maintenant = Date.now();
    const f = this.sql.exec('SELECT n, until FROM fails WHERE ip = ?', ip).toArray()[0];
    if (f && f.until > maintenant) return 'blocked';
    if (typeof code !== 'string' || !code) return 'bad'; // visiteur sans code : pas compté comme un échec
    if (timingSafeEqual(sha(code), sha(chefCode))) {
      if (f) this.sql.exec('DELETE FROM fails WHERE ip = ?', ip);
      return 'ok';
    }
    if (this.sql.exec('SELECT count(*) AS c FROM fails').one().c > 1000) this.sql.exec('DELETE FROM fails');
    let n = (f ? f.n : 0) + 1, until = 0;
    if (n >= 8) { until = maintenant + 10 * 60 * 1000; n = 0; }
    this.sql.exec('INSERT OR REPLACE INTO fails (ip, n, until) VALUES (?, ?, ?)', ip, n, until);
    return 'bad';
  }

  #auth(ws, s, code, ack) {
    const r = this.#verifierCode(s.ip, code);
    if (r === 'ok') { s.chef = true; this.#memoriser(ws, s); }
    if (ack) ack({ chef: s.chef, error: r === 'ok' ? null : r });
  }

  // ---------- Cibles ----------
  #sauver() {
    this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', 'assignments', JSON.stringify(this.cibles));
    if (this.warKey !== null) this.sql.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', 'warKey', this.warKey);
  }

  #assigner(ws, s, d) {
    if (!s.chef || !d) return;
    const tag = normTag(d.tag);
    if (!tag) return;
    if (Number.isInteger(d.target) && d.target >= 1 && d.target <= 50) this.cibles[tag] = d.target;
    else delete this.cibles[tag];
    this.#sauver();
    this.#diffuser(null, 'assignments', this.cibles);
  }

  #toutRetirer(ws, s) {
    if (!s.chef) return;
    this.cibles = {};
    this.#sauver();
    this.#diffuser(null, 'assignments', this.cibles);
  }

  // ---------- Table de dessin ----------
  #traits(room) {
    return this.sql.exec('SELECT data FROM strokes WHERE board = ? ORDER BY id', room).toArray().map((r) => JSON.parse(r.data));
  }

  #etat(room) {
    const img = this.sql.exec('SELECT data FROM images WHERE board = ?', room).toArray()[0];
    return { image: img ? img.data : null, strokes: this.#traits(room) };
  }

  #rejoindre(ws, s, data, ack) {
    const { target, code } = data || {};
    if (!ack) return;
    if (!validTarget(target)) return ack({ ok: false, error: 'Numéro de base invalide.' });
    s.room = target;
    if (this.#verifierCode(s.ip, code) === 'ok') s.chef = true;
    this.#memoriser(ws, s);
    ack({ ok: true, chef: s.chef, state: this.#etat(target) });
  }

  // Aperçu en direct pendant que le chef dessine (non conservé)
  #direct(ws, s, t) {
    if (!s.chef || !s.room || !validStroke(t, 1)) return;
    this.#diffuser(s.room, 'live', { id: s.id, stroke: { type: t.type, color: t.color, points: t.points } }, ws);
  }

  // Tracé terminé : conservé et envoyé à tous
  #trait(ws, s, t) {
    if (!s.chef || !s.room || !validStroke(t, 2)) return;
    const trait = { type: t.type, color: t.color, points: t.points, by: s.id };
    const id = this.sql.exec('INSERT INTO strokes (board, data) VALUES (?, ?) RETURNING id', s.room, JSON.stringify(trait)).one().id;
    if (id % 20 === 0) { // de temps en temps, on ne garde que les MAX_STROKES derniers tracés de cette base
      this.sql.exec('DELETE FROM strokes WHERE board = ? AND id <= (SELECT id FROM strokes WHERE board = ? ORDER BY id DESC LIMIT 1 OFFSET ?)', s.room, s.room, MAX_STROKES);
    }
    this.#diffuser(s.room, 'stroke', trait);
  }

  #annuler(ws, s) {
    if (!s.chef || !s.room) return;
    this.sql.exec('DELETE FROM strokes WHERE id = (SELECT max(id) FROM strokes WHERE board = ?)', s.room);
    this.#diffuser(s.room, 'strokes', this.#traits(s.room));
  }

  #effacer(ws, s) {
    if (!s.chef || !s.room) return;
    this.sql.exec('DELETE FROM strokes WHERE board = ?', s.room);
    this.#diffuser(s.room, 'strokes', []);
  }

  #image(ws, s, dataUrl) {
    if (!s.chef || !s.room) return;
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_IMAGE_CHARS) return;
    if (!IMAGE_OK.test(dataUrl)) return;
    this.sql.exec('INSERT OR REPLACE INTO images (board, data) VALUES (?, ?)', s.room, dataUrl);
    this.sql.exec('DELETE FROM strokes WHERE board = ?', s.room); // nouvelle capture = nouveau tableau
    this.#diffuser(s.room, 'state', { image: dataUrl, strokes: [] });
  }

  // ---------- API Clash of Clans ----------
  // La clé reste sur le serveur : elle n'est jamais envoyée aux téléphones.
  async #guerre() {
    const war = simplifyWar(await this.#coc(`/clans/${encodeURIComponent(this.cfg.clan)}/currentwar`));
    this.#suivreGuerre(war);
    return war;
  }

  async #coc(route) {
    const { token, clan, cacheMs } = this.cfg;
    if (!token) throw erreur(503, 'Clé API manquante : renseigne CLASH_API_TOKEN dans les réglages Cloudflare (Variables et secrets).');
    if (!clan) throw erreur(503, 'Tag du clan manquant ou invalide : renseigne CLAN_TAG dans les réglages Cloudflare (par exemple #2PP0JCCL).');
    const hit = this.cache.get(route);
    if (hit && Date.now() - hit.t < cacheMs) return hit.data;
    let appel = this.enCours.get(route);
    if (!appel) {
      appel = this.#appeler(route).finally(() => this.enCours.delete(route));
      this.enCours.set(route, appel);
    }
    return appel;
  }

  async #appeler(route) {
    const { token, base } = this.cfg;
    let res;
    try {
      res = await fetch(base + route, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      throw erreur(502, 'Impossible de joindre l’API Clash of Clans.');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw erreur(res.status, frMessage(res.status, body, base));
    this.cache.set(route, { t: Date.now(), data: body });
    return body;
  }

  // Nouvelle guerre détectée : on repart de zéro (cibles et dessins de l'ancienne guerre).
  #suivreGuerre(war) {
    if (war.state === 'notInWar') return;
    const key = war.preparationStartTime || war.startTime || null;
    if (!key || key === this.warKey) return;
    if (this.warKey !== null) {
      this.cibles = {};
      this.sql.exec('DELETE FROM strokes');
      this.sql.exec('DELETE FROM images');
      for (const room of new Set([...this.sessions.values()].map((s) => s.room).filter((r) => r !== null))) {
        this.#diffuser(room, 'state', { image: null, strokes: [] });
      }
      this.#diffuser(null, 'assignments', this.cibles);
    }
    this.warKey = key;
    this.#sauver();
  }
}
