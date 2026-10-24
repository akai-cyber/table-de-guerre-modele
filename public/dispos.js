/* Écran « Signe / Non » : périodes de disponibilité, réponses des membres, statistiques et outils du chef.
   Toutes les données viennent du serveur (/api/dispos) ; rien n'est inventé côté téléphone. */
initChef();
chargerClan();

const ROLES = { leader: 'Chef', coLeader: 'Chef adjoint', admin: 'Aîné', member: 'Membre' };
const ORDRE_ROLES = { leader: 0, coLeader: 1, admin: 2, member: 3 };
const STATUTS = { ouverte: 'Ouverte', a_venir: 'À venir', terminee: 'Terminée', cloturee: 'Close' };

let D = null;               // dernières données du serveur
let periodeVue = null;      // période choisie dans l'historique (null = période courante)
let filtre = 'tous', tri = store.get('cb_tri') || 'rang', texte = '';
let erreurChargement = null, envoi = false;

$('tri').value = tri;

// ---------- Chargement
let enCours = null, aRefaire = false;
// Un seul chargement à la fois ; une demande arrivée pendant un chargement (autre période choisie,
// réponse d'un autre téléphone) relance un chargement juste après, pour ne jamais afficher de données périmées.
async function charger() {
  if (enCours) { aRefaire = true; return enCours; }
  enCours = (async () => {
    do {
      aRefaire = false;
      const sessionEnvoyee = store.get('cb_session'), vue = periodeVue;
      try {
        const d = await api('/api/dispos' + (vue ? '?periode=' + encodeURIComponent(vue) : ''));
        if (vue !== periodeVue) { aRefaire = true; continue; } // la période affichée a changé entre-temps
        D = d; erreurChargement = null;
        if (D.moi) store.set('cb_moi', D.moi.tag);
        else if (sessionEnvoyee && store.get('cb_session') === sessionEnvoyee) store.del('cb_session'); // session expirée ou effacée
      } catch (e) {
        erreurChargement = e.message;
      }
      rendre();
    } while (aRefaire);
  })();
  try { await enCours; } finally { enCours = null; }
}
let attente = null;
socket.on('dispos', () => { clearTimeout(attente); attente = setTimeout(charger, 150); }); // un autre téléphone a répondu
socket.on('connect', () => { if (D) charger(); });
document.addEventListener('chef', rendre);
document.addEventListener('visibilitychange', () => { if (!document.hidden) charger(); });
setInterval(() => { if (!document.hidden) charger(); }, 60000);
setInterval(() => { if (D && !document.hidden) { rendrePeriode(); rendreInfo(); rendreActions(); } }, 20000);

