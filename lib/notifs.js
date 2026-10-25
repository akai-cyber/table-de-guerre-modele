// Notifications : détection des évènements (fonctions pures) et envoi (Web Push, Discord).
//
// Web Push : notifications du navigateur (Chrome Android, appli installée depuis Chrome). Clés VAPID créées une fois
// par le serveur et conservées avec les données. Discord : si DISCORD_WEBHOOK_URL est renseigné, les annonces et
// les grands évènements sont aussi publiés dans le salon choisi.
const HEURE = 3600e3;
const TYPES = ['guerre', 'rappels', 'resultats', 'dispos', 'raids', 'annonces'];

const parseDate = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s || '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : Date.parse(s);
};

// Guerre en cours (format brut de l'API) → évènements à notifier. « cle » sert à ne jamais envoyer deux fois.
function evenementsGuerre(w, maintenant = Date.now()) {
  if (!w || !w.clan || !w.opponent || !['preparation', 'inWar', 'warEnded'].includes(w.state)) return [];
  const id = w.preparationStartTime || w.startTime, adv = w.opponent.name, ev = [];
  const fin = parseDate(w.endTime), apm = w.attacksPerMember || 1;
  if (w.state === 'preparation') {
    ev.push({ cle: `prep:${id}`, type: 'guerre', titre: '⚔️ Préparation de guerre', corps: `Guerre contre ${adv} (${w.teamSize} vs ${w.teamSize}). Regarde ta cible dans l’appli.`, url: '/' });
  }
  if (w.state === 'inWar') {
    ev.push({ cle: `debut:${id}`, type: 'guerre', titre: '🔥 La guerre commence !', corps: `Jour de bataille contre ${adv}. ${apm} attaque${apm > 1 ? 's' : ''} par joueur.`, url: '/', discord: true });
    for (const h of [4, 1]) {
      if (fin - maintenant <= h * HEURE && fin > maintenant) {
        const restants = (w.clan.members || []).filter((m) => (m.attacks || []).length < apm);
        if (restants.length) {
          ev.push({ cle: `rappel${h}:${id}`, type: 'rappels', titre: `⏰ Plus que ${h} h de guerre`, cibles: restants.map((m) => m.tag),
            corps: 'Il te reste des attaques à faire contre ' + adv + ' !', url: '/', parTag: Object.fromEntries(restants.map((m) => [m.tag, apm - (m.attacks || []).length])) });
        }
      }
    }
  }
  if (w.state === 'warEnded') {
    const a = w.clan, b = w.opponent;
    const res = a.stars !== b.stars ? (a.stars > b.stars ? 'Victoire' : 'Défaite') : a.destructionPercentage !== b.destructionPercentage ? (a.destructionPercentage > b.destructionPercentage ? 'Victoire' : 'Défaite') : 'Égalité';
    ev.push({ cle: `fin:${id}`, type: 'resultats', titre: `${res === 'Victoire' ? '🏆' : res === 'Défaite' ? '💀' : '🤝'} ${res} contre ${adv}`,
      corps: `${a.stars} ★ à ${b.stars} ★ (${Math.round(a.destructionPercentage * 10) / 10} % contre ${Math.round(b.destructionPercentage * 10) / 10} %). Les stats sont à jour.`, url: '/stats.html', discord: true });
  }
  return ev;
}

// Périodes Signe / Non : ouverture, et rappel 24 h avant la fin à ceux qui n'ont pas répondu.
function evenementsDispos(p, statut, reponses, membres, maintenant = Date.now()) {
  if (!p || statut !== 'ouverte') return [];
  const ev = [{ cle: `periode:${p.id}`, type: 'dispos', titre: '📋 Signe / Non', corps: `${p.titre || 'Nouvelle période'} : indique tes disponibilités.`, url: '/dispos.html' }];
  const fin = Date.parse(p.fin);
  if (fin - maintenant <= 24 * HEURE) {
    const sans = (membres || []).filter((m) => !(reponses || {})[m.tag]).map((m) => m.tag);
    if (sans.length) ev.push({ cle: `periode-rappel:${p.id}`, type: 'dispos', titre: '📋 Signe / Non : dernier jour', corps: 'Tu n’as pas encore répondu.', cibles: sans, url: '/dispos.html' });
  }
  return ev;
}

