// Lien d'armée du jeu (bouton « Partager » de l'armée) → composition détaillée + type de compo.
// Format : https://link.clashofclans.com/fr?action=CopyArmy&army=u10x0-5x12s2x1-1x2
//   u = troupes, s = sorts, i / d = troupes / sorts du château de clan ; « 10x0 » = 10 unités de l'identifiant 0.
// Identifiants et noms anglais : données statiques de la bibliothèque clashofclans.js (licence MIT).
const UNITES = require('./unites.json');

function lireSegment(txt) {
  const out = [];
  for (const bout of String(txt || '').split('-')) {
    const m = /^(\d{1,3})x(\d{1,4})$/.exec(bout);
    if (m) out.push([Number(m[2]), Number(m[1])]); // [identifiant, quantité]
  }
  return out;
}

// Renvoie null si le texte n'est pas un lien d'armée exploitable.
function decoderLien(texte) {
  if (typeof texte !== 'string' || texte.length > 600) return null;
  const m = /[?&]army=([A-Za-z0-9x\-_]+)/.exec(texte.trim());
  if (!m || !/CopyArmy/i.test(texte)) return null;
  const parts = {};
  for (const p of m[1].matchAll(/([a-z])([0-9x\-_]+)/g)) parts[p[1]] = (parts[p[1]] || '') + p[2];
  const nommer = (liste, table) => liste.map(([id, n]) => {
    const d = table[id];
    return { id, n, nom: d ? d[0] : `Inconnu #${id}`, en: d ? d[1] : null, place: d ? d[2] : 0 };
  });
  const troupes = nommer(lireSegment(parts.u), UNITES.troupes);
  const sorts = nommer(lireSegment(parts.s), UNITES.sorts);
  const chateau = [...nommer(lireSegment(parts.i), UNITES.troupes), ...nommer(lireSegment(parts.d), UNITES.sorts)];
  if (!troupes.length && !sorts.length) return null;
  return { troupes, sorts, chateau, compo: deviner(troupes, sorts) };
}

// Classe l'armée dans les grandes familles de compos utilisées par le clan.
function deviner(troupes, sorts) {
  const q = {};
  for (const t of troupes) q[t.en] = (q[t.en] || 0) + t.n * Math.max(1, t.place);
  const a = (...noms) => noms.reduce((s, n) => s + (q[n] || 0), 0);
  const foudre = sorts.filter((s) => s.en === 'Lightning Spell').reduce((s, x) => s + x.n, 0);
  const total = Object.values(q).reduce((s, v) => s + v, 0) || 1;
  const part = (...noms) => a(...noms) / total;
  if (a('Lava Hound', 'Ice Hound') && a('Balloon', 'Rocket Balloon')) return 'Lalo (lave + ballons)';
  if (a('Miner', 'Super Miner') && a('Hog Rider', 'Super Hog Rider')) return 'Hybride (mineurs + cochons)';
  if (part('Electro Dragon') >= 0.3) return 'Dragons électriques';
  if (part('Dragon', 'Super Dragon') >= 0.3 && foudre >= 5) return 'Zap dragons';
  if (part('Dragon', 'Super Dragon') >= 0.25 && a('Balloon', 'Rocket Balloon')) return 'Dragons + ballons';
  if (a('Battle Blimp') && a('Balloon', 'Rocket Balloon')) return 'Dirigeable + ballons';
  if (part('Super Archer') >= 0.25) return 'Super archers';
  if (part('Druid') >= 0.25) return 'Druides';
  if (part('Yeti', 'Super Yeti') >= 0.25) return 'Yétis';
  if (part('Super Wizard') >= 0.25) return 'Super sorciers';
  if (a('Golem', 'Ice Golem') && a('Witch', 'Super Witch')) return 'Golems + sorcières';
  if (part('Witch', 'Super Witch') >= 0.25) return 'Sorcières';
  if (part('Miner', 'Super Miner') >= 0.3) return 'Mineurs';
  if (part('Hog Rider', 'Super Hog Rider') >= 0.3) return 'Cochons';
  return 'Autre';
}

// Forme compacte enregistrée sur l'attaque : [[id, n], ...] pour troupes et sorts.
const compacter = (d) => ({ u: d.troupes.map((t) => [t.id, t.n]), s: d.sorts.map((t) => [t.id, t.n]) });
const detailler = (c) => c && {
  troupes: (c.u || []).map(([id, n]) => ({ id, n, nom: UNITES.troupes[id] ? UNITES.troupes[id][0] : `#${id}` })),
  sorts: (c.s || []).map(([id, n]) => ({ id, n, nom: UNITES.sorts[id] ? UNITES.sorts[id][0] : `#${id}` })),
};

module.exports = { decoderLien, deviner, compacter, detailler };
