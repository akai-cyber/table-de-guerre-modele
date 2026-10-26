/* Écran « Stats » : bilan du clan, classement des joueurs, historique des guerres et compos.
   Les chiffres viennent des guerres enregistrées par le serveur (/api/stats, /api/guerres). */
initChef();
chargerClan();

let vue = store.get('cb_vue_stats') || 'joueurs';
let derniers = store.get('cb_derniers') || '10', type = store.get('cb_type') || 'tous', actuels = store.get('cb_actuels') !== '0';
let S = null, H = null, COMPOS = [], erreur = null;
$('fDerniers').value = derniers; $('fType').value = type; $('fActuels').checked = actuels;

async function charger() {
  try {
    [S, H] = await Promise.all([api(`/api/stats?derniers=${derniers}&type=${type}`), api('/api/guerres')]);
    if (!COMPOS.length) COMPOS = (await api('/api/compos')).compos;
    erreur = null;
  } catch (e) { erreur = e.message; }
  rendre();
}
socket.on('guerres', () => charger());
document.addEventListener('visibilitychange', () => { if (!document.hidden) charger(); });
document.addEventListener('chef', () => { if (vue === 'activite') rendreActivite(); if (vue === 'historique') rendreHistorique(); });

function rendre() {
  if (erreur && !S) {
    $('kpis').innerHTML = `<div class="err" role="alert" style="grid-column:1/-1">${ico('alerte')}<span>${esc(erreur)}</span></div>`;
    return;
  }
  if (!S) return;
  rendreKpis(); rendreVues();
  if (vue === 'classement') rendreClassement();
  if (vue === 'historique') rendreHistorique();
  if (vue === 'compos') rendreCompos();
  if (vue === 'joueurs') rendreGrille();
  if (vue === 'raids') rendreRaids();
  if (vue === 'activite') rendreActivite();
  if (vue === 'ldc') rendreLdc();
}

