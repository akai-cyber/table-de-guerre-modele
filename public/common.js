/* Code partagé par tous les écrans : affichage sûr, connexion temps réel, mode chef,
   en-tête du clan, fenêtres, notifications et appels au serveur. */
const $ = (id) => document.getElementById(id);
// Les noms de joueurs viennent de l'API : on les échappe toujours avant de les afficher.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* idem */ } },
};
const ico = (nom, cls = '') => `<svg class="ico ${cls}" aria-hidden="true"><use href="/icons.svg#i-${nom}"/></svg>`;
const DANS_APPLI = /TableDeGuerreApp/.test(navigator.userAgent);

// Dans l'appli Android (son navigateur intégré se signale par « TableDeGuerreApp »), on montre le bouton « changer de serveur ».
if (DANS_APPLI) { const srv = $('appServeur'); if (srv) srv.hidden = false; }

// Rend l'appli installable (uniquement en HTTPS ou sur localhost).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const socket = io();
let estChef = false;

// ---------- Dates et durées (affichées à l'heure de l'appareil)
const fmtJour = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
const fmtDate = (iso) => new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function duree(ms) {
  const min = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(min / 60), j = Math.floor(h / 24);
  if (j) return `${j} j ${h % 24} h`;
  if (h) return `${h} h ${String(min % 60).padStart(2, '0')}`;
  return `${min} min`;
}
function ilYa(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!(ms >= -60000)) return '';
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.floor(h / 24);
  return j < 7 ? `il y a ${j} j` : `le ${fmtJour(iso)}`;
}

// ---------- Notifications et fenêtres
const ui = {
  toast(texte, type = '') {
    let box = document.querySelector('.toasts');
    if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.innerHTML = (type === 'ok' ? ico('check') : type === 'err' ? ico('alerte') : ico('info')) + `<span>${esc(texte)}</span>`;
    box.appendChild(t);
    setTimeout(() => t.remove(), type === 'err' ? 5000 : 2800);
  },
  // Fenêtre générique. actions : [{ texte, valeur, classe, ico, valider }]. Renvoie la valeur choisie (null si fermée).
  modale({ titre, corps = '', actions = [], icone = 'info', avant } = {}) {
    return new Promise((fin) => {
      const m = document.createElement('div');
      m.className = 'modale';
      m.innerHTML = `<div class="boite" role="dialog" aria-modal="true" aria-labelledby="mt">
        <div class="boite-titre">${ico(icone)}<h2 id="mt">${esc(titre)}</h2><button type="button" class="btn carre petit sombre" data-valeur="" aria-label="Fermer">${ico('croix')}</button></div>
        <div class="boite-corps">${corps}</div>
        ${actions.length ? `<div class="boite-actions">${actions.map((a, i) => `<button type="button" class="btn ${a.classe || ''}" data-valeur="${i}">${a.ico ? ico(a.ico) : ''}${esc(a.texte)}</button>`).join('')}</div>` : ''}
      </div>`;
      const retour = document.activeElement;
      const fermer = (v) => { document.removeEventListener('keydown', clavier); m.remove(); if (retour && retour.focus) retour.focus(); fin(v); };
      const clavier = (e) => { if (e.key === 'Escape') fermer(null); };
      m.addEventListener('click', async (e) => {
        if (e.target === m) return fermer(null);
        const b = e.target.closest('[data-valeur]');
        if (!b || !m.contains(b) || b.closest('.boite-corps')) return;
        if (b.dataset.valeur === '') return fermer(null);
        const a = actions[Number(b.dataset.valeur)];
        if (a && a.valider) {
          b.classList.add('charge'); b.disabled = true;
          let ok;
          try { ok = await a.valider(m); } finally { b.classList.remove('charge'); b.disabled = false; }
          if (ok === false) return;
        }
        fermer(a ? a.valeur : null);
      });
      document.addEventListener('keydown', clavier);
      document.body.appendChild(m);
      if (avant) avant(m, fermer);
      const cible = m.querySelector('.boite-corps input,.boite-corps select,.boite-corps textarea') || m.querySelector('.boite-actions .btn:last-child') || m.querySelector('.btn');
      if (cible) cible.focus();
    });
  },
  confirmer(message, { ok = 'Confirmer', annuler = 'Annuler', danger = false, titre = 'Confirmation' } = {}) {
    return ui.modale({
      titre, icone: danger ? 'alerte' : 'info', corps: `<p class="question">${esc(message)}</p>`,
      actions: [{ texte: annuler, valeur: false, classe: 'sombre' }, { texte: ok, valeur: true, classe: danger ? 'rouge' : 'on' }],
    }).then((v) => v === true);
  },
};

