// Logique métier des disponibilités « Signe / Non » : périodes, statuts, validation et statistiques.
// Fonctions pures (aucun accès réseau ni disque) : elles sont testées directement.

const JOUR = 24 * 3600 * 1000;
const DUREE_MAX = 60 * JOUR;
const TITRE_MAX = 60;

// Statut d'une période à un instant donné.
// cloturee : fermée à la main par le chef ; a_venir / ouverte / terminee : d'après les dates.
function statutPeriode(p, maintenant = Date.now()) {
  if (!p) return null;
  if (p.cloturee) return 'cloturee';
  const d = Date.parse(p.debut), f = Date.parse(p.fin);
  if (maintenant < d) return 'a_venir';
  if (maintenant >= f) return 'terminee';
  return 'ouverte';
}

// La période à afficher par défaut : celle qui est ouverte, sinon la prochaine, sinon la plus récente.
function periodeCourante(periodes, maintenant = Date.now()) {
  if (!Array.isArray(periodes) || !periodes.length) return null;
  const ouvertes = periodes.filter((p) => statutPeriode(p, maintenant) === 'ouverte');
  if (ouvertes.length) return ouvertes.sort((a, b) => Date.parse(a.fin) - Date.parse(b.fin))[0];
  const avenir = periodes.filter((p) => statutPeriode(p, maintenant) === 'a_venir');
  if (avenir.length) return avenir.sort((a, b) => Date.parse(a.debut) - Date.parse(b.debut))[0];
  return [...periodes].sort((a, b) => Date.parse(b.fin) - Date.parse(a.fin))[0];
}

// Deux périodes non clôturées qui se chevauchent seraient ambiguës pour les membres.
function chevauchements(periodes, debut, fin, saufId, maintenant = Date.now()) {
  const d = Date.parse(debut), f = Date.parse(fin);
  return (periodes || []).filter((p) => p.id !== saufId
    && ['ouverte', 'a_venir'].includes(statutPeriode(p, maintenant))
    && Date.parse(p.debut) < f && d < Date.parse(p.fin));
}

const dateValide = (s) => typeof s === 'string' && s.length <= 40 && !Number.isNaN(Date.parse(s));

// Valide les champs envoyés par le chef. Renvoie { erreur } ou { valeur } (dates normalisées en ISO UTC).
function validerPeriode(entree, existante, maintenant = Date.now()) {
  const e = entree && typeof entree === 'object' ? entree : {};
  const titreBrut = e.titre !== undefined ? e.titre : existante ? existante.titre : '';
  if (typeof titreBrut !== 'string') return { erreur: 'Titre invalide.' };
  const titre = titreBrut.replace(/\s+/g, ' ').trim().slice(0, TITRE_MAX);
  const debut = e.debut !== undefined ? e.debut : existante && existante.debut;
  const fin = e.fin !== undefined ? e.fin : existante && existante.fin;
  if (!dateValide(debut) || !dateValide(fin)) return { erreur: 'Dates de début et de fin obligatoires.' };
  const d = Date.parse(debut), f = Date.parse(fin);
  if (f <= d) return { erreur: 'La fin doit être après le début.' };
  if (f - d > DUREE_MAX) return { erreur: 'Une période ne peut pas dépasser 60 jours.' };
  if (!existante && f <= maintenant) return { erreur: 'Cette période serait déjà terminée : choisis une fin dans le futur.' };
  return { valeur: { titre, debut: new Date(d).toISOString(), fin: new Date(f).toISOString() } };
}

// Statistiques : seuls les membres actuels du clan comptent.
// Les réponses d'anciens membres sont mises à part (« exclues »), pour que les pourcentages restent justes.
function calculerStats(membres, reponses) {
  const rep = reponses || {};
  const tags = new Set((membres || []).map((m) => m.tag));
  let oui = 0, non = 0, exclus = 0;
  for (const [tag, v] of Object.entries(rep)) {
    if (!v || (v.r !== 'oui' && v.r !== 'non')) continue;
    if (!tags.has(tag)) { exclus++; continue; }
    if (v.r === 'oui') oui++; else non++;
  }
  const total = tags.size, repondu = oui + non;
  const pc = (n, sur) => (sur ? Math.round((n / sur) * 1000) / 10 : 0);
  return {
    total, oui, non, repondu, sansReponse: Math.max(0, total - repondu), exclus,
    pctOui: pc(oui, repondu), pctNon: repondu ? Math.round((100 - pc(oui, repondu)) * 10) / 10 : 0,
    tauxReponse: pc(repondu, total),
  };
}

const ROLES = { leader: 'Chef', coLeader: 'Chef adjoint', admin: 'Aîné', member: 'Membre' };
const ORDRE_ROLES = { leader: 0, coLeader: 1, admin: 2, member: 3 };

// Export CSV (séparateur « ; » pour Excel en français). Les cellules sont protégées contre les formules.
function exporterCSV(periode, membres, reponses) {
  const cell = (v) => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lignes = [['Joueur', 'Tag', 'Rôle', 'HDV', 'Réponse', 'Date de réponse (UTC)', 'Saisie par']];
  const vus = new Set();
  for (const m of membres || []) {
    vus.add(m.tag);
    const r = (reponses || {})[m.tag];
    lignes.push([m.name, m.tag, ROLES[m.role] || '', m.th || '', r ? r.r.toUpperCase() : 'SANS RÉPONSE', r ? r.le : '', r ? (r.par === 'chef' ? 'chef' : 'membre') : '']);
  }
  for (const [tag, r] of Object.entries(reponses || {})) {
    if (vus.has(tag) || !r) continue;
    lignes.push([r.nom || '', tag, 'Ancien membre', '', r.r.toUpperCase(), r.le, r.par === 'chef' ? 'chef' : 'membre']);
  }
  const entete = `Période;${cell(periode.titre || 'Signe / Non')};Du;${cell(periode.debut)};Au;${cell(periode.fin)}`;
  return '﻿' + entete + '\r\n' + lignes.map((l) => l.map(cell).join(';')).join('\r\n') + '\r\n';
}

module.exports = { statutPeriode, periodeCourante, chevauchements, validerPeriode, calculerStats, exporterCSV, ROLES, ORDRE_ROLES, JOUR, TITRE_MAX };
