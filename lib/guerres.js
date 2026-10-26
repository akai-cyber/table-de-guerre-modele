// Historique des guerres et statistiques des joueurs. Fonctions pures, testées directement.
//
// L'API Clash ne donne le détail des attaques que pour la guerre en cours : le serveur enregistre donc
// chaque guerre au fil de l'eau (archiverGuerre), puis les statistiques sont calculées sur ces archives.
// Format compact (le tout doit tenir dans une petite base gratuite) :
// { id, type: 'c'|'l', etat, prep, debut, fin, taille, apm, clan, adv, res, maj,
//   m: [{ t, n, th, pos, a: [{ d, dth, dpos, e, p, o, du, ne, c }], de: { e, p, n } }] }

const COMPOS = ['Hybride (mineurs + cochons)', 'Lalo (lave + ballons)', 'Zap dragons', 'Dragons électriques', 'Dragons + ballons', 'Super archers', 'Reine marche', 'Sorcières', 'Golems + sorcières', 'Yétis', 'Super sorciers', 'Mineurs', 'Cochons', 'Dirigeable + ballons', 'Druides', 'Autre'];

const tdate = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s || '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null;
};
const camp = (c = {}) => ({ n: c.name || '?', t: c.tag || '', e: c.stars || 0, p: Math.round((c.destructionPercentage || 0) * 100) / 100, a: c.attacks || 0, b: c.badgeUrls ? c.badgeUrls.small || c.badgeUrls.medium || null : null });

function resultat(clan, adv) {
  if (clan.e !== adv.e) return clan.e > adv.e ? 'victoire' : 'defaite';
  if (clan.p !== adv.p) return clan.p > adv.p ? 'victoire' : 'defaite';
  return 'egalite';
}

// Transforme une guerre brute de l'API en archive, en conservant les compos déjà déclarées.
function archiverGuerre(w, { type = 'c', warTag = null, ancienne = null } = {}) {
  if (!w || !w.clan || !w.opponent || !['inWar', 'warEnded', 'preparation'].includes(w.state)) return null;
  const id = type === 'l' ? 'l-' + String(warTag || '').replace('#', '') : 'c-' + (w.preparationStartTime || w.startTime);
  const adv = new Map((w.opponent.members || []).map((o) => [o.tag, o]));
  const compos = new Map();
  if (ancienne) for (const m of ancienne.m || []) for (const a of m.a || []) if (a.c) compos.set(m.t + '|' + a.o, { c: a.c, ar: a.ar });
  // Nouvelles étoiles : ce que chaque attaque ajoute au meilleur résultat déjà obtenu sur la base visée.
  const toutes = [];
  for (const m of w.clan.members || []) for (const a of m.attacks || []) toutes.push(a);
  toutes.sort((x, y) => (x.order || 0) - (y.order || 0));
  const meilleur = new Map(), nouvelles = new Map();
  for (const a of toutes) {
    const avant = meilleur.get(a.defenderTag) || 0;
    nouvelles.set(a.attackerTag + '|' + a.order, Math.max(0, (a.stars || 0) - avant));
    meilleur.set(a.defenderTag, Math.max(avant, a.stars || 0));
  }
  const clan = camp(w.clan), opp = camp(w.opponent);
  return {
    id, type, etat: w.state,
    prep: tdate(w.preparationStartTime), debut: tdate(w.startTime || w.warStartTime), fin: tdate(w.endTime),
    taille: w.teamSize || (w.clan.members || []).length, apm: w.attacksPerMember || (type === 'l' ? 1 : 2),
    clan, adv: opp, res: w.state === 'warEnded' ? resultat(clan, opp) : null,
    m: (w.clan.members || []).map((m) => ({
      t: m.tag, n: m.name, th: m.townhallLevel || null, pos: m.mapPosition || null,
      a: (m.attacks || []).sort((x, y) => (x.order || 0) - (y.order || 0)).map((a) => {
        const d = adv.get(a.defenderTag) || {};
        const r = { d: a.defenderTag, dth: d.townhallLevel || null, dpos: d.mapPosition || null, e: a.stars || 0, p: a.destructionPercentage || 0, o: a.order || 0, du: a.duration || 0, ne: nouvelles.get(m.tag + '|' + a.order) || 0 };
        const c = compos.get(m.tag + '|' + r.o);
        if (c) { r.c = c.c; if (c.ar) r.ar = c.ar; }
        return r;
      }),
      de: { e: m.bestOpponentAttack ? m.bestOpponentAttack.stars || 0 : 0, p: m.bestOpponentAttack ? m.bestOpponentAttack.destructionPercentage || 0 : 0, n: m.opponentAttacks || 0 },
    })).sort((a, b) => (a.pos || 99) - (b.pos || 99)),
    maj: new Date().toISOString(),
  };
}

