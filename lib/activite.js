// Suivi d'activité des membres à partir de relevés réguliers (l'API ne donne pas de « dernière connexion »).
// On note chaque jour : dons, dons reçus, trophées, et toutes les 6 h des compteurs du profil
// (étoiles de guerre, attaques gagnées, points des Jeux de clan, contributions au Capital).
// Un joueur est « actif » le dernier jour où l'un de ces compteurs a bougé.

const POINTS_MAX = 35;           // un mois de relevés quotidiens par joueur
const EVENEMENTS_MAX = 200;
const OUBLI_DEPART_JOURS = 45;   // un ancien membre est oublié après ce délai
const jour = (d) => new Date(d).toISOString().slice(0, 10);
const CHAMPS = ['don', 'tr', 'eg', 'aw', 'jc', 'cg'];

function nouvelEtat() { return { membres: {}, evenements: [], dernierProfil: null, init: false }; }

// Achievements utiles du profil joueur (noms anglais de l'API).
function compteursProfil(p) {
  const ach = (nom) => { const a = (p.achievements || []).find((x) => x.name === nom && (!x.village || x.village === 'home')); return a ? a.value : null; };
  return { eg: p.warStars ?? null, aw: p.attackWins ?? null, jc: ach('Games Champion'), cg: ach('Most Valuable Clanmate') };
}

// Relevé de la liste des membres (appel peu coûteux). Renvoie la liste des nouveaux évènements.
function releverMembres(etat, membres, maintenant = Date.now()) {
  const e = etat || nouvelEtat();
  const j = jour(maintenant), iso = new Date(maintenant).toISOString();
  const nouveaux = [];
  const presents = new Set(membres.map((m) => m.tag));
  for (const m of membres) {
    let s = e.membres[m.tag];
    if (!s) {
      s = e.membres[m.tag] = { nom: m.name, depuis: iso, vu: iso, parti: null, role: m.role, actif: iso, points: [] };
      if (e.init) nouveaux.push({ le: iso, type: 'arrivee', tag: m.tag, nom: m.name });
    } else if (s.parti) {
      s.parti = null; nouveaux.push({ le: iso, type: 'retour', tag: m.tag, nom: m.name });
    }
    if (e.init && s.role && m.role && s.role !== m.role) nouveaux.push({ le: iso, type: 'role', tag: m.tag, nom: m.name, de: s.role, a: m.role });
    s.nom = m.name; s.role = m.role; s.vu = iso;
    point(s, j, { don: m.donations ?? null, recu: m.donationsReceived ?? null, tr: m.trophies ?? null }, iso);
  }
  for (const [tag, s] of Object.entries(e.membres)) {
    if (presents.has(tag)) continue;
    if (!s.parti) { s.parti = iso; nouveaux.push({ le: iso, type: 'depart', tag, nom: s.nom }); }
    else if (maintenant - Date.parse(s.parti) > OUBLI_DEPART_JOURS * 864e5) delete e.membres[tag];
  }
  e.init = true;
  e.evenements = [...nouveaux.reverse(), ...e.evenements].slice(0, EVENEMENTS_MAX);
  return nouveaux;
}

// Relevé des profils (appel par joueur, toutes les 6 h).
function releverProfils(etat, profils, maintenant = Date.now()) {
  const j = jour(maintenant), iso = new Date(maintenant).toISOString();
  for (const p of profils) { const s = etat.membres[p.tag]; if (s) point(s, j, compteursProfil(p), iso); }
  etat.dernierProfil = iso;
}

// Met à jour le point du jour ; si un compteur a bougé par rapport au relevé précédent, le joueur est actif.
function point(s, j, valeurs, iso) {
  const pts = s.points;
  let p = pts[pts.length - 1];
  const precedent = p && p.d === j ? p : p || null;
  // Comparaison avec les dernières valeurs connues (le point du jour ou celui d'avant).
  const dernier = {};
  for (const x of pts) for (const c of [...CHAMPS, 'recu']) if (x[c] != null) dernier[c] = x[c];
  let bouge = false;
  for (const [c, v] of Object.entries(valeurs)) {
    if (v == null) continue;
    if (dernier[c] != null && v !== dernier[c] && c !== 'recu') {
      if (c === 'don' && v < dernier[c]) continue; // remise à zéro des dons en début de saison
      bouge = true;
    }
  }
  if (!p || p.d !== j) { p = { d: j }; pts.push(p); if (pts.length > POINTS_MAX) pts.shift(); }
  Object.assign(p, Object.fromEntries(Object.entries(valeurs).filter(([, v]) => v != null)));
  if (bouge && precedent) s.actif = iso;
}

// Vue calculée pour l'écran « Activité ».
function vueActivite(etat, maintenant = Date.now()) {
  const mois = jour(maintenant).slice(0, 7);
  const joueurs = Object.entries((etat && etat.membres) || {}).filter(([, s]) => !s.parti).map(([tag, s]) => {
    const pts = s.points, der = pts[pts.length - 1] || {};
    const duMois = pts.filter((p) => p.d.startsWith(mois));
    const delta = (c) => { const v = duMois.filter((p) => p[c] != null); return v.length >= 2 ? v[v.length - 1][c] - v[0][c] : 0; };
    const inactif = Math.floor((maintenant - Date.parse(s.actif)) / 864e5);
    return {
      tag, nom: s.nom, role: s.role, depuis: s.depuis, actif: s.actif, joursInactif: inactif,
      dons: der.don ?? 0, recus: der.recu ?? 0, ratio: der.recu ? Math.round((100 * (der.don || 0)) / der.recu) / 100 : null,
      jeuxMois: delta('jc'), etoilesMois: delta('eg'), attaquesMois: delta('aw'), capitalMois: delta('cg'),
      suiviDepuis: pts[0] ? pts[0].d : null,
    };
  });
  joueurs.sort((a, b) => b.joursInactif - a.joursInactif || a.nom.localeCompare(b.nom));
  return { joueurs, evenements: (etat && etat.evenements) || [], dernierProfil: etat && etat.dernierProfil };
}

module.exports = { nouvelEtat, releverMembres, releverProfils, vueActivite, compteursProfil };
