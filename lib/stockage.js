// Enregistrement durable de l'état de l'appli (cibles, périodes, réponses, guerres, activité, chat…).
// Deux supports :
//  - un fichier JSON (par défaut) : simple, mais effacé à chaque redémarrage sur un hébergeur gratuit comme Render ;
//  - une base Upstash Redis (gratuite), si UPSTASH_REDIS_REST_URL et UPSTASH_REDIS_REST_TOKEN sont renseignés :
//    les données survivent aux redémarrages et aux mises à jour.
// Sur Upstash, chaque rubrique (guerres, activité…) est une clé à part : seules les rubriques modifiées sont réécrites,
// et aucune requête ne devient trop grosse pour l'offre gratuite.
const fs = require('fs');

function creerStockage({ fichier, upstashUrl, upstashToken, cle = 'table-de-guerre:etat', delai, journal = console } = {}) {
  const distant = Boolean(upstashUrl && upstashToken);
  if (delai === undefined) delai = 400;
  const base = distant ? String(upstashUrl).replace(/\/+$/, '') : '';
  const etat = { type: distant ? 'upstash' : 'fichier', ok: true, erreur: null, dernier: null };
  let minuterie = null, enCours = null, aEcrire = null;
  const ecrits = new Map(); // rubrique → dernier texte écrit (pour n'envoyer que les changements)

  async function requete(chemin, corps) {
    const r = await fetch(base + chemin, {
      method: 'POST',
      headers: { Authorization: `Bearer ${upstashToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(15000),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok || b.error) throw new Error(b.error || `Upstash a répondu ${r.status}`);
    return b;
  }
  const commande = async (args) => (await requete('', args)).result;

  async function charger() {
    try {
      if (distant) {
        const index = await commande(['GET', cle + ':index']);
        if (index) {
          const noms = JSON.parse(index);
          const valeurs = noms.length ? await commande(['MGET', ...noms.map((n) => cle + ':' + n)]) : [];
          const objet = {};
          noms.forEach((n, i) => { if (valeurs[i] != null) { objet[n] = JSON.parse(valeurs[i]); ecrits.set(n, valeurs[i]); } });
          return objet;
        }
        const ancien = await commande(['GET', cle]); // ancienne version : tout dans une seule clé
        return ancien ? JSON.parse(ancien) : null;
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

  async function ecrire(objet) {
    const cmds = [], textes = new Map();
    for (const [n, v] of Object.entries(objet)) {
      const t = JSON.stringify(v === undefined ? null : v);
      if (ecrits.get(n) !== t) { cmds.push(['SET', cle + ':' + n, t]); textes.set(n, t); }
    }
    if (!cmds.length) return;
    cmds.push(['SET', cle + ':index', JSON.stringify(Object.keys(objet))]);
    try {
      const res = await requete('/pipeline', cmds);
      const erreur = Array.isArray(res) ? res.find((x) => x && x.error) : null;
      if (erreur) throw new Error(erreur.error);
      for (const [n, t] of textes) ecrits.set(n, t);
      reussi();
    } catch (e) { rate(e); }
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
    aEcrire = JSON.parse(JSON.stringify(objet)); // copie figée au moment de la demande
    if (minuterie) return;
    minuterie = setTimeout(vider, delai);
  }
  async function vider() {
    if (minuterie) { clearTimeout(minuterie); minuterie = null; }
    if (enCours) await enCours;
    if (aEcrire === null) return;
    const objet = aEcrire; aEcrire = null;
    enCours = ecrire(objet);
    await enCours;
    enCours = null;
  }

  return { charger, enregistrer, vider, etat };
}

module.exports = { creerStockage };