// Difficulté d'une attaque : viser plus fort rapporte plus, viser plus faible rapporte moins.
const facteurHdv = (atk, def) => (atk && def ? Math.min(1.3, Math.max(0.7, 1 + 0.15 * (def - atk))) : 1);

// Note sur 100 : 40 % triples (pondérés par la difficulté), 25 % étoiles moyennes, 20 % attaques faites, 15 % destruction moyenne.
const POIDS = { triple: 40, etoiles: 25, participation: 20, destruction: 15 };

function statsJoueurs(guerres, { derniers = 0, type = 'tous' } = {}) {
  let liste = [...(guerres || [])].filter((g) => g && g.etat !== 'preparation' && (type === 'tous' || g.type === type));
  liste.sort((a, b) => Date.parse(b.debut || b.prep) - Date.parse(a.debut || a.prep));
  if (derniers > 0) liste = liste.slice(0, derniers);
  const parTag = new Map();
  for (const g of [...liste].reverse()) { // du plus ancien au plus récent : nom et HDV finaux = les plus récents
    const finie = g.etat === 'warEnded';
    for (const m of g.m) {
      let s = parTag.get(m.t);
      if (!s) {
        s = { tag: m.t, nom: m.n, th: m.th, guerres: 0, guerresFinies: 0, parfaites: 0, attaques: 0, possibles: 0, manquees: 0, triples: 0, etoiles: 0, nouvelles: 0,
          pctTotal: 0, dureeTotal: 0, triplesPonderes: 0, haut: { attaques: 0, triples: 0 }, bas: { attaques: 0, triples: 0 }, egal: { attaques: 0, triples: 0 },
          defense: { subies: 0, tenues: 0, etoilesConcedees: 0 }, compos: {}, forme: [] };
        parTag.set(m.t, s);
      }
      s.nom = m.n; s.th = m.th || s.th;
      s.guerres++;
      const faites = m.a.length;
      s.attaques += faites;
      s.possibles += finie ? Math.max(g.apm, faites) : faites; // guerre en cours : on ne compte pas encore d'attaque manquée
      if (finie) { s.guerresFinies++; s.manquees += Math.max(0, g.apm - faites); if (faites >= g.apm) s.parfaites++; }
      for (const a of m.a) {
        if (a.e === 3) s.triples++;
        s.etoiles += a.e; s.nouvelles += a.ne; s.pctTotal += a.p; s.dureeTotal += a.du;
        s.triplesPonderes += a.e === 3 ? facteurHdv(m.th, a.dth) : 0;
        const cote = !a.dth || !m.th || a.dth === m.th ? s.egal : a.dth > m.th ? s.haut : s.bas;
        cote.attaques++; if (a.e === 3) cote.triples++;
        if (a.c) { const c = s.compos[a.c] || (s.compos[a.c] = { n: 0, triples: 0, etoiles: 0 }); c.n++; c.etoiles += a.e; if (a.e === 3) c.triples++; }
        s.forme.push(a.e);
      }
      if (m.de && m.de.n > 0) { s.defense.subies++; s.defense.etoilesConcedees += m.de.e; if (m.de.e < 3) s.defense.tenues++; }
    }
  }
  const arr = (x) => Math.round(x * 10) / 10;
  const res = [...parTag.values()].map((s) => {
    const n = s.attaques;
    const tauxTriple = n ? s.triples / n : 0, moyEtoiles = n ? s.etoiles / n : 0, moyPct = n ? s.pctTotal / n : 0;
    const participation = s.possibles ? s.attaques / s.possibles : 0;
    const triplePondere = n ? Math.min(1, s.triplesPonderes / n) : 0;
    const note = n ? POIDS.triple * triplePondere + POIDS.etoiles * (moyEtoiles / 3) + POIDS.participation * participation + POIDS.destruction * (moyPct / 100) : 0;
    const composTriees = Object.entries(s.compos).sort((a, b) => b[1].n - a[1].n);
    return {
      tag: s.tag, nom: s.nom, th: s.th, guerres: s.guerres, guerresFinies: s.guerresFinies, attaques: n, possibles: s.possibles, manquees: s.manquees,
      parfaites: s.parfaites, tauxParfaites: s.guerresFinies ? arr((100 * s.parfaites) / s.guerresFinies) : null,
      triples: s.triples, etoiles: s.etoiles, nouvelles: s.nouvelles,
      tauxTriple: arr(100 * tauxTriple), moyEtoiles: Math.round(moyEtoiles * 100) / 100, moyPct: arr(moyPct), participation: arr(100 * participation),
      dureeMoy: n ? Math.round(s.dureeTotal / n) : 0,
      haut: s.haut, bas: s.bas, egal: s.egal,
      defense: { ...s.defense, moyConcedees: s.defense.subies ? Math.round((s.defense.etoilesConcedees / s.defense.subies) * 100) / 100 : null },
      compoFavorite: composTriees[0] ? composTriees[0][0] : null, compos: s.compos,
      forme: s.forme.slice(-6), note: arr(note), peuDeDonnees: n < 3,
    };
  });
  res.sort((a, b) => b.note - a.note || b.nouvelles - a.nouvelles || b.tauxTriple - a.tauxTriple || a.nom.localeCompare(b.nom));
  res.forEach((s, i) => { s.rang = i + 1; });
  return { joueurs: res, guerres: liste.length };
}