// ---------- Outils
const P = () => D && D.periode;
const ouverte = () => P() && P().statut === 'ouverte';
const reponseDe = (tag) => (D && D.reponses && D.reponses[tag]) || null;
const moiMembre = () => D && D.moi && D.membres.find((m) => m.tag === D.moi.tag);
const toLocalInput = (iso) => { const d = new Date(iso); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? 's' : ''}`;

function rendre() {
  const e = $('erreur');
  if (erreurChargement) {
    e.hidden = false;
    e.innerHTML = `<div class="err" role="alert">${ico('alerte')}<div><b>Chargement impossible.</b><br><small>${esc(erreurChargement)}</small><br><button type="button" class="btn petit sombre" id="reessayer" style="margin-top:8px">${ico('rafraichir')}Réessayer</button></div></div>`;
    $('reessayer').onclick = charger;
    if (!D) return;
  } else e.hidden = true;
  if (!D) return;
  rendrePeriode(); rendreInfo(); rendreStats(); rendreChef(); rendreFiltres(); rendreListe(); rendreActions();
}

// ---------- Carte de la période
function rendrePeriode() {
  const p = P(), box = $('periode');
  if (!p) {
    box.innerHTML = `<div class="rangee">${ico('calendrier')}<div><small>Période actuelle</small><b>Aucune période en cours</b></div></div>
      <div class="rangee">${ico('horloge')}<div><small>Temps restant</small><b>—</b></div></div>`;
    return;
  }
  const maintenant = Date.now(), d = Date.parse(p.debut), f = Date.parse(p.fin);
  let temps;
  if (p.statut === 'ouverte') temps = ['Temps restant', duree(f - maintenant)];
  else if (p.statut === 'a_venir') temps = ['Ouverture dans', duree(d - maintenant)];
  else if (p.statut === 'cloturee') temps = ['Réponses', 'Closes par le chef'];
  else temps = ['Terminée', fmtDate(p.fin)];
  const courante = !periodeVue;
  const histo = D.periodes.length > 1 || periodeVue
    ? `<label class="sr" for="choixPeriode">Changer de période</label><select id="choixPeriode">${D.periodes.map((x) =>
      `<option value="${esc(x.id)}"${x.id === p.id ? ' selected' : ''}>${esc(x.titre || 'Signe / Non')} · ${fmtJour(x.debut)} → ${fmtJour(x.fin)} (${STATUTS[x.statut]})</option>`).join('')}</select>` : '';
  box.innerHTML = `
    <div class="rangee" style="justify-content:space-between"><b class="titre-periode">${esc(p.titre || (courante ? 'Période actuelle' : 'Période'))}</b><span class="statut ${p.statut}">${STATUTS[p.statut]}</span></div>
    <div class="rangee">${ico('calendrier')}<div><small>${courante ? 'Période actuelle' : 'Période affichée'}</small><b>Du ${fmtJour(p.debut)} au ${fmtJour(p.fin)}</b></div></div>
    <div class="rangee">${ico('horloge')}<div><small>${temps[0]}</small><b id="tempsRestant">${esc(temps[1])}</b></div></div>
    ${histo}`;
  const s = $('choixPeriode');
  if (s) s.onchange = () => { const cour = D.periodes.find((x) => x.statut === 'ouverte'); periodeVue = cour && cour.id === s.value ? null : s.value; charger(); };
}

// ---------- Message d'information (piloté par l'état réel)
function rendreInfo() {
  const p = P(), st = D.stats, box = $('info');
  let cls = 'bleu', icone = 'info', titre, sous;
  const moi = D.moi, ma = moi && reponseDe(moi.tag);
  if (!p) {
    titre = 'Aucune période de disponibilité';
    sous = estChef ? 'Lance une période avec « Nouvelle période » dans les outils du chef.' : 'Le chef n’a pas encore ouvert de période.';
  } else if (p.statut === 'a_venir') {
    cls = 'or'; icone = 'horloge';
    titre = `Ouverture le ${fmtDate(p.debut)}`;
    sous = 'Tu pourras répondre dès l’ouverture.';
  } else if (p.statut === 'ouverte') {
    const reste = Date.parse(p.fin) - Date.now();
    if (ma) {
      cls = 'vert'; icone = 'check';
      titre = `Merci ! Ta réponse : ${ma.r.toUpperCase()}`;
      sous = `Enregistrée ${ilYa(ma.le)}${ma.par === 'chef' ? ' par le chef' : ''}. Tu peux la modifier jusqu’au ${fmtDate(p.fin)}.`;
    } else if (moi) {
      cls = 'or'; icone = 'cloche';
      titre = reste < 24 * 3600e3 ? `Plus que ${duree(reste)} pour répondre !` : 'Tu n’as pas encore répondu';
      sous = 'Choisis « Je signe » ou « Je dis non » en bas de l’écran.';
    } else {
      cls = 'or'; icone = 'joueur';
      titre = 'Identifie-toi pour répondre';
      sous = 'Appuie sur « Qui es-tu ? » en bas de l’écran.';
    }
    if (st.total) sous += ` · ${pluriel(st.repondu, 'réponse')} sur ${st.total} membres.`;
  } else {
    cls = 'rouge'; icone = 'cadenas';
    titre = p.statut === 'cloturee' ? 'Réponses closes' : 'Période terminée';
    sous = `${pluriel(st.repondu, 'réponse')} : ${st.oui} oui, ${st.non} non${st.sansReponse ? `, ${st.sansReponse} sans réponse` : ''}.`;
  }
  box.className = 'panneau creux message-info';
  box.innerHTML = `<span class="rond-icone ${cls}">${ico(icone)}</span><div><b>${esc(titre)}</b><small>${esc(sous)}</small>${
    ma && ouverte() ? '<button type="button" class="btn petit sombre" id="retirer" style="margin-top:8px">' + ico('croix') + 'Retirer ma réponse</button>' : ''}</div>`;
  const r = $('retirer');
  if (r) r.onclick = async () => { if (await ui.confirmer('Retirer ta réponse pour cette période ?', { ok: 'Retirer' })) repondre(null); };
}

// ---------- Statistiques
function rendreStats() {
  const s = D.stats;
  $('stats').innerHTML = `
    <div class="panneau stat" id="statOui"><span class="rond-icone vert">${ico('check')}</span><span class="chiffre">${s.oui}</span><span class="lib"><b>Oui</b><small>${String(s.pctOui).replace('.', ',')} %</small></span></div>
    <div class="panneau stat" id="statNon"><span class="rond-icone rouge">${ico('croix')}</span><span class="chiffre">${s.non}</span><span class="lib"><b>Non</b><small>${String(s.pctNon).replace('.', ',')} %</small></span></div>`;
  const bouts = [`Sans réponse : <b>${s.sansReponse}</b>`, `Taux de réponse : <b>${String(s.tauxReponse).replace('.', ',')} %</b>`];
  if (s.exclus) bouts.push(`${s.exclus} réponse${s.exclus > 1 ? 's' : ''} d’ancien${s.exclus > 1 ? 's' : ''} membre${s.exclus > 1 ? 's' : ''} non comptée${s.exclus > 1 ? 's' : ''}`);
  if (!D.membresFiables) bouts.push('Liste du clan indisponible : seules les réponses sont comptées');
  $('resumeStats').innerHTML = bouts.join(' · ') + '<br><small>Pourcentages calculés sur les réponses des membres actuels.</small>';
}

// ---------- Outils du chef
function rendreChef() {
  const box = $('outilsChef');
  box.hidden = !estChef;
  if (!estChef) return;
  const p = P();
  const b = (id, icone, texteBtn, cls = '') => `<button type="button" class="btn ${cls}" data-chef="${id}">${ico(icone)}${texteBtn}</button>`;
  let html = b('nouvelle', 'plus', 'Nouvelle période', 'on');
  if (p) {
    html += b('renouveler', 'rafraichir', 'Renouveler');
    html += b('modifier', 'crayon', 'Modifier');
    html += p.cloturee ? b('rouvrir', 'cadenas', 'Rouvrir', 'vert') : (p.statut === 'terminee' ? '' : b('cloturer', 'cadenas', 'Clôturer'));
    if (ouverte()) html += b('rappel', 'cloche', 'Rappel');
    html += b('export', 'telecharger', 'Exporter');
    html += b('supprimer', 'poubelle', 'Supprimer', 'rouge');
  }
  $('grilleChef').innerHTML = html;
}
$('grilleChef').addEventListener('click', (e) => {
  const b = e.target.closest('[data-chef]');
  if (!b || !estChef) return;
  ({ nouvelle: () => formulairePeriode(), renouveler, modifier: () => formulairePeriode(P()), cloturer: () => cloture(true), rouvrir: () => cloture(false), rappel, export: exporter, supprimer })[b.dataset.chef]();
});

async function actionChef(promesse, message) {
  try { const r = await promesse; if (message) ui.toast(message, 'ok'); await charger(); return r; }
  catch (e) {
    if (e.status === 403) { store.del('cb_chef'); estChef = false; document.dispatchEvent(new CustomEvent('chef')); }
    ui.toast(e.message, 'err'); throw e;
  }
}

function formulairePeriode(existante) {
  const debut = existante ? existante.debut : new Date().toISOString();
  const fin = existante ? existante.fin : new Date(Date.now() + 7 * 24 * 3600e3).toISOString();
  const corps = `<div class="form-grille">
      <label class="champ"><span>Titre (facultatif)</span><input id="fTitre" maxlength="60" placeholder="Ex. : Semaine de guerre" value="${esc(existante ? existante.titre : '')}"></label>
      <label class="champ"><span>Début</span><input id="fDebut" type="datetime-local" value="${toLocalInput(debut)}" required></label>
      <label class="champ"><span>Fin</span><input id="fFin" type="datetime-local" value="${toLocalInput(fin)}" required></label>
      <small>Heures de ton appareil. Les membres voient les dates à leur heure locale.</small>
      <div id="fErr"></div>
    </div>`;
  const valider = async (m) => {
    const corpsReq = { titre: m.querySelector('#fTitre').value, debut: fromLocalInput(m.querySelector('#fDebut').value), fin: fromLocalInput(m.querySelector('#fFin').value) };
    const err = (t) => { m.querySelector('#fErr').innerHTML = `<div class="err" role="alert">${ico('alerte')}<span>${esc(t)}</span></div>`; return false; };
    if (!corpsReq.debut || !corpsReq.fin) return err('Indique un début et une fin.');
    try {
      if (existante) await api('/api/dispos/periodes/' + existante.id, { method: 'PATCH', body: corpsReq, chef: true });
      else await envoyerNouvelle(corpsReq);
    } catch (e) { return err(e.message); }
    periodeVue = null; ui.toast(existante ? 'Période modifiée.' : 'Période créée.', 'ok'); charger();
    return true;
  };
  ui.modale({ titre: existante ? 'Modifier la période' : 'Nouvelle période', icone: 'calendrier', corps, actions: [{ texte: 'Annuler', valeur: false, classe: 'sombre' }, { texte: existante ? 'Enregistrer' : 'Créer', valeur: true, classe: 'on', valider }] });
}
// Si une période est déjà prévue sur ces dates, on demande avant de la clôturer.
async function envoyerNouvelle(corps) {
  try { return await api('/api/dispos/periodes', { method: 'POST', body: corps, chef: true }); }
  catch (e) {
    if (e.status !== 409 || !e.donnees || !e.donnees.conflits) throw e;
    const c = e.donnees.conflits[0];
    const ok = await ui.confirmer(`La période « ${c.titre || 'Signe / Non'} » (${fmtJour(c.debut)} → ${fmtJour(c.fin)}) chevauche ces dates. La clôturer et créer la nouvelle ? Ses réponses restent dans l’historique.`, { ok: 'Clôturer et créer', titre: 'Période en cours' });
    if (!ok) throw new Error('Création annulée.');
    return api('/api/dispos/periodes', { method: 'POST', body: { ...corps, remplacer: true }, chef: true });
  }
}
async function renouveler() {
  const p = P(), longueur = Math.max(3600e3, Date.parse(p.fin) - Date.parse(p.debut));
  const debut = new Date().toISOString(), fin = new Date(Date.now() + longueur).toISOString();
  if (!await ui.confirmer(`Ouvrir une nouvelle période de ${duree(longueur)}, du ${fmtDate(debut)} au ${fmtDate(fin)} ? Les réponses repartent de zéro (l’ancienne période reste dans l’historique).`, { ok: 'Renouveler', titre: 'Renouveler' })) return;
  try { await envoyerNouvelle({ titre: p.titre, debut, fin }); periodeVue = null; ui.toast('Nouvelle période ouverte.', 'ok'); charger(); }
  catch (e) { ui.toast(e.message, 'err'); }
}
async function cloture(fermer) {
  const p = P();
  if (fermer && !await ui.confirmer('Clôturer cette période ? Plus personne ne pourra répondre (tu pourras la rouvrir).', { ok: 'Clôturer', titre: 'Clôturer' })) return;
  actionChef(api(`/api/dispos/periodes/${p.id}/cloture`, { method: 'POST', body: { cloturee: fermer }, chef: true }), fermer ? 'Période clôturée.' : 'Période rouverte.').catch(() => {});
}
async function supprimer() {
  const p = P();
  if (!await ui.confirmer(`Supprimer définitivement la période « ${p.titre || 'Signe / Non'} » et ses ${pluriel(D.stats.repondu + D.stats.exclus, 'réponse')} ?`, { ok: 'Supprimer', danger: true, titre: 'Supprimer' })) return;
  periodeVue = null;
  actionChef(api(`/api/dispos/periodes/${p.id}`, { method: 'DELETE', chef: true }), 'Période supprimée.').catch(() => {});
}
// Pas de notifications push : le rappel est un message prêt à partager (chat du clan, Discord…).
async function rappel() {
  const p = P();
  const sans = D.membres.filter((m) => !reponseDe(m.tag)).map((m) => m.name);
  const msg = `📋 Signe / Non${p.titre ? ' – ' + p.titre : ''} : réponds avant le ${fmtDate(p.fin)} sur ${location.origin}/dispos.html` +
    (sans.length ? `\nPas encore répondu (${sans.length}) : ${sans.join(', ')}` : '\nTout le monde a répondu, merci !');
  const choix = await ui.modale({
    titre: 'Rappel aux membres', icone: 'cloche',
    corps: `<p class="doux">L’appli ne peut pas envoyer de notification dans le jeu. Copie ce message dans le chat du clan ou partage-le.</p><textarea id="texteRappel" rows="6" readonly>${esc(msg)}</textarea>`,
    actions: [...(navigator.share ? [{ texte: 'Partager', valeur: 'partager', classe: 'sombre', ico: 'partager' }] : []), { texte: 'Copier', valeur: 'copier', classe: 'on', ico: 'copier' }],
  });
  if (choix === 'partager') navigator.share({ text: msg }).catch(() => {});
  if (choix === 'copier') copier(msg);
}
async function copier(t) {
  try { await navigator.clipboard.writeText(t); ui.toast('Message copié.', 'ok'); }
  catch (e) { ui.toast('Copie impossible : sélectionne le texte à la main.', 'err'); }
}
async function exporter() {
  const p = P();
  try {
    const r = await fetch(`/api/dispos/periodes/${p.id}/export.csv`, { headers: { 'X-Chef': store.get('cb_chef') || '' } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Export impossible.');
    const blob = await r.blob(), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `signe-non-${p.debut.slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    ui.toast('Export prêt (fichier CSV).', 'ok');
  } catch (e) { ui.toast(e.message, 'err'); }
}

