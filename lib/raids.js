// Raids du Capital : l'API renvoie l'historique des week-ends de raid (avec le détail par membre).
const { tdate } = require('./guerres');

function saison(s) {
  return {
    debut: tdate(s.startTime), fin: tdate(s.endTime), etat: s.state === 'ongoing' ? 'en_cours' : 'termine',
    butin: s.capitalTotalLoot || 0, raids: s.raidsCompleted || 0, attaques: s.totalAttacks || 0, quartiers: s.enemyDistrictsDestroyed || 0,
    recompenseAtt: s.offensiveReward || 0, recompenseDef: s.defensiveReward || 0,
    membres: (s.members || []).map((m) => ({ tag: m.tag, nom: m.name, attaques: m.attacks || 0, limite: (m.attackLimit || 0) + (m.bonusAttackLimit || 0), butin: m.capitalResourcesLooted || 0 }))
      .sort((a, b) => b.butin - a.butin),
  };
}

// Bilan par joueur sur plusieurs week-ends. Les membres actuels absents d'un week-end comptent 0 attaque sur 6.
function bilanRaids(saisons, membresActuels = null, { derniers = 0 } = {}) {
  let liste = (saisons || []).filter((s) => s.etat === 'termine');
  if (derniers > 0) liste = liste.slice(0, derniers);
  const par = new Map();
  const ligne = (tag, nom) => { if (!par.has(tag)) par.set(tag, { tag, nom, weekends: 0, attaques: 0, possibles: 0, butin: 0, absences: 0 }); return par.get(tag); };
  for (const s of liste) {
    const vus = new Set();
    for (const m of s.membres) {
      const l = ligne(m.tag, m.nom); vus.add(m.tag);
      l.weekends++; l.attaques += m.attaques; l.possibles += Math.max(m.limite, m.attaques); l.butin += m.butin;
    }
    for (const m of membresActuels || []) if (!vus.has(m.tag)) { const l = ligne(m.tag, m.name); l.absences++; l.possibles += 6; }
  }
  const res = [...par.values()].map((l) => ({
    ...l, butinMoyen: l.weekends ? Math.round(l.butin / l.weekends) : 0, parAttaque: l.attaques ? Math.round(l.butin / l.attaques) : 0,
    participation: l.possibles ? Math.round((1000 * l.attaques) / l.possibles) / 10 : 0,
  }));
  res.sort((a, b) => b.butin - a.butin || b.participation - a.participation);
  res.forEach((l, i) => { l.rang = i + 1; });
  return { joueurs: res, weekends: liste.length };
}

module.exports = { saison, bilanRaids };