function statsClan(guerres, { derniers = 0, type = 'tous' } = {}) {
  let liste = [...(guerres || [])].filter((g) => g && g.etat !== 'preparation' && (type === 'tous' || g.type === type));
  liste.sort((a, b) => Date.parse(b.debut || b.prep) - Date.parse(a.debut || a.prep));
  if (derniers > 0) liste = liste.slice(0, derniers);
  const finies = liste.filter((g) => g.etat === 'warEnded');
  let attaques = 0, triples = 0, etoiles = 0, manquees = 0, pct = 0;
  const compos = {};
  for (const g of liste) for (const m of g.m) {
    if (g.etat === 'warEnded') manquees += Math.max(0, g.apm - m.a.length);
    for (const a of m.a) {
      attaques++; etoiles += a.e; pct += a.p; if (a.e === 3) triples++;
      if (a.c) { const c = compos[a.c] || (compos[a.c] = { compo: a.c, n: 0, triples: 0, etoiles: 0 }); c.n++; c.etoiles += a.e; if (a.e === 3) c.triples++; }
    }
  }
  const v = finies.filter((g) => g.res === 'victoire').length, d = finies.filter((g) => g.res === 'defaite').length;
  return {
    guerres: liste.length, finies: finies.length, victoires: v, defaites: d, egalites: finies.length - v - d,
    tauxVictoire: finies.length ? Math.round((1000 * v) / finies.length) / 10 : 0,
    attaques, manquees, tauxTriple: attaques ? Math.round((1000 * triples) / attaques) / 10 : 0,
    moyEtoiles: attaques ? Math.round((100 * etoiles) / attaques) / 100 : 0, moyPct: attaques ? Math.round((10 * pct) / attaques) / 10 : 0,
    compos: Object.values(compos).map((c) => ({ ...c, tauxTriple: Math.round((1000 * c.triples) / c.n) / 10, moyEtoiles: Math.round((100 * c.etoiles) / c.n) / 100 }))
      .sort((a, b) => b.tauxTriple - a.tauxTriple || b.n - a.n),
  };
}

// Meilleur joueur d'une guerre : nouvelles étoiles, puis triples, puis destruction.
function mvp(g) {
  let best = null;
  for (const m of (g && g.m) || []) {
    if (!m.a.length) continue;
    const sc = [m.a.reduce((s, a) => s + a.ne, 0), m.a.filter((a) => a.e === 3).length, m.a.reduce((s, a) => s + a.p, 0)];
    if (!best || sc[0] > best.sc[0] || (sc[0] === best.sc[0] && (sc[1] > best.sc[1] || (sc[1] === best.sc[1] && sc[2] > best.sc[2])))) best = { tag: m.t, nom: m.n, sc };
  }
  return best && { tag: best.tag, nom: best.nom, nouvelles: best.sc[0], triples: best.sc[1] };
}

// Résumé léger pour la liste de l'historique.
const resume = (g) => ({ id: g.id, type: g.type, manuelle: Boolean(g.manuelle), etat: g.etat, debut: g.debut, fin: g.fin, taille: g.taille, apm: g.apm, clan: g.clan, adv: g.adv, res: g.res, details: true, mvp: mvp(g) });


