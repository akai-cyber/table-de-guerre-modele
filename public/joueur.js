/* Fiche d'un joueur : profil Clash (héros, engins de siège, familiers), statistiques de guerre et attaques. */
initChef();
chargerClan();

const TAG = new URLSearchParams(location.search).get('tag') || '';
let J = null;

async function charger() {
  try { J = await api('/api/joueurs/' + encodeURIComponent(TAG)); $('erreur').hidden = true; }
  catch (e) {
    $('erreur').hidden = false;
    $('erreur').innerHTML = `<div class="err" role="alert">${ico('alerte')}<span>${esc(e.message)}</span></div>`;
    $('carteJoueur').hidden = true;
    return;
  }
  rendre();
}
socket.on('guerres', charger);

function rendre() {
  const p = J.profil, s = J.stats;
  document.title = `${p ? p.nom : TAG} · Table de guerre`;
  // --- Carte d'identité
  const pref = p && p.preferenceGuerre ? `<span class="k ${p.preferenceGuerre === 'in' ? 'vert' : 'rouge'}">${p.preferenceGuerre === 'in' ? 'Inscrit en guerre' : 'Pas en guerre'}</span>` : '';
  $('carteJoueur').hidden = false;
  $('carteJoueur').innerHTML = `
    <div style="display:flex;gap:12px;align-items:center">${hexa(p && p.niveau)}${bouclier(p ? p.th : s && s.th)}
      <div class="info"><h1 style="font-size:26px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p ? p.nom : s.nom)}</h1>
        <small>${esc(TAG)}${p && p.role ? ' · ' + ROLES_FR[p.role] : ''}${p && p.ligue ? ' · ' + esc(p.ligue) : ''}</small></div>
      ${s ? `<div style="text-align:center"><span class="note-badge ${s.rang <= 3 ? 'top' : ''}" style="font-size:26px;display:block">${nombre(s.note, 0)}</span><small>Rang #${s.rang}</small></div>` : ''}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${pref}${p ? `<span class="k or">${ico('etoile')} ${nombre(p.etoilesGuerre, 0)} étoiles de guerre</span><span class="k">${ico('trophee')} ${nombre(p.trophees, 0)}</span>` : ''}${p && p.armeHdv ? `<span class="k">Arme HDV ${p.armeHdv}</span>` : ''}</div>
    ${J.erreurProfil ? `<p class="doux">${ico('info')} Profil Clash indisponible : ${esc(J.erreurProfil)}</p>` : ''}`;

  // --- Performances en guerre
  const perfs = $('perfs');
  perfs.hidden = false;
  if (!s) {
    perfs.innerHTML = `<div class="entete-panneau">${ico('stats')}<h2>Performances en guerre</h2></div><p class="doux">Aucune attaque enregistrée pour ce joueur dans les guerres suivies par l’appli.</p>`;
  } else {
    const k = (lib, val, cls = '') => `<div class="kpi"><small>${lib}</small><b class="${cls}">${val}</b></div>`;
    const cote = (lib, c) => `<tr><td>${lib}</td><td class="num">${c.attaques}</td><td class="num" style="color:var(--or-clair)">${c.attaques ? nombre((100 * c.triples) / c.attaques) + ' %' : '—'}</td></tr>`;
    perfs.innerHTML = `<div class="entete-panneau">${ico('stats')}<h2>Performances en guerre</h2><span class="droite">${formeHtml(s.forme)}</span></div>
      <div class="kpis">
        ${k('Taux de 3★', `${nombre(s.tauxTriple)} %`, 'or')}${k('Étoiles / attaque', nombre(s.moyEtoiles, 2), 'cyan')}${k('Destruction moy.', `${nombre(s.moyPct)} %`)}${k('Nouvelles étoiles', s.nouvelles, 'vert')}
        ${k('Attaques', `${s.attaques} / ${s.possibles}`)}${k('Attaques ratées', s.manquees, s.manquees ? 'rouge' : 'vert')}${k('Guerres 2/2', s.tauxParfaites == null ? '—' : `${nombre(s.tauxParfaites)} %`, s.tauxParfaites === 100 ? 'vert' : '')}${k('Durée moy.', s.dureeMoy ? `${Math.floor(s.dureeMoy / 60)} min ${String(s.dureeMoy % 60).padStart(2, '0')}` : '—')}
      </div>
      <div class="defile" style="margin-top:12px"><table class="tableau"><thead><tr><th>Cible</th><th class="num">Attaques</th><th class="num">3★</th></tr></thead><tbody>
        ${cote('HDV plus haut', s.haut)}${cote('Même HDV', s.egal)}${cote('HDV plus bas', s.bas)}</tbody></table></div>
      <div class="kpis" style="margin-top:10px">${k('Défenses subies', s.defense.subies)}${k('Défenses tenues', s.defense.subies ? `${s.defense.tenues}/${s.defense.subies}` : '—', 'vert')}${k('★ concédées moy.', s.defense.moyConcedees == null ? '—' : nombre(s.defense.moyConcedees, 2))}${k('Compo favorite', s.compoFavorite ? esc(s.compoFavorite) : '—', 'or')}</div>`;
  }

  // --- Armée (héros, sièges, familiers)
  const armee = $('armee');
  armee.hidden = !p;
  if (p) {
    const pc = (n, m) => Math.round((100 * n) / Math.max(1, m));
    const heros = p.heros.map((h) => `<div class="hero"><span class="anneau" style="--p:${pc(h.niveau, h.max)}">${ico(ICONE_HEROS[h.nom] || 'couronne')}</span>
        <div style="min-width:0"><b>${esc(h.nomFr)}</b><small>Niveau ${h.niveau} / ${h.max}</small>${h.equipements.length ? `<small>${h.equipements.map((e) => `${esc(e.nom)} ${e.niveau}`).join(' · ')}</small>` : ''}</div></div>`).join('');
    const petits = (liste, icone) => liste.map((x) => `<div class="hero"><span class="anneau" style="--p:${pc(x.niveau, x.max)}">${ico(icone)}</span><div style="min-width:0"><b>${esc(x.nom)}</b><small>Niveau ${x.niveau} / ${x.max}</small></div></div>`).join('');
    const jauge = (lib, v) => `<div class="kpi"><small>${lib}</small><b>${v.auMax} / ${v.total}</b><div class="jauge"><i style="width:${pc(v.auMax, v.total)}%"></i></div></div>`;
    armee.innerHTML = `<div class="entete-panneau">${ico('couronne')}<h2>Héros</h2></div><div class="heros">${heros || '<p class="doux">Aucun héros.</p>'}</div>
      ${p.sieges.length ? `<div class="entete-panneau" style="margin-top:14px">${ico('dirigeable')}<h2>Engins de siège</h2></div><div class="heros">${petits(p.sieges, 'dirigeable')}</div>` : ''}
      ${p.familiers.length ? `<div class="entete-panneau" style="margin-top:14px">${ico('familier')}<h2>Familiers</h2></div><div class="heros">${petits(p.familiers, 'familier')}</div>` : ''}
      <div class="kpis" style="margin-top:14px">${jauge("Troupes au max", p.troupes)}${jauge("Sorts au max", p.sorts)}<div class="kpi"><small>Dons / reçus</small><b>${nombre(p.dons, 0)} / ${nombre(p.donsRecus, 0)}</b></div><div class="kpi"><small>Record trophées</small><b>${nombre(p.recordTrophees, 0)}</b></div></div>`;
  }

  // --- Attaques guerre par guerre
  const att = $('attaques');
  att.hidden = !J.guerres.length;
  const moi = store.get('cb_moi') === TAG && store.get('cb_session');
  const opt = (c) => `<option value="">Compo ?</option>${J.compos.map((x) => `<option${x === c ? ' selected' : ''}>${esc(x)}</option>`).join('')}`;
  att.innerHTML = `<div class="entete-panneau">${ico('epees')}<h2>Ses guerres</h2></div><ul class="liste">${J.guerres.map((g) => `
    <li class="carte-guerre ${g.finie ? g.res || '' : 'encours'}" style="grid-template-columns:minmax(0,1fr)">
      <div><div class="adv">vs ${esc(g.adv)}</div><small>${g.debut ? fmtJour(g.debut) : ''} · ${g.type === 'l' ? 'Ligue' : 'Guerre'} · position ${g.pos || '?'} · HDV ${g.th || '?'}${g.finie ? ' · ' + (RESULTATS[g.res] || '') : ' · en cours'}</small>
      ${g.a.length ? g.a.map((a) => `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px"><span class="k">B${a.dpos || '?'}${a.dth ? ' · HDV ' + a.dth : ''}</span>${etoilesHtml(a.e)}<span class="doux">${nombre(a.p, 0)} %${a.ne ? ` · +${a.ne}★` : ''}</span>
        ${moi || estChef ? `<select class="select-compo" data-guerre="${esc(g.guerre)}" data-ordre="${a.o}" aria-label="Compo">${opt(a.c)}</select>` : a.c ? `<span class="k or">${esc(a.c)}</span>` : ''}</div>`).join('')
        : `<div style="margin-top:6px"><span class="k rouge">${g.finie ? 'Aucune attaque' : 'Pas encore attaqué'}</span></div>`}
      ${g.finie && g.a.length < g.apm && g.a.length ? `<small style="color:var(--rouge)">${g.apm - g.a.length} attaque ratée</small>` : ''}</div></li>`).join('')}</ul>`;
}
$('attaques').addEventListener('change', async (e) => {
  const s = e.target.closest('.select-compo');
  if (!s) return;
  try {
    await api(`/api/guerres/${encodeURIComponent(s.dataset.guerre)}/compo`, { method: 'PUT', body: { tag: TAG, ordre: Number(s.dataset.ordre), compo: s.value || null }, chef: estChef });
    ui.toast('Compo enregistrée.', 'ok');
  } catch (err) { ui.toast(err.message, 'err'); }
});
document.addEventListener('chef', () => { if (J) rendre(); });
if (!/^#?[0289PYLQGRJCUV]{3,15}$/i.test(TAG)) { $('erreur').hidden = false; $('erreur').innerHTML = `<div class="err">${ico('alerte')}<span>Joueur invalide.</span></div>`; $('carteJoueur').hidden = true; }
else charger();
