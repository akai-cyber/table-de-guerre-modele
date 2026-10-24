// Enregistrement durable de l'état de l'appli (cibles, périodes, réponses, sessions).
// Deux supports :
//  - un fichier JSON (par défaut) : simple, mais effacé à chaque redémarrage sur un hébergeur gratuit comme Render ;
//  - une base Upstash Redis (gratuite), si UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN sont renseignés :
//    les données survivent aux redémarrages et aux mises à jour.
const fs = require('fs');

function creerStockage({ fichier, upstashUrl, upstashToken, cle = 'table-de-guerre:etat', delai, journal = console } = {}) {
  const distant = Boolean(upstashUrl && upstashToken);
  if (delai === undefined) delai = 400;
  const base = distant ? String(upstashUrl).replace(/\/+$/, '') : '';
  const etat = { type: distant ? 'upstash' : 'fichier', ok: true, erreur: null, dernier: null };
  let minuterie = null, enCours = null, aEcrire = null;

  async function commande(args) {
    const r = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10000),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || b.error) throw new Error(b.error || `Upstash a répondu ${r.status}`);
    return b.result;
  }

  async function charger() {
    try {
      if (distant) {
        const v = await commande(['GET', cle]);
        return v ? JSON.parse(v) : null;
      }
      return JSON.parse(fs.readFileSync(fichier, 'utf8'));
    } catch (e) {
      if (!distant && e.code === 'ENOENT') return null; // premier lancement
      etat.ok = false; etat.erreur = e.message;
      journal.error('Lecture des données impossible :', e.message);
      return null;
    }
  }

  const reussi = () => { etat.ok = true; etat.erreur = null; etat.dernier = new Date().toISOString(); };
  const rate = (e) => { etat.ok = false; etat.erreur = e.message; journal.error('Enregistrement impossible :', e.message); };

  async function ecrire(texte) {
    try { await commande(['SET', cle, texte]); reussi(); } catch (e) { rate(e); }
  }

  // Fichier local : écriture immédiate (atomique). Base distante : les écritures rapprochées sont regroupées,
  // une seule à la fois.
  function enregistrer(objet) {
    if (!distant) {
      try {
        const tmp = fichier + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(objet));
        fs.renameSync(tmp, fichier); // jamais de fichier à moitié écrit
        reussi();
      } catch (e) { rate(e); }
      return;
    }
    aEcrire = JSON.stringify(objet);
    if (minuterie) return;
    minuterie = setTimeout(vider, delai);
  }
  async function vider() {
    if (minuterie) { clearTimeout(minuterie); minuterie = null; }
    if (enCours) await enCours;
    if (aEcrire === null) return;
    const texte = aEcrire; aEcrire = null;
    enCours = ecrire(texte);
    await enCours;
    enCours = null;
  }

  return { charger, enregistrer, vider, etat };
}

module.exports = { creerStockage };