// Week-end de raid en cours : début, et rappel 6 h avant la fin à ceux qui n'ont pas tout joué.
function evenementsRaids(s, membresActuels, maintenant = Date.now()) {
  if (!s || s.state !== 'ongoing') return [];
  const id = s.startTime, fin = parseDate(s.endTime), ev = [];
  ev.push({ cle: `raid:${id}`, type: 'raids', titre: '🏰 Week-end de raid', corps: 'Les raids du Capital sont ouverts : 5 attaques (+1 bonus) à faire !', url: '/stats.html' });
  if (fin - maintenant <= 6 * HEURE && fin > maintenant) {
    const joue = new Map((s.members || []).map((m) => [m.tag, (m.attacks || 0) >= (m.attackLimit || 5) + (m.bonusAttackLimit || 0)]));
    const cibles = (membresActuels || []).filter((m) => !joue.get(m.tag)).map((m) => m.tag);
    if (cibles.length) ev.push({ cle: `raid-rappel:${id}`, type: 'raids', titre: '🏰 Raids : fin dans moins de 6 h', corps: 'Il te reste des attaques de raid.', cibles, url: '/stats.html' });
  }
  return ev;
}

// Garde-fou : un évènement déjà envoyé (même clé) ne repart pas. Renvoie les nouveaux et met à jour le registre.
function filtrerNouveaux(evenements, registre, maintenant = Date.now()) {
  const nouveaux = evenements.filter((e) => !registre[e.cle]);
  for (const e of nouveaux) registre[e.cle] = new Date(maintenant).toISOString();
  const cles = Object.keys(registre);
  if (cles.length > 400) cles.sort((a, b) => Date.parse(registre[a]) - Date.parse(registre[b])).slice(0, cles.length - 400).forEach((k) => delete registre[k]);
  return nouveaux;
}

// Abonnements concernés : bon type d'évènement activé, et joueur ciblé s'il y a une liste de cibles.
function destinataires(abonnements, e) {
  return (abonnements || []).filter((a) => (a.prefs || {})[e.type] !== false && (!e.cibles || (a.tag && e.cibles.includes(a.tag))));
}

function creerEnvoyeur({ webpush, vapid, contact, discordUrl, journal = console, retirer }) {
  if (webpush && vapid) webpush.setVapidDetails(contact || 'mailto:table-de-guerre@example.invalid', vapid.publicKey, vapid.privateKey);
  async function pousser(abonnements, e) {
    if (!webpush || !vapid) return 0;
    let n = 0;
    await Promise.all(destinataires(abonnements, e).map(async (a) => {
      const corps = e.parTag && a.tag && e.parTag[a.tag] ? `Il te reste ${e.parTag[a.tag]} attaque${e.parTag[a.tag] > 1 ? 's' : ''} ! ${e.corps}` : e.corps;
      try {
        await webpush.sendNotification(a.sub, JSON.stringify({ titre: e.titre, corps, url: e.url || '/', tag: e.cle }), { TTL: 6 * 3600 });
        n++;
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) { if (retirer) retirer(a.id); } // abonnement expiré
        else journal.error('Notification non envoyée :', err && err.message);
      }
    }));
    return n;
  }
  async function discord(texte) {
    if (!discordUrl) return false;
    try {
      const r = await fetch(discordUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: String(texte).slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10000) });
      return r.ok;
    } catch (e) { journal.error('Discord indisponible :', e.message); return false; }
  }
  return { pousser, discord };
}

module.exports = { evenementsGuerre, evenementsDispos, evenementsRaids, filtrerNouveaux, destinataires, creerEnvoyeur, TYPES };
