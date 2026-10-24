/* Code partagé par les deux écrans : affichage sûr, connexion temps réel et mode chef. */
const $ = (id) => document.getElementById(id);
// Les noms de joueurs viennent de l'API : on les échappe toujours avant de les afficher.
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* idem */ } },
};

// Dans l'appli Android (son navigateur intégré se signale par « TableDeGuerreApp »), on montre le bouton « changer de serveur ».
if (/TableDeGuerreApp/.test(navigator.userAgent)) { const srv = $('appServeur'); if (srv) srv.hidden = false; }

// Rend l'appli installable (uniquement en HTTPS ou sur localhost).
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const socket = io();
let estChef = false;

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

function initChef() {
  const btn = $('chefBtn'), panel = $('chefPanel'), msg = $('chefMsg');
  const peindre = () => { btn.classList.toggle('on', estChef); btn.textContent = estChef ? 'Chef ✓' : 'Chef'; };
  btn.addEventListener('click', () => {
    if (estChef) {
      if (confirm('Quitter le mode chef sur cet appareil ?')) { store.del('cb_chef'); location.reload(); }
      return;
    }
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) $('chefCode').focus();
  });
  $('chefForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('chefCode').value;
    auth(code, (res) => {
      if (res.chef) {
        store.set('cb_chef', code);
        panel.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        msg.textContent = '';
        $('chefCode').value = '';
      } else {
        msg.textContent = MESSAGES_CHEF[res.error] || 'Code incorrect.';
      }
    });
  });
  document.addEventListener('chef', peindre);
  peindre();
}
