# Table de guerre — version serveur (Render)

Appli web (et appli Android) pour un clan Clash of Clans :

- **Guerre** : guerre en cours en direct, cibles assignées par le chef, attaques restantes.
- **Tableau** : le chef dessine le plan d'attaque sur la capture d'une base, les joueurs le voient en direct.
- **Stats** : bilan du clan, classement des joueurs (note sur 100), historique des guerres, compos qui marchent ; fiche de chaque joueur (héros, engins de siège, familiers, attaques).
- **Dispos (Signe / Non)** : le chef ouvre une période, chaque membre dit s'il est disponible ; statistiques, filtres, historique.
- **Chat** : messages entre membres identifiés ; **annonces du chef** envoyées en notification à tous (et sur Discord).
- **Notifications** (Chrome / appli installée depuis Chrome) : préparation et début de guerre, rappels d'attaques 4 h et 1 h
  avant la fin (personnels), résultats, Signe / Non, raids du Capital, annonces.
- **Raids du Capital**, **activité** des membres (chef : inactifs, dons, Jeux de clan, arrivées/départs), **ligue de guerre**
  (classement du groupe), **repérage** de l'adversaire avec **proposition de cibles**, **lien d'armée** → compo automatique.
- **Menu** : profil, notifications, saison (Pass or), mode chef, informations du clan, état du serveur.

## Variables d'environnement (Render → Environment)

| Variable | Obligatoire | Rôle |
|---|---|---|
| `CLASH_API_TOKEN` | oui | Clé de developer.clashofclans.com (IP autorisée : `45.79.218.79`) |
| `CLASH_API_BASE` | oui sur Render | `https://cocproxy.royaleapi.dev/v1` (relais RoyaleAPI, IP fixe) |
| `CLAN_TAG` | oui | Tag du clan, ex. `#2CJURJQC0` |
| `CHEF_CODE` | oui | Code du mode chef (8 caractères ou plus) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **fortement conseillé** | Enregistrement durable (voir plus bas) |
| `IDENTITE` | non | `jeton` (défaut) ou `libre` |
| `DISCORD_WEBHOOK_URL` | non | Webhook d'un salon Discord : annonces, débuts/résultats de guerre, arrivées/départs |
| `VAPID_CONTACT` | non | Contact (mailto:) pour les notifications push |

## Enregistrement durable (important sur Render gratuit)

Sans Upstash, les données (cibles, périodes, réponses, identifications) sont dans un fichier local.
Sur Render gratuit, ce fichier est **effacé** à chaque mise en veille (15 min sans visite) et à chaque mise à jour.

Pour les garder, depuis un téléphone :
1. Crée un compte gratuit sur upstash.com (connexion Google possible).
2. **Create Database** → Redis, région Europe, offre Free.
3. Dans la base, section **REST API**, copie `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.
4. Ajoute ces deux variables dans Render → Environment, puis **Save, rebuild, and deploy**.
5. Menu → Serveur doit afficher « base Upstash (durable) ».

## Historique et statistiques

L'API Clash ne donne le détail des attaques que pour la guerre **en cours**. Le serveur enregistre donc la guerre
à chaque consultation et toutes les 5 minutes tant qu'il est réveillé (guerres classiques et ligue de guerre).
Les guerres plus anciennes viennent du journal officiel (score seulement, journal de guerre public requis).

**Relevé automatique** : le fichier `.github/workflows/releve.yml` (branche `main`) réveille le serveur toutes les
10 minutes (GitHub Actions, gratuit), puis sauvegarde l'historique des guerres dans la branche `donnees`
(`guerres.json`). Au démarrage, le serveur relit cette sauvegarde (adresse déduite de `RENDER_GIT_REPO_SLUG`,
ou variable `SAUVEGARDE_URL`) : les guerres ne sont pas perdues même sans Upstash.

**Guerres d'avant l'appli** : le chef peut saisir leur détail (Stats → Historique → « Saisir le détail ») ;
elles comptent ensuite dans le tableau « Joueurs » et dans les stats.

Note sur 100 : 40 pts triples (pondérés par l'écart d'HDV, ×0,7 à ×1,3), 25 pts étoiles moyennes, 20 pts attaques faites,
15 pts destruction moyenne. Égalités départagées par les nouvelles étoiles puis le taux de triples.

La compo utilisée n'est pas fournie par l'API : le joueur identifié (ou le chef) la choisit sur chaque attaque.

## Identité des membres (Signe / Non)

Par défaut, un membre prouve son identité avec le **jeton API du jeu**
(Clash of Clans → Paramètres → Plus de paramètres → Jeton API → Afficher).
Le serveur le vérifie auprès de Supercell (`POST /players/{tag}/verifytoken`), puis garde une session
sur le téléphone (180 jours). Si la vérification ne passe pas par le relais, mettre `IDENTITE=libre` :
chacun choisit alors son nom, sans vérification.

Le chef (code chef) peut saisir ou corriger la réponse d'un membre : c'est affiché « saisi par le chef ».

## API (JSON)

- `GET /api/dispos[?periode=id]` : période, membres, réponses, statistiques (en-tête `X-Session` facultatif)
- `POST /api/moi` `{tag, jeton}` / `DELETE /api/moi` : identification d'un membre
- `PUT /api/dispos/periodes/:id/ma-reponse` `{r: "oui"|"non"|null}` : sa propre réponse (période ouverte)
- Chef (en-tête `X-Chef`) : `POST /api/dispos/periodes`, `PATCH /api/dispos/periodes/:id`,
  `POST /api/dispos/periodes/:id/cloture`, `DELETE /api/dispos/periodes/:id`,
  `PUT /api/dispos/periodes/:id/reponses/:tag`, `GET /api/dispos/periodes/:id/export.csv`

- `GET /api/raids`, `GET /api/activite` (chef), `GET /api/ldc`, `GET /api/reperage`, `GET /api/saison`, `POST /api/armee` `{lien}`
- `GET|POST /api/chat`, `DELETE /api/chat/:id` (chef), `GET /api/notifs`, `POST|PATCH|DELETE /api/notifs/abonnement`, `POST /api/notifs/test`
- `GET /api/guerres`, `GET /api/guerres/:id`, `GET /api/stats?derniers=&type=c|l`, `GET /api/joueurs/:tag`,
  `PUT /api/guerres/:id/compo` `{tag, ordre, compo}` (joueur lui-même ou chef)

## Pourquoi pas d'envoi direct dans le chat du jeu ?

L'API officielle ne permet pas d'écrire dans le chat de clan. Le seul moyen serait un robot qui pilote un compte,
interdit par les conditions de Supercell (risque de bannissement) : l'appli ne le fait pas. À la place :
annonces en notification + Discord, et bouton « Copier et ouvrir Clash » (le message est copié, le jeu s'ouvre sur le clan).

Les identifiants des troupes du lien d'armée viennent des données statiques de la bibliothèque clashofclans.js (licence MIT).

## Limites connues

- Les notifications ne marchent pas dans l'appli Android (WebView) : passer par Chrome (« Installer l'appli »).
- Pas de dernière connexion dans l'API : l'activité est déduite des compteurs (dons, trophées, attaques, Jeux de clan).
- Les dessins du tableau restent en mémoire (perdus au redémarrage du serveur).
- La version Cloudflare (branche `main`) n'a pas encore Signe / Non ni les statistiques.
- Les illustrations officielles (héros, troupes) ne sont pas incluses : icônes originales seulement.

This material is unofficial and is not endorsed by Supercell. For more information see Supercell's Fan Content Policy: www.supercell.com/fan-content-policy.