// ---------- Appels au serveur (session membre et code chef envoyés en en-têtes, jamais dans l'adresse)
async function api(chemin, { method = 'GET', body, chef = false } = {}) {
  const h = { Accept: 'application/json' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const s = store.get('cb_session');
  if (s) h['X-Session'] = s;
  if (chef) h['X-Chef'] = store.get('cb_chef') || '';
  let r;
  try { r = await fetch(chemin, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); }
  catch (e) { throw Object.assign(new Error('Connexion au serveur impossible.'), { horsLigne: true }); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || `Erreur ${r.status}`), { status: r.status, donnees: d });
  return d;
}

// ---------- Visuels originaux : blason de secours et bouclier d'hôtel de ville (couleur selon le niveau)
const TEINTES_HDV = [[5, '#8A8F98'], [7, '#5B8C3A'], [9, '#B4452E'], [11, '#6E3FA8'], [13, '#2B7FC4'], [15, '#1F9A8C'], [17, '#C77A12'], [99, '#B32656']];
function bouclier(th) {
  const c = (TEINTES_HDV.find(([n]) => (th || 0) <= n) || TEINTES_HDV[0])[1];
  return `<span class="bouclier" title="Hôtel de ville ${th || '?'}"><svg viewBox="0 0 40 46" aria-hidden="true"><path d="M20 2l16 5v14c0 11-7 18.5-16 23C11 39.5 4 32 4 21V7z" fill="${c}" stroke="#051A30" stroke-width="3" stroke-linejoin="round"/><path d="M20 6.5l12 3.8V21c0 8.4-5 14.2-12 18-7-3.8-12-9.6-12-18V10.3z" fill="rgba(255,255,255,.18)"/></svg><i>${th || "?"}</i></span>`;
}
const hexa = (n) => `<span class="hexa${n ? '' : ' vide'}" title="Niveau d’expérience"><span>${n || '–'}</span></span>`;

// ---------- En-tête du clan (blason, nom, nombre de membres)
let CLAN = null;
async function chargerClan(majSous = true) {
  try {
    CLAN = await api('/api/clan');
    const b = $('blason');
    if (b && CLAN.badge) {
      const im = new Image();
      im.alt = ''; im.className = 'blason-img'; im.referrerPolicy = 'no-referrer';
      im.onload = () => { b.innerHTML = ''; b.appendChild(im); };
      im.src = CLAN.badge;
    }
    if ($('titreClan')) $('titreClan').textContent = CLAN.name;
    if (majSous && $('sous')) $('sous').textContent = `Membres : ${CLAN.count}/50`;
    document.dispatchEvent(new CustomEvent('clan', { detail: CLAN }));
  } catch (e) { /* l'en-tête garde le titre par défaut */ }
  return CLAN;
}
function infosClan() {
  if (!CLAN) return ui.toast('Informations du clan indisponibles pour le moment.', 'err');
  const c = CLAN;
  return ui.modale({
    titre: c.name, icone: 'info',
    corps: `<dl class="fiche">
      <dt>Tag</dt><dd>${esc(c.tag)}</dd>
      <dt>Niveau du clan</dt><dd>${c.level}</dd>
      <dt>Membres</dt><dd>${c.count}/50</dd>
      ${c.warLeague ? `<dt>Ligue de guerre</dt><dd>${esc(c.warLeague)}</dd>` : ''}
      <dt>Guerres gagnées</dt><dd>${c.warWins}</dd>
      <dt>Journal de guerre</dt><dd>${c.warLogPublic ? 'Public' : 'Privé'}</dd>
    </dl>${c.description ? `<p class="doux">${esc(c.description)}</p>` : ''}`,
  });
}

