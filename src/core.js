// Règles communes avec server.js (version PC). Les fonctions normTag, camp, simplifyWar, validTarget et
// validStroke sont des copies à l'identique : un test compare les deux versions, change toujours les deux.

// Les tags Clash n'utilisent que ces caractères.
export const normTag = (t) => {
  const s = String(t || '').trim().toUpperCase().replace(/^#/, '');
  return /^[0289PYLQGRJCUV]{3,15}$/.test(s) ? '#' + s : '';
};

export const camp = (s = {}) => ({
  tag: s.tag, name: s.name, stars: s.stars || 0, pct: s.destructionPercentage || 0, attacks: s.attacks || 0,
  members: (s.members || []).map((m) => ({
    tag: m.tag, name: m.name, th: m.townhallLevel, pos: m.mapPosition,
    attacks: (m.attacks || []).map((a) => ({ defender: a.defenderTag, stars: a.stars || 0, pct: a.destructionPercentage || 0 })),
    best: m.bestOpponentAttack
      ? { stars: m.bestOpponentAttack.stars || 0, pct: m.bestOpponentAttack.destructionPercentage || 0 }
      : null,
  })).sort((a, b) => a.pos - b.pos),
});

export const simplifyWar = (w) => (!w || w.state === 'notInWar' || !w.clan)
  ? { state: 'notInWar' }
  : {
      state: w.state, teamSize: w.teamSize, attacksPerMember: w.attacksPerMember || 2,
      preparationStartTime: w.preparationStartTime, startTime: w.startTime, endTime: w.endTime,
      clan: camp(w.clan), opponent: camp(w.opponent),
    };

export const validTarget = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{1,20}$/.test(t);
export const validStroke = (s, min) =>
  s && (s.type === 'pen' || s.type === 'arrow') &&
  typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color) &&
  Array.isArray(s.points) && s.points.length >= min && s.points.length <= 2000 &&
  s.points.every((p) => Array.isArray(p) && p.length === 2 &&
    p.every((n) => typeof n === 'number' && n >= 0 && n <= 1));

// ---------- Ce qui change par rapport à la version PC ----------

// Adresse IP du relais RoyaleAPI : c'est elle que l'API Clash voit, donc la seule à mettre sur la clé.
export const RELAIS_IP = '45.79.218.79';
export const RELAIS_URL = 'https://cocproxy.royaleapi.dev/v1';

export function frMessage(status, body, base = '') {
  const reason = (body && body.reason) || '';
  if (status === 403 && /invalidIp/i.test(reason)) {
    return /royaleapi/i.test(base)
      ? `Clé API refusée : crée-la sur developer.clashofclans.com avec l’adresse IP ${RELAIS_IP} (celle du relais RoyaleAPI), puis remplace CLASH_API_TOKEN dans les réglages Cloudflare.`
      : 'Clé API refusée pour l’adresse IP de ce serveur : crée une clé sur developer.clashofclans.com avec l’IP que l’API Clash voit (celle de ton relais).';
  }
  if (status === 403) return 'Accès refusé : vérifie la clé API et que le journal de guerre du clan est public.';
  if (status === 404) return 'Clan introuvable : vérifie CLAN_TAG dans les réglages Cloudflare.';
  if (status === 429) return 'Trop de requêtes vers l’API Clash : réessaie dans quelques secondes.';
  if (status === 503) return 'L’API Clash of Clans est en maintenance.';
  return (body && body.message) || `Erreur de l’API Clash (${status}).`;
}

// Réglages saisis dans Cloudflare : on retire les espaces et, pour la clé et le tag, les guillemets recopiés par erreur.
const sansGuillemets = (v) => String(v == null ? '' : v).trim().replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
const PLACEHOLDERS = ['', 'changeme', 'choisis-un-code-secret']; // valeurs d'exemple : comptées comme « pas de code »
const TOKEN_EXEMPLE = 'colle-ta-cle-ici';

export function lireConfig(env) {
  const code = String(env.CHEF_CODE == null ? '' : env.CHEF_CODE).trim();
  const cache = env.CACHE_MS === undefined || String(env.CACHE_MS).trim() === '' ? NaN : Number(env.CACHE_MS);
  const token = sansGuillemets(env.CLASH_API_TOKEN);
  return {
    token: token === TOKEN_EXEMPLE ? '' : token,
    clan: normTag(sansGuillemets(env.CLAN_TAG)),
    chefCode: PLACEHOLDERS.includes(code) ? '' : code,
    base: (sansGuillemets(env.CLASH_API_BASE) || RELAIS_URL).replace(/\/+$/, ''),
    cacheMs: Number.isFinite(cache) && cache >= 0 ? cache : 15000, // l'API est interrogée au plus une fois par 15 s
  };
}
