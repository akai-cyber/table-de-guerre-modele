// Repérage avant la guerre : force estimée de chaque base et proposition de cibles pour le chef.
// Force = hôtel de ville × 100 + somme des niveaux des héros × 3 (simple et lisible ; l'HDV domine).

function force(p) {
  const heros = (p.heroes || []).filter((h) => !h.village || h.village === 'home');
  const sommeHeros = heros.reduce((s, h) => s + (h.level || 0), 0);
  return { th: p.townHallLevel || 0, heros: sommeHeros, force: (p.townHallLevel || 0) * 100 + sommeHeros * 3,
    detailHeros: heros.map((h) => ({ nom: h.name, niveau: h.level, max: h.maxLevel })), etoilesGuerre: p.warStars || 0 };
}

// Répartition gloutonne : du plus fort au plus faible, chacun prend la base la plus forte qu'il peut
// raisonnablement tripler (force adverse ≤ 105 % de la sienne) parmi celles encore libres.
// Les bases déjà à 3 étoiles sont ignorées ; si aucune base « à sa portée » ne reste, il prend la plus faible restante.
function proposer(nous, eux, { dejaTriplees = new Set() } = {}) {
  const libres = eux.filter((o) => !dejaTriplees.has(o.tag)).sort((a, b) => b.force - a.force);
  const prises = new Set(), plan = [];
  for (const m of [...nous].sort((a, b) => b.force - a.force)) {
    if (!libres.length) break;
    let choix = libres.find((o) => !prises.has(o.tag) && o.force <= m.force * 1.05);
    let raison = choix ? (choix.th > m.th ? 'HDV plus haut à sa portée' : choix.th === m.th ? 'même niveau' : 'base sûre') : null;
    if (!choix) { choix = [...libres].reverse().find((o) => !prises.has(o.tag)); raison = 'plus faible base restante'; }
    if (!choix) break;
    prises.add(choix.tag);
    plan.push({ tag: m.tag, nom: m.nom, cible: choix.pos, cibleNom: choix.nom, ecart: choix.force - m.force, raison });
  }
  return plan;
}

module.exports = { force, proposer };