// ---------- Mode chef
function auth(code, fin) {
  socket.emit('auth', code, (res) => {
    estChef = Boolean(res && res.chef);
    if (fin) fin(res || {});
    document.dispatchEvent(new CustomEvent('chef'));
  });
}
// Reconnexion : on redonne le code mémorisé sur cet appareil (supprimé s'il n'est plus valable).
socket.on('connect', () => {
  const c = store.get('cb_chef');
  if (c) auth(c, (r) => { if (r.error === 'bad') store.del('cb_chef'); });
});

const MESSAGES_CHEF = {
  bad: 'Code incorrect.',
  blocked: 'Trop d’essais : réessaie dans 10 minutes.',
  off: 'Le mode chef n’est pas activé sur ce serveur (CHEF_CODE n’est pas renseigné).',
};

async function quitterChef() {
  if (await ui.confirmer('Quitter le mode chef sur cet appareil ?', { ok: 'Quitter', titre: 'Mode chef' })) { store.del('cb_chef'); location.reload(); }
}
function ouvrirChef() {
  const panel = $('chefPanel'), btn = $('chefBtn');
  panel.hidden = !panel.hidden;
  if (btn) btn.setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) $('chefCode').focus();
}
function initChef() {
  const btn = $('chefBtn'), panel = $('chefPanel'), msg = $('chefMsg');
  const peindre = () => {
    if (!btn) return;
    btn.classList.toggle('on', estChef);
    btn.innerHTML = `${ico('couronne')}<span>${estChef ? 'Chef ✓' : 'Chef'}</span>`;
  };
  if (btn) btn.addEventListener('click', () => (estChef ? quitterChef() : ouvrirChef()));
  $('chefForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('chefCode').value;
    auth(code, (res) => {
      if (res.chef) {
        store.set('cb_chef', code);
        panel.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
        msg.textContent = '';
        $('chefCode').value = '';
        ui.toast('Mode chef activé.', 'ok');
      } else {
        msg.textContent = MESSAGES_CHEF[res.error] || 'Code incorrect.';
      }
    });
  });
  document.addEventListener('chef', peindre);
  peindre();
  const bi = $('infosBtn');
  if (bi) bi.addEventListener('click', infosClan);
}

// ---------- Petits éléments partagés par les écrans de statistiques
const ROLES_FR = { leader: 'Chef', coLeader: 'Chef adjoint', admin: 'Aîné', member: 'Membre' };
const etoilesHtml = (n, max = 3) => `<span class="etoiles" aria-label="${n} étoile${n > 1 ? 's' : ''}">${'★'.repeat(n)}<span class="v">${'★'.repeat(Math.max(0, max - n))}</span></span>`;
const formeHtml = (f) => `<span class="forme" title="Dernières attaques (étoiles)">${(f || []).map((e) => `<i class="e${e}">${e}</i>`).join('')}</span>`;
const nombre = (v, d = 1) => (v == null ? '—' : Number(v).toLocaleString('fr-FR', { maximumFractionDigits: d }));
const RESULTATS = { victoire: 'Victoire', defaite: 'Défaite', egalite: 'Égalité' };
const ICONE_HEROS = { 'Barbarian King': 'roi', 'Archer Queen': 'reine', 'Grand Warden': 'gardien', 'Royal Champion': 'championne', 'Minion Prince': 'prince' };