// ---------- Bilan du clan
function rendreKpis() {
  const c = S.clan;
  const k = (lib, val, cls = '') => `<div class="kpi"><small>${lib}</small><b class="${cls}">${val}</b></div>`;
  $('kpis').innerHTML = !c.guerres
    ? `<p class="doux" style="grid-column:1/-1;margin:0">${ico('info')} Aucune guerre enregistrée pour l’instant. Les statistiques se remplissent automatiquement à chaque guerre suivie par l’appli (il suffit que quelqu’un l’ouvre pendant ou après la guerre).</p>`
    : k('Guerres suivies', c.guerres, 'cyan') + k('Victoires', `${nombre(c.tauxVictoire)} %`, 'vert') + k('Taux de 3 étoiles', `${nombre(c.tauxTriple)} %`, 'or')
      + k('Étoiles / attaque', nombre(c.moyEtoiles, 2)) + k('Bilan V / D / N', `${c.victoires} / ${c.defaites} / ${c.egalites}`) + k('Destruction moy.', `${nombre(c.moyPct)} %`)
      + k('Attaques', c.attaques) + k('Attaques ratées', c.manquees, c.manquees ? 'rouge' : 'vert');
}
function rendreVues() {
  document.querySelectorAll('#vues [data-vue]').forEach((b) => { const on = b.dataset.vue === vue; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  $('vueClassement').hidden = vue !== 'classement'; $('vueHistorique').hidden = vue !== 'historique'; $('vueCompos').hidden = vue !== 'compos';
  $('vueJoueurs').hidden = vue !== 'joueurs'; $('vueRaids').hidden = vue !== 'raids'; $('vueActivite').hidden = vue !== 'activite'; $('vueLdc').hidden = vue !== 'ldc';
}
$('vues').addEventListener('click', (e) => { const b = e.target.closest('[data-vue]'); if (!b) return; vue = b.dataset.vue; store.set('cb_vue_stats', vue); rendre(); });
$('fDerniers').onchange = (e) => { derniers = e.target.value; store.set('cb_derniers', derniers); charger(); };
$('fType').onchange = (e) => { type = e.target.value; store.set('cb_type', type); charger(); };
$('fActuels').onchange = (e) => { actuels = e.target.checked; store.set('cb_actuels', actuels ? '1' : '0'); rendreClassement(); };

// ---------- Classement
const versJoueur = (tag) => { location.href = '/joueur.html?tag=' + encodeURIComponent(tag); };
function joueursAffiches() {
  let j = S.joueurs.filter((x) => x.attaques > 0 || x.manquees > 0);
  if (actuels) j = j.filter((x) => x.membre !== false);
  return j;
}
function rendreClassement() {
  const j = joueursAffiches();
  const top = j.slice(0, 3);
  const marche = (x, n) => x ? `<div class="marche m${n}" role="button" tabindex="0" data-tag="${esc(x.tag)}">
      ${ico(n === 1 ? 'trophee' : 'medaille')}<span class="rang">#${x.rang}</span><span class="nom-p">${esc(x.nom)}</span><span class="note">${nombre(x.note)}</span>
      <small>${nombre(x.tauxTriple)} % de 3★</small></div>` : '<div></div>';
  $('podium').innerHTML = top.length ? `<div class="podium">${marche(top[1], 2)}${marche(top[0], 1)}${marche(top[2], 3)}</div>` : '';
  const ul = $('classement');
  if (!j.length) { ul.innerHTML = `<li class="vide-liste">${ico('stats')}Pas encore d’attaque enregistrée sur cette période.</li>`; return; }
  const n = j.length;
  ul.innerHTML = j.map((x, i) => {
    const cls = i < 3 ? 'top' : i >= n - 3 && n > 6 ? 'bas' : '';
    return `<li class="r cliquable" data-tag="${esc(x.tag)}" tabindex="0" role="button" aria-label="${esc(x.nom)}, rang ${x.rang}, note ${nombre(x.note)}">
      <span class="rang-num">${x.rang}</span>${bouclier(x.th)}
      <div class="info"><b>${esc(x.nom)}${x.membre === false ? ' <span class="k gris">parti</span>' : ''}</b>
        <div class="mini-stats"><span><b>${nombre(x.moyEtoiles, 2)}</b>★/att.</span><span><b>${nombre(x.tauxTriple)} %</b> 3★</span><span><b>${x.attaques}/${x.possibles}</b> att.</span>${x.manquees ? `<span class="accent" style="color:var(--rouge)"><b style="color:inherit">${x.manquees}</b> ratée${x.manquees > 1 ? 's' : ''}</span>` : ''}</div>
        <div style="margin-top:4px">${formeHtml(x.forme)}${x.peuDeDonnees ? ' <small>· peu de données</small>' : ''}</div></div>
      <span class="note-badge ${cls}" title="Note sur 100">${nombre(x.note, 0)}</span>${ico('chevron', 'chev')}</li>`;
  }).join('');
}
for (const id of ['classement', 'podium']) {
  $(id).addEventListener('click', (e) => { const el = e.target.closest('[data-tag]'); if (el) versJoueur(el.dataset.tag); });
  $(id).addEventListener('keydown', (e) => { const el = e.target.closest('[data-tag]'); if (el && e.key === 'Enter') versJoueur(el.dataset.tag); });
}
$('aideNote').onclick = () => ui.modale({
  titre: 'Comment la note est calculée', icone: 'medaille',
  corps: `<p>Chaque joueur reçoit une <b>note sur 100</b> calculée sur ses attaques de la période choisie :</p>
    <dl class="fiche">
      <dt>Attaques à 3 étoiles</dt><dd>${S.poids.triple} pts</dd>
      <dt>Étoiles moyennes (sur 3)</dt><dd>${S.poids.etoiles} pts</dd>
      <dt>Attaques faites / possibles</dt><dd>${S.poids.participation} pts</dd>
      <dt>Destruction moyenne</dt><dd>${S.poids.destruction} pts</dd>
    </dl>
    <p class="doux">Un 3 étoiles sur un hôtel de ville plus haut que le sien compte davantage (jusqu’à ×1,3), sur un plus bas un peu moins (jusqu’à ×0,7). Une attaque oubliée fait baisser la note. En cas d’égalité : nouvelles étoiles apportées au clan, puis taux de 3 étoiles.</p>`,
});

// ---------- Historique
function rendreHistorique() {
  const ul = $('historique');
  $('ajouterGuerre').hidden = !estChef;
  $('infoHisto').innerHTML = H.erreurJournal
    ? `${ico('info')} Journal de guerre officiel indisponible (${esc(H.erreurJournal)}) : seules les guerres suivies par l’appli sont affichées.`
    : `${ico('info')} Les guerres marquées <span class="k cyan">Détails</span> ont été suivies par l’appli : toutes les attaques sont consultables. Les autres viennent du journal officiel (score seulement).`;
  if (!H.guerres.length) { ul.innerHTML = `<li class="vide-liste">${ico('epees')}Aucune guerre pour l’instant.</li>`; return; }
  ul.innerHTML = H.guerres.map((g) => {
    const cls = g.etat !== 'warEnded' ? 'encours' : g.res || '';
    const lib = g.etat !== 'warEnded' ? 'En cours' : RESULTATS[g.res] || 'Terminée';
    const kres = { victoire: 'vert', defaite: 'rouge', egalite: 'or' }[g.res] || 'cyan';
    return `<li class="carte-guerre ${cls}${g.details ? ' cliquable' : ''}" ${g.details ? `data-id="${esc(g.id)}" role="button" tabindex="0"` : ''}>
      ${g.adv.b ? `<img class="blason-mini" src="${esc(g.adv.b)}" alt="" referrerpolicy="no-referrer" loading="lazy">` : `<span class="rond-icone bleu" style="width:34px;height:34px">${ico('epees')}</span>`}
      <div style="min-width:0"><div class="adv">${esc(g.adv.n)}</div>
        <small>${g.fin ? fmtJour(g.fin) : ''} · ${g.taille} vs ${g.taille} · ${g.type === 'l' ? 'Ligue' : 'Guerre'}${g.mvp ? ` · MVP <b style="color:var(--or-clair)">${esc(g.mvp.nom)}</b>` : ''}</small>
        <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap"><span class="k ${kres}">${lib}</span>${g.details ? `<span class="k cyan">${g.manuelle ? 'Saisie manuelle' : 'Détails'}</span>` : estChef ? `<button type="button" class="btn petit on" data-saisir="${esc(g.id)}">${ico('crayon')}Saisir le détail</button>` : '<span class="k gris">Score seulement</span>'}</div></div>
      <div class="score"><span class="nous">${g.clan.e}</span> <span class="doux">–</span> <span class="eux">${g.adv.e}</span><small style="display:block;text-align:right">${nombre(g.clan.p)} %</small></div></li>`;
  }).join('');
}
$('historique').addEventListener('click', (e) => {
  const s2 = e.target.closest('[data-saisir]');
  if (s2) { e.stopPropagation(); editeurGuerre(H.guerres.find((g) => g.id === s2.dataset.saisir)); return; }
  const el = e.target.closest('[data-id]'); if (el) ouvrirGuerre(el.dataset.id);
});
$('ajouterGuerre').onclick = () => editeurGuerre(null);
$('historique').addEventListener('keydown', (e) => { const el = e.target.closest('[data-id]'); if (el && e.key === 'Enter') ouvrirGuerre(el.dataset.id); });

// Détail d'une guerre : toutes les attaques, et la compo que chacun peut renseigner.
async function ouvrirGuerre(id) {
  let d;
  try { d = await api('/api/guerres/' + encodeURIComponent(id)); } catch (e) { return ui.toast(e.message, 'err'); }
  const g = d.guerre, moi = store.get('cb_moi');
  const opt = (c) => `<option value="">Compo ?</option>${COMPOS.map((x) => `<option${x === c ? ' selected' : ''}>${esc(x)}</option>`).join('')}`;
  const lignes = g.m.map((m) => {
    const peut = estChef || (moi === m.t && store.get('cb_session'));
    const att = m.a.length ? m.a.map((a) => `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0">
        <span class="k">B${a.dpos || '?'}${a.dth ? ' · HDV ' + a.dth : ''}</span>${etoilesHtml(a.e)}<span class="doux">${nombre(a.p, 0)} %${a.ne ? ` · +${a.ne}★` : ''}</span>
        ${peut ? `<select class="select-compo" data-guerre="${esc(g.id)}" data-tag="${esc(m.t)}" data-ordre="${a.o}" aria-label="Compo de l’attaque">${opt(a.c)}</select><button type="button" class="btn petit sombre carre" data-lien data-guerre="${esc(g.id)}" data-tag="${esc(m.t)}" data-ordre="${a.o}" aria-label="Lien d’armée">${ico('lien')}</button>` : a.c ? `<span class="k or">${esc(a.c)}</span>` : ''}</div>${armeeHtml(a.armee)}`).join('')
      : `<span class="k rouge">Aucune attaque</span>`;
    const rate = g.etat === 'warEnded' && m.a.length < g.apm;
    return `<tr><td class="num">${m.pos || ''}</td><td><b class="chiffre-jeu" style="font-size:15px">${esc(m.n)}</b><br><small>HDV ${m.th || '?'}${rate ? ' · <span style="color:var(--rouge)">' + (g.apm - m.a.length) + ' ratée(s)</span>' : ''}</small></td><td>${att}</td></tr>`;
  }).join('');
  const lib = g.etat !== 'warEnded' ? 'En cours' : RESULTATS[g.res];
  ui.modale({
    titre: `${g.clan.n} vs ${g.adv.n}`, icone: 'epees',
    corps: `<div class="duel"><div><div class="nom">${esc(g.clan.n)}</div><div class="gros">${g.clan.e} ★</div><small>${nombre(g.clan.p)} %</small></div><div class="vs">VS</div><div class="droite"><div class="nom">${esc(g.adv.n)}</div><div class="gros">${g.adv.e} ★</div><small>${nombre(g.adv.p)} %</small></div></div>
      ${g.manuelle && estChef ? `<button type="button" class="btn petit rouge" data-supprimer-guerre="${esc(g.id)}">${ico('poubelle')}Supprimer cette saisie</button>` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap">${g.manuelle ? '<span class="k cyan">Saisie manuelle</span>' : ''}<span class="k ${({ victoire: 'vert', defaite: 'rouge', egalite: 'or' })[g.res] || 'cyan'}">${lib}</span><span class="k">${g.taille} vs ${g.taille}</span><span class="k">${g.type === 'l' ? 'Ligue · 1 attaque' : g.apm + ' attaques / joueur'}</span>${d.mvp ? `<span class="k or">MVP ${esc(d.mvp.nom)}</span>` : ''}</div>
      <div class="defile"><table class="tableau"><thead><tr><th class="num">#</th><th>Joueur</th><th>Attaques</th></tr></thead><tbody>${lignes}</tbody></table></div>
      <small>« +n★ » = nouvelles étoiles apportées au clan. La compo n’est pas fournie par Clash : le joueur (identifié) ou le chef la renseigne.</small>`,
    avant: (m) => {
      m.querySelector('.boite').classList.add('large');
      m.addEventListener('click', async (e) => {
        const sup = e.target.closest('[data-supprimer-guerre]');
        if (sup && await ui.confirmer('Supprimer cette guerre saisie à la main ? Son score reste dans l’historique.', { ok: 'Supprimer', danger: true })) {
          try { await api('/api/guerres/' + encodeURIComponent(sup.dataset.supprimerGuerre), { method: 'DELETE', chef: true }); m.remove(); ui.toast('Saisie supprimée.', 'ok'); charger(); } catch (err) { ui.toast(err.message, 'err'); }
          return;
        }
        const b = e.target.closest('[data-lien]');
        if (b && await saisirLienArmee(b.dataset.guerre, b.dataset.tag, Number(b.dataset.ordre))) { m.remove(); ouvrirGuerre(b.dataset.guerre); }
      });
      m.addEventListener('change', async (e) => {
        const s = e.target.closest('.select-compo');
        if (!s) return;
        try {
          await api(`/api/guerres/${encodeURIComponent(s.dataset.guerre)}/compo`, { method: 'PUT', body: { tag: s.dataset.tag, ordre: Number(s.dataset.ordre), compo: s.value || null }, chef: estChef });
          ui.toast('Compo enregistrée.', 'ok');
        } catch (err) { ui.toast(err.message, 'err'); }
      });
    },
  });
}

// ---------- Compos
function rendreCompos() {
  const c = S.clan.compos;
  $('compos').innerHTML = !c.length
    ? `<p class="doux">${ico('info')} Aucune compo renseignée pour l’instant. Ouvre une guerre dans <b>Historique</b> et indique la compo de tes attaques : ce tableau montrera celles qui marchent le mieux dans le clan.</p>`
    : `<div class="defile"><table class="tableau"><thead><tr><th>Compo</th><th class="num">Utilisée</th><th class="num">3★</th><th class="num">★ moy.</th></tr></thead><tbody>
      ${c.map((x, i) => `<tr><td>${i === 0 ? ico('trophee') + ' ' : ''}<b>${esc(x.compo)}</b><div class="jauge"><i style="width:${x.tauxTriple}%"></i></div></td><td class="num">${x.n}</td><td class="num" style="color:var(--or-clair)">${nombre(x.tauxTriple)} %</td><td class="num">${nombre(x.moyEtoiles, 2)}</td></tr>`).join('')}
      </tbody></table></div>`;
}

// ---------- Raids du Capital
const kpi = (lib, val, cls = '') => `<div class="kpi"><small>${lib}</small><b class="${cls}">${val}</b></div>`;
async function rendreRaids() {
  const z = $('vueRaids');
  let d;
  try { d = await api('/api/raids'); } catch (e) { z.innerHTML = `<div class="err">${ico('alerte')}<span>${esc(e.message)}</span></div>`; return; }
  const s = d.saisons[0];
  if (!s) { z.innerHTML = `<div class="panneau creux"><p class="doux">${ico('info')} Aucun week-end de raid trouvé.</p></div>`; return; }
  const membres = s.membres.map((m, i) => `<li class="r"><span class="rang-num">${i + 1}</span><div class="info"><b>${esc(m.nom)}</b><small>${m.attaques}/${m.limite} attaques${m.attaques < m.limite && s.etat === 'termine' ? ' · <span style="color:var(--rouge)">' + (m.limite - m.attaques) + ' non jouée(s)</span>' : ''}</small></div><span class="note-badge">${nombre(m.butin, 0)}</span></li>`).join('');
  const bilan = d.bilan.joueurs.map((j) => `<tr><td class="num">${j.rang}</td><td><b>${esc(j.nom)}</b>${j.absences ? ` <span class="k rouge">${j.absences} absent</span>` : ''}</td><td class="num">${nombre(j.butinMoyen, 0)}</td><td class="num">${nombre(j.participation)} %</td></tr>`).join('');
  z.innerHTML = `<div class="panneau"><div class="entete-panneau">${ico('capital')}<h2>${s.etat === 'en_cours' ? 'Raid en cours' : 'Dernier week-end'}</h2><span class="k ${s.etat === 'en_cours' ? 'cyan' : 'gris'} droite">${fmtJour(s.debut)} → ${fmtJour(s.fin)}</span></div>
      <div class="kpis">${kpi('Butin du clan', nombre(s.butin, 0), 'or')}${kpi('Raids terminés', s.raids)}${kpi('Attaques', s.attaques, 'cyan')}${kpi('Quartiers détruits', s.quartiers)}</div>
      <ul class="liste" style="margin-top:12px">${membres || '<li class="vide-liste">Personne n’a encore attaqué.</li>'}</ul></div>
    <div class="panneau creux" style="margin-top:14px"><div class="entete-panneau">${ico('medaille')}<h2>Bilan sur ${d.bilan.weekends} week-ends</h2></div>
      ${bilan ? `<div class="defile"><table class="tableau"><thead><tr><th class="num">#</th><th>Joueur</th><th class="num">Butin moy.</th><th class="num">Attaques</th></tr></thead><tbody>${bilan}</tbody></table></div>` : '<p class="doux">Pas encore de week-end terminé.</p>'}
      <small>« Attaques » = attaques jouées sur les attaques disponibles. Un membre absent d’un week-end compte 0 sur 6.</small></div>`;
}

// ---------- Activité (chef)
const EVTS = { arrivee: ['➕', 'a rejoint le clan'], depart: ['➖', 'a quitté le clan'], retour: ['↩️', 'est revenu'], role: ['⬆️', 'a changé de rôle'] };
async function rendreActivite() {
  const z = $('vueActivite');
  if (!estChef) { z.innerHTML = `<div class="panneau creux"><p class="doux">${ico('cadenas')} Le suivi d’activité (inactifs, dons, Jeux de clan) est réservé au chef : active le mode chef pour le voir.</p></div>`; return; }
  let d;
  try { d = await api('/api/activite', { chef: true }); } catch (e) { z.innerHTML = `<div class="err">${ico('alerte')}<span>${esc(e.message)}</span></div>`; return; }
  const inactifs = d.joueurs.filter((j) => j.joursInactif >= 3).length;
  const lignes = d.joueurs.map((j) => `<tr><td><a href="/joueur.html?tag=${encodeURIComponent(j.tag)}" style="color:inherit;text-decoration:none"><b>${esc(j.nom)}</b></a><br><small>${esc(ROLES_FR[j.role] || '')}</small></td>
    <td class="num" style="color:${j.joursInactif >= 7 ? 'var(--rouge)' : j.joursInactif >= 3 ? 'var(--or-clair)' : 'var(--vert)'}">${j.joursInactif ? j.joursInactif + ' j' : 'auj.'}</td>
    <td class="num">${nombre(j.dons, 0)}<br><small>${nombre(j.recus, 0)} reçus</small></td><td class="num">${nombre(j.jeuxMois, 0)}</td><td class="num">${j.etoilesMois}</td></tr>`).join('');
  const evts = d.evenements.slice(0, 12).map((e) => `<li class="r"><span style="font-size:20px">${(EVTS[e.type] || ['•'])[0]}</span><div class="info"><b>${esc(e.nom)}</b><small>${(EVTS[e.type] || ['', e.type])[1]}${e.type === 'role' ? ` : ${esc(ROLES_FR[e.de] || e.de)} → ${esc(ROLES_FR[e.a] || e.a)}` : ''} · ${esc(ilYa(e.le))}</small></div></li>`).join('');
  z.innerHTML = `<div class="panneau"><div class="entete-panneau">${ico('pouls')}<h2>Activité des membres</h2></div>
      <div class="kpis">${kpi('Membres suivis', d.joueurs.length, 'cyan')}${kpi('Inactifs 3 j et +', inactifs, inactifs ? 'rouge' : 'vert')}</div>
      <div class="defile" style="margin-top:12px"><table class="tableau"><thead><tr><th>Joueur</th><th class="num">Dernière activité</th><th class="num">Dons</th><th class="num">Jeux (mois)</th><th class="num">★ guerre (mois)</th></tr></thead><tbody>${lignes}</tbody></table></div>
      <small>L’API ne donne pas la dernière connexion : un joueur est « actif » le dernier jour où ses dons, trophées, attaques, étoiles de guerre ou points des Jeux de clan ont bougé. Les chiffres du mois se remplissent à partir du début du suivi${d.dernierProfil ? ' (profils relevés ' + esc(ilYa(d.dernierProfil)) + ')' : ''}.</small></div>
    <div class="panneau creux" style="margin-top:14px"><div class="entete-panneau">${ico('membres')}<h2>Arrivées et départs</h2></div>
      <ul class="liste">${evts || '<li class="vide-liste">Rien de neuf depuis le début du suivi.</li>'}</ul></div>`;
}

// ---------- Ligue de guerre
async function rendreLdc() {
  const z = $('vueLdc');
  let d;
  try { d = await api('/api/ldc'); } catch (e) { z.innerHTML = `<div class="err">${ico('alerte')}<span>${esc(e.message)}</span></div>`; return; }
  if (!d.classement) { z.innerHTML = `<div class="panneau creux"><p class="doux">${ico('info')} ${esc(d.raison || 'Pas de ligue de guerre en cours.')} La ligue a lieu en début de mois ; ses guerres apparaissent aussi dans l’historique.</p></div>`; return; }
  const cl = d.classement.map((c) => `<tr${c.tag === (CLAN && CLAN.tag) ? ' style="background:rgba(245,184,46,.1)"' : ''}><td class="num">${c.rang}</td><td><b>${esc(c.nom)}</b><br><small>niv. ${c.niveau} · ${c.victoires} V / ${c.defaites} D</small></td><td class="num" style="color:var(--or-clair)">${c.etoiles}</td><td class="num">${nombre(c.destruction, 0)} %</td></tr>`).join('');
  const cal = d.calendrier.map((j) => j.eux
    ? `<li class="carte-guerre ${j.etat === 'warEnded' ? (j.nous.e > j.eux.e || (j.nous.e === j.eux.e && j.nous.p > j.eux.p) ? 'victoire' : j.nous.e === j.eux.e && j.nous.p === j.eux.p ? 'egalite' : 'defaite') : 'encours'}"><span class="rang-num">J${j.journee}</span><div style="min-width:0"><div class="adv">${esc(j.eux.n)}</div><small>${j.etat === 'preparation' ? 'Préparation' : j.etat === 'inWar' ? 'En cours' : 'Terminée'}</small></div><div class="score"><span class="nous">${j.nous.e}</span> <span class="doux">–</span> <span class="eux">${j.eux.e}</span></div></li>`
    : `<li class="carte-guerre"><span class="rang-num">J${j.journee}</span><div class="adv doux">À venir</div><span></span></li>`).join('');
  z.innerHTML = `<div class="panneau"><div class="entete-panneau">${ico('trophee')}<h2>Classement du groupe</h2><span class="k droite">${esc(d.saison || '')}</span></div>
      <div class="defile"><table class="tableau"><thead><tr><th class="num">#</th><th>Clan</th><th class="num">★</th><th class="num">Destr. cumulée</th></tr></thead><tbody>${cl}</tbody></table></div>
      <small>Étoiles + 10 par victoire, départage à la destruction cumulée.</small></div>
    <div class="panneau creux" style="margin-top:14px"><div class="entete-panneau">${ico('calendrier')}<h2>Nos journées</h2></div><ul class="liste">${cal}</ul></div>`;
}

// ---------- Joueurs × guerres : qui a attaqué, combien d'étoiles
async function rendreGrille() {
  const z = $('vueJoueurs');
  let d;
  try { d = await api(`/api/grille?derniers=${derniers === '0' ? 40 : derniers}&type=${type}`); } catch (e) { z.innerHTML = `<div class="err">${ico('alerte')}<span>${esc(e.message)}</span></div>`; return; }
  if (!d.guerres.length) {
    z.innerHTML = `<div class="panneau creux"><p class="doux">${ico('info')} Aucune guerre détaillée pour l’instant. Les prochaines guerres s’enregistrent toutes seules ; pour les anciennes, le chef peut saisir le détail dans <b>Historique</b>.</p></div>`;
    return;
  }
  const cellule = (c, g) => {
    if (!c) return '<td class="vide-c" title="Pas dans cette guerre">·</td>';
    const att = c.a.map((a) => `<span class="att e${a.e}" title="Base ${a.b} · ${a.p} %">${a.e}★<i>B${a.b}</i></span>`).join('');
    const rates = '<span class="att rate" title="Attaque non faite">✗</span>'.repeat(c.rate);
    const attente = c.enCours ? '<span class="att attente" title="Pas encore attaqué">…</span>'.repeat(Math.max(0, g.apm - c.a.length)) : '';
    return `<td><div class="cell">${att}${rates}${attente}</div></td>`;
  };
  const tete = d.guerres.map((g) => `<th class="col-g"><small>${fmtJour(g.fin || g.debut)}</small><b>${esc(g.adv)}</b><span class="k ${g.enCours ? 'cyan' : ({ victoire: 'vert', defaite: 'rouge', egalite: 'or' })[g.res] || 'gris'}">${g.enCours ? 'En cours' : g.nous + '–' + g.eux}</span></th>`).join('');
  const lignes = d.joueurs.map((j) => {
    const t = j.totaux;
    return `<tr><th class="fixe" scope="row"><a href="/joueur.html?tag=${encodeURIComponent(j.tag)}">${esc(j.nom)}</a>${j.membre === false ? '<small>parti</small>' : ''}</th>${d.guerres.map((g) => cellule(j.cellules[g.id], g)).join('')}
      <td class="tot"><b>${t.attaques}/${t.possibles}</b><small>${t.etoiles}★${t.manquees ? ` · <span style="color:var(--rouge)">${t.manquees}✗</span>` : ''}</small></td></tr>`;
  }).join('');
  z.innerHTML = `<div class="panneau creux"><div class="entete-panneau">${ico('membres')}<h2>Qui a attaqué ?</h2></div>
    <p class="doux" style="margin:0 0 10px"><span class="att e3">3★<i>B4</i></span> étoiles et base visée · <span class="att rate">✗</span> attaque non faite · <span class="att attente">…</span> pas encore attaqué · <b>·</b> pas dans la guerre</p>
    <div class="defile grille-zone"><table class="grille"><thead><tr><th class="fixe">Joueur</th>${tete}<th class="tot">Total</th></tr></thead><tbody>${lignes}</tbody></table></div></div>`;
}

// ---------- Saisie d'une guerre passée (chef)
function editeurGuerre(g) {
  if (!CLAN || !CLAN.members) return ui.toast('Liste du clan indisponible : réessaie dans un moment.', 'err');
  const taille0 = g ? g.taille : 15, apm0 = g ? g.apm : 2;
  const membres = [...CLAN.members].sort((a, b) => (a.rang || 99) - (b.rang || 99));
  const finLocale = g && g.fin ? new Date(g.fin) : new Date();
  const z = (n) => String(n).padStart(2, '0');
  const finInput = `${finLocale.getFullYear()}-${z(finLocale.getMonth() + 1)}-${z(finLocale.getDate())}T${z(finLocale.getHours())}:${z(finLocale.getMinutes())}`;
  const opts = (n, sel) => Array.from({ length: n }, (_, i) => `<option value="${i + 1}"${sel === i + 1 ? ' selected' : ''}>${i + 1}</option>`).join('');
  const ligneMembre = (m, i) => `<div class="saisie-j" data-tag="${esc(m.tag)}" data-nom="${esc(m.name)}" data-th="${m.th || ''}">
      <label class="saisie-nom"><input type="checkbox" class="participe" ${i < taille0 ? 'checked' : ''}> <b>${esc(m.name)}</b> <small>HDV ${m.th || '?'}</small></label>
      <div class="saisie-att">${Array.from({ length: 2 }, (_, k) => `<div class="att-ligne" data-k="${k}"${k >= apm0 ? ' hidden' : ''}>
        <select class="base" aria-label="Base visée, attaque ${k + 1}"><option value="">Pas d’attaque</option>${opts(50)}</select>
        <select class="etoiles" aria-label="Étoiles"><option value="0">0★</option><option value="1">1★</option><option value="2">2★</option><option value="3">3★</option></select>
        <input class="pct" type="number" min="0" max="100" step="1" placeholder="%" aria-label="Destruction %"></div>`).join('')}</div></div>`;
  const corps = `<div class="form-grille">
    ${g ? `<p class="doux">Guerre du journal officiel : <b>${esc(g.adv.n)}</b>, ${g.clan.e} ★ à ${g.adv.e} ★. Indique qui a attaqué quelle base et le résultat.</p>` : ''}
    <div class="kpis">
      <label class="champ"><span>Fin de la guerre</span><input id="gFin" type="datetime-local" value="${finInput}" ${g ? 'readonly' : ''}></label>
      <label class="champ"><span>Adversaire</span><input id="gAdv" maxlength="40" value="${esc(g ? g.adv.n : '')}"></label>
      <label class="champ"><span>Taille</span><select id="gTaille">${[5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((n) => `<option${n === taille0 ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="champ"><span>Attaques / joueur</span><select id="gApm"><option value="2"${apm0 === 2 ? ' selected' : ''}>2</option><option value="1"${apm0 === 1 ? ' selected' : ''}>1</option></select></label>
      <label class="champ"><span>Nos ★</span><input id="gNousE" type="number" min="0" value="${g ? g.clan.e : ''}"></label>
      <label class="champ"><span>Nos %</span><input id="gNousP" type="number" min="0" max="100" step="0.1" value="${g ? g.clan.p : ''}"></label>
      <label class="champ"><span>Leurs ★</span><input id="gEuxE" type="number" min="0" value="${g ? g.adv.e : ''}"></label>
      <label class="champ"><span>Leurs %</span><input id="gEuxP" type="number" min="0" max="100" step="0.1" value="${g ? g.adv.p : ''}"></label>
    </div>
    <h3>Participants et attaques <small id="gCompte"></small></h3>
    <div class="saisie">${membres.map(ligneMembre).join('')}</div>
    <small>Coche les joueurs qui étaient dans la guerre. Un joueur coché sans attaque compte comme « attaque non faite ».</small>
    <div id="gErr"></div></div>`;
  const valider = async (m) => {
    const q = (s2) => m.querySelector(s2);
    const err = (t) => { q('#gErr').innerHTML = `<div class="err" role="alert">${ico('alerte')}<span>${esc(t)}</span></div>`; q('#gErr').scrollIntoView({ block: 'center' }); return false; };
    const apm = Number(q('#gApm').value), taille = Number(q('#gTaille').value);
    const participants = [], attaques = [];
    for (const l of m.querySelectorAll('.saisie-j')) {
      if (!l.querySelector('.participe').checked) continue;
      participants.push({ tag: l.dataset.tag, nom: l.dataset.nom, th: Number(l.dataset.th) || null });
      for (const a of l.querySelectorAll('.att-ligne')) {
        if (Number(a.dataset.k) >= apm || !a.querySelector('.base').value) continue;
        const cible = Number(a.querySelector('.base').value);
        if (cible > taille) return err(`${l.dataset.nom} : base ${cible} au-delà de la taille de guerre (${taille}).`);
        attaques.push({ tag: l.dataset.tag, cible, e: Number(a.querySelector('.etoiles').value), p: Number(a.querySelector('.pct').value || 0) });
      }
    }
    if (!participants.length) return err('Coche au moins un participant.');
    if (participants.length > taille) return err(`${participants.length} participants cochés pour une guerre à ${taille}.`);
    try {
      await api('/api/guerres/manuelle', { method: 'POST', chef: true, body: { fin: new Date(q('#gFin').value).toISOString(), adv: q('#gAdv').value, taille, apm,
        nous: { e: q('#gNousE').value, p: q('#gNousP').value }, eux: { e: q('#gEuxE').value, p: q('#gEuxP').value }, participants, attaques } });
    } catch (e) { return err(e.message); }
    ui.toast('Guerre enregistrée : elle compte dans les stats.', 'ok'); charger();
    return true;
  };
  ui.modale({ titre: g ? 'Détail de la guerre' : 'Ajouter une guerre passée', icone: 'crayon', corps,
    actions: [{ texte: 'Annuler', valeur: false, classe: 'sombre' }, { texte: 'Enregistrer', valeur: true, classe: 'on', valider }],
    avant: (m) => {
      m.querySelector('.boite').classList.add('large');
      const maj = () => {
        const apm = Number(m.querySelector('#gApm').value), taille = Number(m.querySelector('#gTaille').value);
        m.querySelectorAll('.att-ligne').forEach((a) => { a.hidden = Number(a.dataset.k) >= apm; });
        const n = m.querySelectorAll('.participe:checked').length;
        m.querySelector('#gCompte').textContent = `(${n}/${taille} cochés)`;
        m.querySelector('#gCompte').style.color = n > taille ? 'var(--rouge)' : '';
      };
      m.addEventListener('change', maj); maj();
    },
  });
}

charger();
