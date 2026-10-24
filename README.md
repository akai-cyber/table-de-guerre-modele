# Table de guerre — version serveur (Render)

Appli web (et appli Android) pour un clan Clash of Clans :

- **Guerre** : guerre en cours en direct, cibles assignées par le chef, attaques restantes.
- **Tableau** : le chef dessine le plan d'attaque sur la capture d'une base, les joueurs le voient en direct.
- **Dispos (Signe / Non)** : le chef ouvre une période, chaque membre dit s'il est disponible ; statistiques, filtres, historique.
- **Menu** : profil, mode chef, informations du clan, état du serveur.

## Variables d'environnement (Render → Environment)

| Variable | Obligatoire | Rôle |
|---|---|---|
| `CLASH_API_TOKEN` | oui | Clé de developer.clashofclans.com (IP autorisée : `45.79.218.79`) |
| `CLASH_API_BASE` | oui sur Render | `https://cocproxy.royaleapi.dev/v1` (relais RoyaleAPI, IP fixe) |
| `CLAN_TAG` | oui | Tag du clan, ex. `#2CJURJQC0` |
| `CHEF_CODE` | oui | Code du mode chef (8 caractères ou plus) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | **fortement conseillé** | Enregistrement durable (voir plus bas) |
| `IDENTITE` | non | `jeton` (défaut) ou `libre` |

## Enregistrement durable (important sur Render gratuit)

Sans Upstash, les données (cibles, périodes, réponses, identifications) sont dans un fichier local.
Sur Render gratuit, ce fichier est **effacé** à chaque mise en veille (15 min sans visite) et à chaque mise à jour.

Pour les garder, depuis un téléphone :
1. Crée un compte gratuit sur upstash.com (connexion Google possible).
2. **Create Database** → Redis, région Europe, offre Free.
3. Dans la base, section **REST API**, copie `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.
4. Ajoute ces deux variables dans Render → Environment, puis **Save, rebuild, and deploy**.
5. Menu → Serveur doit afficher « base Upstash (durable) ».

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

## Limites connues

- Pas de notification dans le jeu : le « Rappel » prépare un message à copier ou partager.
- Pas de chat intégré (le bouton d'en-tête ouvre les informations du clan).
- Les dessins du tableau restent en mémoire (perdus au redémarrage du serveur).
- La version Cloudflare (branche `main`) n'a pas encore l'écran Signe / Non.

This material is unofficial and is not endorsed by Supercell. For more information see Supercell's Fan Content Policy: www.supercell.com/fan-content-policy.