// Guerre saisie à la main par le chef (guerres d'avant l'appli : l'API n'en garde que le score).
// entree : { fin, adv, taille, apm, nous: {e, p}, eux: {e, p}, participants: [{ tag, nom, th }], attaques: [{ tag, cible, e, p }] }
const TAG_RE = /^#[0289PYLQGRJCUV]{3,15}$/;
function guerreManuelle(entree, clan = {}) {
  const x = entree && typeof entree === 'object' ? entree : {};
  const err = (m) => ({ erreur: m });
  const fin = Date.parse(x.fin);
  if (!Number.isFinite(fin) || fin > Date.now() + 864e5) return err('Date de fin invalide.');
  const taille = Number(x.taille), apm = Number(x.apm);
  if (!Number.isInteger(taille) || taille < 1 || taille > 50) return err('Taille de guerre invalide (1 à 50).');
  if (apm !== 1 && apm !== 2) return err('Attaques par joueur : 1 ou 2.');
  const adv = String(x.adv || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Adversaire';
  const score = (o) => ({ e: Math.max(0, Math.min(taille * 3, parseInt(o && o.e, 10) || 0)), p: Math.max(0, Math.min(100, Number(o && o.p) || 0)) });
  const nous = score(x.nous), eux = score(x.eux);
  const part = Array.isArray(x.participants) ? x.participants : [];
  if (!part.length || part.length > taille) return err(`Choisis entre 1 et ${taille} participants.`);
  const vus = new Set();
  for (const pp of part) { if (!pp || !TAG_RE.test(pp.tag) || vus.has(pp.tag)) return err('Participant invalide ou en double.'); vus.add(pp.tag); }
  const atts = Array.isArray(x.attaques) ? x.attaques : [];
  if (atts.length > taille * apm) return err('Trop d’attaques pour cette guerre.');
  const parTag = new Map(part.map((pp) => [pp.tag, []]));
  const meilleur = new Map();
  atts.forEach((a, i) => {
    if (!a || !parTag.has(a.tag)) throw Object.assign(new Error('Attaque d’un joueur qui ne participe pas.'), { valid: true });
    const cible = Number(a.cible), e = Number(a.e), p = Number(a.p);
    if (!Number.isInteger(cible) || cible < 1 || cible > taille) throw Object.assign(new Error(`Base visée invalide (1 à ${taille}).`), { valid: true });
    if (![0, 1, 2, 3].includes(e)) throw Object.assign(new Error('Étoiles : 0 à 3.'), { valid: true });
    if (!Number.isFinite(p) || p < 0 || p > 100) throw Object.assign(new Error('Destruction : 0 à 100 %.'), { valid: true });
    if (parTag.get(a.tag).length >= apm) throw Object.assign(new Error(`Pas plus de ${apm} attaque(s) par joueur.`), { valid: true });
    const avant = meilleur.get(cible) || 0;
    meilleur.set(cible, Math.max(avant, e));
    parTag.get(a.tag).push({ d: 'B' + cible, dth: null, dpos: cible, e, p: Math.round(p * 10) / 10, o: i + 1, du: 0, ne: Math.max(0, e - avant) });
  });
  const finIso = new Date(fin).toISOString();
  const c = { n: clan.name || 'Nous', t: clan.tag || '', e: nous.e, p: nous.p, a: atts.length, b: clan.badge || null };
  const o = { n: adv, t: '', e: eux.e, p: eux.p, a: 0, b: null };
  return { valeur: {
    id: 'm-' + finIso, type: 'c', etat: 'warEnded', manuelle: true, prep: null, debut: new Date(fin - 24 * 3600e3).toISOString(), fin: finIso,
    taille, apm, clan: c, adv: o, res: resultat(c, o),
    m: part.map((pp, i) => ({ t: pp.tag, n: String(pp.nom || pp.tag).slice(0, 30), th: Number(pp.th) || null, pos: i + 1, a: parTag.get(pp.tag), de: { e: 0, p: 0, n: 0 } })),
    maj: new Date().toISOString(),
  } };
}
function guerreManuelleSure(entree, clan) {
  try { return guerreManuelle(entree, clan); } catch (e) { if (e.valid) return { erreur: e.message }; throw e; }
}

// Fusion avec une sauvegarde : par identifiant, la version la plus récente l'emporte.
function fusionner(locales, sauvegarde) {
  const par = new Map((locales || []).map((g) => [g.id, g]));
  let ajouts = 0;
  for (const g of sauvegarde || []) {
    if (!g || typeof g.id !== 'string' || !Array.isArray(g.m)) continue;
    const l = par.get(g.id);
    if (!l || Date.parse(g.maj || 0) > Date.parse(l.maj || 0)) { par.set(g.id, g); ajouts++; }
  }
  const res = [...par.values()].sort((a, b) => Date.parse(b.fin || b.debut || b.prep) - Date.parse(a.fin || a.debut || a.prep));
  return { guerres: res, ajouts };
}

module.exports = { guerreManuelle: guerreManuelleSure, fusionner, archiverGuerre, statsJoueurs, statsClan, mvp, resume, resultat, facteurHdv, tdate, COMPOS, POIDS };