// ---------- Liste des membres : filtres, recherche, tri
function rendreFiltres() {
  const s = D.stats;
  const f = [['tous', 'Tous', D.membres.length], ['oui', 'Oui', s.oui], ['non', 'Non', s.non], ['sans', 'Sans réponse', s.sansReponse]];
  $('filtres').innerHTML = f.map(([k, l, n]) => `<button type="button" role="tab" class="puce-filtre${k === filtre ? ' on' : ''}" data-filtre="${k}" aria-selected="${k === filtre}">${l}<i>${n}</i></button>`).join('');
}
$('filtres').addEventListener('click', (e) => { const b = e.target.closest('[data-filtre]'); if (!b) return; filtre = b.dataset.filtre; rendreFiltres(); rendreListe(); });
$('recherche').addEventListener('input', (e) => { texte = e.target.value.trim().toLocaleLowerCase('fr'); rendreListe(); });
$('tri').addEventListener('change', (e) => { tri = e.target.value; store.set('cb_tri', tri); rendreListe(); });

function trier(liste) {
  const nom = (a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
  const cmp = {
    rang: (a, b) => (a.rang || 99) - (b.rang || 99) || nom(a, b),
    nom,
    role: (a, b) => (ORDRE_ROLES[a.role] ?? 9) - (ORDRE_ROLES[b.role] ?? 9) || (a.rang || 99) - (b.rang || 99),
    recent: (a, b) => { const x = reponseDe(a.tag), y = reponseDe(b.tag); return (y ? Date.parse(y.le) : 0) - (x ? Date.parse(x.le) : 0) || nom(a, b); },
  }[tri] || nom;
  return [...liste].sort(cmp);
}
function ligne(m) {
  const r = reponseDe(m.tag), moi = D.moi && D.moi.tag === m.tag;
  const etat = r
    ? `<span class="pastille ${r.r}">${ico(r.r === 'oui' ? 'check' : 'croix')}${r.r === 'oui' ? 'Oui' : 'Non'}</span><small>${esc(ilYa(r.le))}${r.par === 'chef' ? ' · chef' : ''}</small>`
    : '<span class="pastille attente">En attente</span><small>&nbsp;</small>';
  const role = [m.role ? ROLES[m.role] || '' : '', moi ? 'C’est toi' : ''].filter(Boolean).join(' · ');
  return `<li class="r cliquable${moi ? ' moi' : ''}" data-tag="${esc(m.tag)}" tabindex="0" role="button" aria-label="${esc(m.name)}${r ? ', ' + r.r : ', sans réponse'}">
    ${hexa(m.exp)}${bouclier(m.th)}
    <div class="info"><b>${esc(m.name)}</b><small>${esc(role || 'Membre')}</small></div>
    <div class="etat-reponse">${etat}</div>${ico('chevron', 'chev')}</li>`;
}
function rendreListe() {
  const ul = $('membres');
  let liste = D.membres;
  if (filtre === 'oui') liste = liste.filter((m) => (reponseDe(m.tag) || {}).r === 'oui');
  else if (filtre === 'non') liste = liste.filter((m) => (reponseDe(m.tag) || {}).r === 'non');
  else if (filtre === 'sans') liste = liste.filter((m) => !reponseDe(m.tag));
  if (texte) liste = liste.filter((m) => m.name.toLocaleLowerCase('fr').includes(texte) || m.tag.toLowerCase().includes(texte));
  liste = trier(liste);
  if (!D.membres.length) {
    ul.innerHTML = `<li class="vide-liste">${ico('membres')}${D.erreurClan ? 'Liste du clan indisponible : ' + esc(D.erreurClan) : 'Aucun membre à afficher.'}</li>`;
  } else if (!liste.length) {
    ul.innerHTML = `<li class="vide-liste">${ico('recherche')}${texte ? 'Aucun joueur ne correspond à « ' + esc(texte) + ' ».' : { oui: 'Personne n’a encore répondu oui.', non: 'Personne n’a répondu non.', sans: 'Tout le monde a répondu !' }[filtre] || 'Aucun membre.'}</li>`;
  } else ul.innerHTML = liste.map(ligne).join('');
}
function ouvrirMembre(tag) {
  const m = D.membres.find((x) => x.tag === tag);
  if (!m) return;
  const r = reponseDe(tag), p = P();
  const corps = `<div style="display:flex;gap:10px;align-items:center">${hexa(m.exp)}${bouclier(m.th)}<div class="info"><b>${esc(m.name)}</b><small>${esc(m.tag)}</small></div></div>
    <dl class="fiche">
      ${m.role ? `<dt>Rôle</dt><dd>${esc(ROLES[m.role] || m.role)}</dd>` : ''}
      ${m.th ? `<dt>Hôtel de ville</dt><dd>${m.th}</dd>` : ''}
      ${m.exp ? `<dt>Niveau</dt><dd>${m.exp}</dd>` : ''}
      ${m.trophees ? `<dt>Trophées</dt><dd>${m.trophees.toLocaleString('fr-FR')}</dd>` : ''}
      <dt>Réponse</dt><dd>${r ? (r.r === 'oui' ? 'OUI' : 'NON') : 'Sans réponse'}</dd>
      ${r ? `<dt>Répondu</dt><dd>${esc(fmtDate(r.le))}</dd><dt>Saisie par</dt><dd>${r.par === 'chef' ? 'le chef' : 'le joueur'}</dd>` : ''}
    </dl>`;
  const actions = [{ texte: 'Stats', valeur: 'stats', classe: 'sombre', ico: 'stats' }];
  if (estChef && p) {
    actions.push({ texte: 'Oui', valeur: 'oui', classe: 'vert', ico: 'check' }, { texte: 'Non', valeur: 'non', classe: 'rouge', ico: 'croix' });
    if (r) actions.push({ texte: 'Effacer', valeur: 'effacer', classe: 'sombre', ico: 'poubelle' });
  }
  ui.modale({ titre: 'Fiche du membre', icone: 'joueur', corps: corps + (estChef && p ? '<small>Chef : tu peux saisir ou corriger sa réponse (indiqué « saisi par le chef »).</small>' : ''), actions }).then(async (v) => {
    if (!v) return;
    if (v === 'stats') { location.href = '/joueur.html?tag=' + encodeURIComponent(m.tag); return; }
    const val = v === 'effacer' ? null : v;
    const msg = val ? `Enregistrer ${val.toUpperCase()} pour ${m.name} ? Ce sera indiqué comme saisi par le chef.` : `Effacer la réponse de ${m.name} ?`;
    if (!await ui.confirmer(msg, { ok: val ? 'Enregistrer' : 'Effacer', danger: !val })) return;
    actionChef(api(`/api/dispos/periodes/${p.id}/reponses/${encodeURIComponent(m.tag)}`, { method: 'PUT', body: { r: val }, chef: true }), 'Réponse mise à jour.').catch(() => {});
  });
}
$('membres').addEventListener('click', (e) => { const li = e.target.closest('li[data-tag]'); if (li) ouvrirMembre(li.dataset.tag); });
$('membres').addEventListener('keydown', (e) => { const li = e.target.closest('li[data-tag]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ouvrirMembre(li.dataset.tag); } });

// ---------- Barre d'actions : mes réponses
function rendreActions() {
  const box = $('actionsDedans'), p = P(), moi = D.moi;
  let html;
  if (!p || !ouverte()) {
    const t = !p ? 'Aucune période ouverte pour le moment.' : p.statut === 'a_venir' ? `Ouverture le ${fmtDate(p.debut)}.` : 'Les réponses sont fermées.';
    html = `<p class="note">${ico('cadenas')} ${esc(t)}</p>`;
  } else if (!moi) {
    html = `<button type="button" class="btn on" id="identifier">${ico('joueur')}Qui es-tu ?</button>`;
  } else if (D.membresFiables && !moiMembre()) {
    html = `<p class="note">${esc(moi.nom)} ne fait plus partie du clan.</p><button type="button" class="btn sombre petit" id="changer">Changer</button>`;
  } else {
    const r = reponseDe(moi.tag);
    html = `<button type="button" class="btn on${r && r.r === 'oui' ? ' choisi' : ''}" id="repOui" aria-pressed="${Boolean(r && r.r === 'oui')}"><span class="rond rv">${ico('check')}</span>Je signe</button>
            <button type="button" class="btn rouge${r && r.r === 'non' ? ' choisi' : ''}" id="repNon" aria-pressed="${Boolean(r && r.r === 'non')}"><span class="rond rb">${ico('croix')}</span>Je dis non</button>`;
  }
  box.innerHTML = html;
  if ($('identifier')) $('identifier').onclick = identifier;
  if ($('changer')) $('changer').onclick = deconnecter;
  if ($('repOui')) $('repOui').onclick = () => repondre('oui');
  if ($('repNon')) $('repNon').onclick = () => repondre('non');
}
async function repondre(r) {
  const p = P();
  if (envoi || !p) return;
  const actuelle = D.moi && reponseDe(D.moi.tag);
  if (actuelle && actuelle.r === r) return ui.toast(`Ta réponse ${r.toUpperCase()} est déjà enregistrée.`);
  const btn = r === 'oui' ? $('repOui') : r === 'non' ? $('repNon') : $('retirer');
  envoi = true;
  if (btn) { btn.classList.add('charge'); btn.disabled = true; }
  try {
    await api(`/api/dispos/periodes/${p.id}/ma-reponse`, { method: 'PUT', body: { r } });
    ui.toast(r ? `Réponse ${r.toUpperCase()} enregistrée.` : 'Réponse retirée.', 'ok');
  } catch (e) {
    if (e.status === 401) { store.del('cb_session'); }
    ui.toast(e.message, 'err');
  } finally {
    envoi = false;
    await charger();
  }
}

// ---------- Identification du membre
function identifier() {
  if (!D.membresFiables || !D.membres.length) return ui.toast('Liste du clan indisponible : réessaie dans un moment.', 'err');
  const options = [...D.membres].sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
    .map((m) => `<option value="${esc(m.tag)}"${m.tag === store.get('cb_moi') ? ' selected' : ''}>${esc(m.name)} (${esc(m.tag)})</option>`).join('');
  const jeton = D.identite === 'jeton';
  const corps = `<div class="form-grille">
    <label class="champ"><span>Ton nom dans le clan</span><select id="iTag"><option value="">Choisis ton nom</option>${options}</select></label>
    ${jeton ? `<label class="champ"><span>Jeton API du jeu</span><input id="iJeton" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16" placeholder="Ex. : 8A2B9CDE"></label>
    <small>Pour prouver que c’est bien toi : dans Clash of Clans, ouvre <b>Paramètres → Plus de paramètres → Jeton API</b>, appuie sur « Afficher » et recopie les caractères. Le jeton change à chaque fois et ne donne accès à rien d’autre.</small>`
    : '<small>Ce serveur ne vérifie pas l’identité : choisis uniquement ton propre nom.</small>'}
    <div id="iErr"></div></div>`;
  const valider = async (m) => {
    const err = (t) => { m.querySelector('#iErr').innerHTML = `<div class="err" role="alert">${ico('alerte')}<span>${esc(t)}</span></div>`; return false; };
    const tag = m.querySelector('#iTag').value;
    if (!tag) return err('Choisis ton nom dans la liste.');
    const body = { tag };
    if (jeton) { body.jeton = m.querySelector('#iJeton').value.trim(); if (!body.jeton) return err('Recopie le jeton affiché dans le jeu.'); }
    try {
      const r = await api('/api/moi', { method: 'POST', body });
      store.set('cb_session', r.session); store.set('cb_moi', r.moi.tag);
      ui.toast(`Bienvenue, ${r.moi.nom} !`, 'ok');
      charger();
      return true;
    } catch (e) { return err(e.message); }
  };
  ui.modale({ titre: 'Qui es-tu ?', icone: 'joueur', corps, actions: [{ texte: 'Annuler', valeur: false, classe: 'sombre' }, { texte: 'Valider', valeur: true, classe: 'on', valider }] });
}
async function deconnecter() {
  try { await api('/api/moi', { method: 'DELETE' }); } catch (e) { /* hors ligne : on oublie quand même */ }
  store.del('cb_session'); charger();
}

charger();
