// Ligue de guerre de clans : classement du groupe et calendrier de notre clan.
// Points du classement : étoiles + 10 étoiles bonus par victoire ; départage au pourcentage de destruction cumulé.
const { tdate } = require('./guerres');

function classementGroupe(groupe, guerres) {
  const t = new Map();
  for (const c of (groupe && groupe.clans) || []) t.set(c.tag, { tag: c.tag, nom: c.name, niveau: c.clanLevel || 0, badge: c.badgeUrls ? c.badgeUrls.small : null, etoiles: 0, destruction: 0, victoires: 0, defaites: 0, joues: 0 });
  for (const w of guerres || []) {
    if (!w || !w.clan || !w.opponent || !['inWar', 'warEnded'].includes(w.state)) continue;
    const a = t.get(w.clan.tag), b = t.get(w.opponent.tag);
    if (!a || !b) continue;
    const sa = w.clan.stars || 0, sb = w.opponent.stars || 0;
    const pa = (w.clan.destructionPercentage || 0) * (w.teamSize || 15), pb = (w.opponent.destructionPercentage || 0) * (w.teamSize || 15);
    a.etoiles += sa; b.etoiles += sb; a.destruction += pa; b.destruction += pb;
    if (w.state === 'warEnded') {
      a.joues++; b.joues++;
      const gagneA = sa > sb || (sa === sb && w.clan.destructionPercentage > w.opponent.destructionPercentage);
      const egal = sa === sb && w.clan.destructionPercentage === w.opponent.destructionPercentage;
      if (!egal) { (gagneA ? a : b).etoiles += 10; (gagneA ? a : b).victoires++; (gagneA ? b : a).defaites++; }
    }
  }
  const res = [...t.values()].map((c) => ({ ...c, destruction: Math.round(c.destruction) }));
  res.sort((x, y) => y.etoiles - x.etoiles || y.destruction - x.destruction);
  res.forEach((c, i) => { c.rang = i + 1; });
  return res;
}

// Journées de notre clan : adversaire, score, état.
function calendrier(groupe, guerresParTag, notreTag) {
  return ((groupe && groupe.rounds) || []).map((r, i) => {
    for (const tag of r.warTags || []) {
      const w = guerresParTag[tag];
      if (!w) continue;
      const nous = w.clan.tag === notreTag ? w.clan : w.opponent.tag === notreTag ? w.opponent : null;
      if (!nous) continue;
      const eux = nous === w.clan ? w.opponent : w.clan;
      return { journee: i + 1, warTag: tag, etat: w.state, debut: tdate(w.startTime || w.warStartTime), fin: tdate(w.endTime),
        nous: { e: nous.stars || 0, p: nous.destructionPercentage || 0 }, eux: { n: eux.name, t: eux.tag, e: eux.stars || 0, p: eux.destructionPercentage || 0, b: eux.badgeUrls ? eux.badgeUrls.small : null } };
    }
    return { journee: i + 1, etat: (r.warTags || []).every((x) => x === '#0') ? 'a_venir' : 'inconnu' };
  });
}

module.exports = { classementGroupe, calendrier };
