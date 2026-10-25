/* Chat de l'appli : messages des membres identifiés et annonces du chef (notifiées sur les téléphones). */
initChef();
chargerClan();

let messages = [];
const moiSession = () => Boolean(store.get('cb_session'));
const marquerVu = () => store.set('cb_chat_vu', new Date().toISOString());

function ligne(m) {
  const moi = m.auteur.tag && m.auteur.tag === store.get('cb_moi');
  return `<li class="msg${m.annonce ? ' annonce' : ''}${moi ? ' moi' : ''}" data-id="${esc(m.id)}">
    <div class="msg-tete">${m.annonce ? ico('megaphone') : ''}<b>${esc(m.auteur.nom)}</b>${m.auteur.chef ? '<span class="k or">Chef</span>' : ''}<small>${esc(ilYa(m.le))}</small>
      <span class="msg-actions"><button type="button" class="btn petit sombre carre" data-clash aria-label="Copier et ouvrir Clash">${ico('ouvrir')}</button>${estChef ? `<button type="button" class="btn petit sombre carre" data-suppr aria-label="Supprimer">${ico('poubelle')}</button>` : ''}</span></div>
    <p>${esc(m.texte).replace(/\n/g, '<br>')}</p></li>`;
}
function rendre(defiler) {
  const ol = $('fil');
  ol.innerHTML = messages.length ? messages.map(ligne).join('') : `<li class="vide-liste">${ico('message')}Aucun message pour l’instant. Lance la discussion !</li>`;
  if (defiler) window.scrollTo(0, document.body.scrollHeight);
  const peut = moiSession() || estChef;
  $('zoneSaisie').hidden = !peut; $('pasIdentifie').hidden = peut; $('choixAnnonce').hidden = !estChef;
}
async function charger() {
  try { messages = (await api('/api/chat')).messages; marquerVu(); rendre(true); }
  catch (e) { $('fil').innerHTML = `<li class="err" role="alert">${ico('alerte')}<span>${esc(e.message)}</span></li>`; }
}
socket.on('chat', (m) => { messages.push(m); if (messages.length > 100) messages.shift(); marquerVu(); rendre(true); });
socket.on('chat-suppr', (id) => { messages = messages.filter((m) => m.id !== id); rendre(false); });
document.addEventListener('chef', () => rendre(false));

const zone = $('texte');
zone.addEventListener('input', () => { zone.style.height = 'auto'; zone.style.height = Math.min(140, zone.scrollHeight) + 'px'; });
zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !/Android|iPhone/.test(navigator.userAgent)) { e.preventDefault(); envoyer(); } });
$('envoyer').onclick = envoyer;
async function envoyer() {
  const texte = zone.value.trim();
  if (!texte) return;
  const annonce = estChef && $('annonce').checked;
  if (annonce && !await ui.confirmer(`Envoyer cette annonce en notification à tous les membres abonnés et sur Discord ?`, { ok: 'Envoyer l’annonce', titre: 'Annonce' })) return;
  const b = $('envoyer'); b.classList.add('charge'); b.disabled = true;
  try {
    const r = await api('/api/chat', { method: 'POST', body: { texte, annonce }, chef: estChef });
    zone.value = ''; zone.style.height = ''; $('annonce').checked = false;
    if (annonce) ui.toast(`Annonce envoyée à ${r.envoyes} téléphone${r.envoyes > 1 ? 's' : ''}${r.discord ? ' et sur Discord' : ''}.`, 'ok');
  } catch (e) { ui.toast(e.message, 'err'); }
  finally { b.classList.remove('charge'); b.disabled = false; }
}
$('copierClash').onclick = () => { const t = zone.value.trim(); if (!t) return ui.toast('Écris d’abord le message à copier.'); copierEtOuvrirClash(t); };
$('ouvrirClash').onclick = (e) => { e.preventDefault(); copierEtOuvrirClash(zone.value.trim() || ''); };
$('fil').addEventListener('click', async (e) => {
  const li = e.target.closest('[data-id]'); if (!li) return;
  const m = messages.find((x) => x.id === li.dataset.id); if (!m) return;
  if (e.target.closest('[data-clash]')) copierEtOuvrirClash(m.texte);
  if (e.target.closest('[data-suppr]') && await ui.confirmer('Supprimer ce message pour tout le monde ?', { ok: 'Supprimer', danger: true })) {
    try { await api('/api/chat/' + m.id, { method: 'DELETE', chef: true }); } catch (err) { ui.toast(err.message, 'err'); }
  }
});
charger();
