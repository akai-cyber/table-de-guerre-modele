/* Écran « Stats » : bilan du clan, classement des joueurs, historique des guerres et compos.
   Les chiffres viennent des guerres enregistrées par le serveur (/api/stats, /api/guerres). */
initChef();
chargerClan();

let vue = store.get('cb_vue_stats') || 'classement';
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
        <div style="margin-top:5px;display:flex;gap:6px;flex-wrap:wrap"><span class="k ${kres}">${lib}</span>${g.details ? '<span class="k cyan">Détails</span>' : ''}</div></div>
      <div class="score"><span class="nous">${g.clan.e}</span> <span class="doux">–</span> <span class="eux">${g.adv.e}</span><small style="display:block;text-align:right">${nombre(g.clan.p)} %</small></div></li>`;
  }).join('');
}
$('historique').addEventListener('click', (e) => { const el = e.target.closest('[data-id]'); if (el) ouvrirGuerre(el.dataset.id); });
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
        ${peut ? `<select class="select-compo" data-guerre="${esc(g.id)}" data-tag="${esc(m.t)}" data-ordre="${a.o}" aria-label="Compo de l’attaque">${opt(a.c)}</select>` : a.c ? `<span class="k or">${esc(a.c)}</span>` : ''}</div>`).join('')
      : `<span class="k rouge">Aucune attaque</span>`;
    const rate = g.etat === 'warEnded' && m.a.length < g.apm;
    return `<tr><td class="num">${m.pos || ''}</td><td><b class="chiffre-jeu" style="font-size:15px">${esc(m.n)}</b><br><small>HDV ${m.th || '?'}${rate ? ' · <span style="color:var(--rouge)">' + (g.apm - m.a.length) + ' ratée(s)</span>' : ''}</small></td><td>${att}</td></tr>`;
  }).join('');
  const lib = g.etat !== 'warEnded' ? 'En cours' : RESULTATS[g.res];
  ui.modale({
    titre: `${g.clan.n} vs ${g.adv.n}`, icone: 'epees',
    corps: `<div class="duel"><div><div class="nom">${esc(g.clan.n)}</div><div class="gros">${g.clan.e} ★</div><small>${nombre(g.clan.p)} %</small></div><div class="vs">VS</div><div class="droite"><div class="nom">${esc(g.adv.n)}</div><div class="gros">${g.adv.e} ★</div><small>${nombre(g.adv.p)} %</small></div></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap"><span class="k ${({ victoire: 'vert', defaite: 'rouge', egalite: 'or' })[g.res] || 'cyan'}">${lib}</span><span class="k">${g.taille} vs ${g.taille}</span><span class="k">${g.type === 'l' ? 'Ligue · 1 attaque' : g.apm + ' attaques / joueur'}</span>${d.mvp ? `<span class="k or">MVP ${esc(d.mvp.nom)}</span>` : ''}</div>
      <div class="defile"><table class="tableau"><thead><tr><th class="num">#</th><th>Joueur</th><th>Attaques</th></tr></thead><tbody>${lignes}</tbody></table></div>
      <small>« +n★ » = nouvelles étoiles apportées au clan. La compo n’est pas fournie par Clash : le joueur (identifié) ou le chef la renseigne.</small>`,
    avant: (m) => {
      m.querySelector('.boite').classList.add('large');
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

charger();
