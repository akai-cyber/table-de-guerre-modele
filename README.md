# Table de guerre — version Cloudflare (sans PC)

La même appli que la version PC (suivi de guerre, cibles, table de dessin en direct), mais hébergée **gratuitement chez Cloudflare** : elle est toujours en ligne, l'adresse ne change jamais, et tout se règle **depuis un téléphone**.

Par rapport à la version PC :

- **Plus de PC à laisser allumé**, plus de tunnel, plus d'adresse qui change.
- **Les dessins et les captures sont conservés**, même si le serveur se met en veille (sur PC, ils étaient perdus au redémarrage).
- Une capture pèse **1,9 Mo au plus** (l'appli réduit toute seule les captures trop lourdes).
- La clé API Clash passe par un **relais** (voir « Comment ça marche »), parce que Cloudflare n'a pas d'adresse IP fixe.

---

## Ce qu'il te faut (gratuit, depuis le téléphone)

1. Un compte **GitHub** (<https://github.com>) : il sert à stocker le code. Le code est public, mais il ne contient aucun secret.
2. Un compte **Cloudflare** (<https://dash.cloudflare.com>) : c'est l'hébergeur. Le plan gratuit suffit.
3. Une **clé API Clash of Clans**, créée avec l'adresse IP du relais (étape 1).

## Étape 1 — La clé API Clash

1. Va sur <https://developer.clashofclans.com> et connecte-toi avec ton compte Supercell.
2. Crée une **nouvelle clé**. À la question « adresses IP autorisées », écris **uniquement** :

   ```
   45.79.218.79
   ```

   C'est l'adresse du relais (service communautaire de RoyaleAPI). Pas celle de ton téléphone, pas une autre.
3. Ouvre la clé et copie le long texte « token » (garde-le pour l'étape 3, sans le partager).
4. Dans le jeu, mets le **journal de guerre du clan en public**, sinon l'API refuse de répondre.

> **À savoir.** La clé passe par le relais de RoyaleAPI, un service tiers qui n'affiche ni conditions, ni politique de journalisation, ni garantie de disponibilité. Il verra ta clé et les données publiques de ta guerre. Crée donc une clé **rien que pour cette appli**, ne la réutilise pas ailleurs, et supprime-la sur developer.clashofclans.com si tu veux couper l'accès. Si le relais tombe, la page Guerre affichera une erreur jusqu'à son retour.

## Étape 2 — Mettre le code sur GitHub

Le bouton de l'étape 3 a besoin du code dans un **dépôt public** GitHub.

- Crée sur GitHub un dépôt **public** et vide, par exemple `table-de-guerre-modele`.
- Mets-y le contenu de ce dossier (`wrangler.jsonc`, `package.json`, `src/`, `public/`…), tel quel.
  - **Depuis un téléphone**, envoyer un dossier avec des sous-dossiers sur GitHub est peu pratique. Le plus simple est de demander à Claude de le déposer : connecte ton compte GitHub à Claude (dans ses réglages), donne-lui le nom du dépôt, il envoie les fichiers.
  - Avec un ordinateur : « Add file » puis « Upload files » sur la page du dépôt, ou `git push`.

## Étape 3 — Déployer chez Cloudflare

1. Ouvre cette adresse en remplaçant `TON-COMPTE` et le nom du dépôt :

   ```
   https://deploy.workers.cloudflare.com/?url=https://github.com/TON-COMPTE/table-de-guerre-modele
   ```

2. Connecte-toi à Cloudflare (ou crée ton compte), puis autorise Cloudflare à accéder à ton GitHub quand il le demande. Cloudflare **copie** le dépôt dans ton compte GitHub, et la page te laisse choisir le nom de cette copie et celui du Worker : prends un autre nom de dépôt que l'original (par exemple `table-de-guerre`).
3. La page te demande 3 valeurs :

   | Nom | À mettre |
   |---|---|
   | `CLASH_API_TOKEN` | le token copié à l'étape 1 |
   | `CLAN_TAG` | le tag de ton clan, avec ou sans le `#` |
   | `CHEF_CODE` | un code secret de ton choix (celui que tu taperas pour passer chef), d'au moins 8 caractères et que tu n'utilises nulle part ailleurs |

4. Valide (« Create and deploy » ou équivalent) et attends une ou deux minutes.
5. Cloudflare affiche l'adresse de ta table de guerre, de la forme `https://NOM-DU-WORKER.TON-NOM.workers.dev`. **C'est cette adresse qu'il faut envoyer au clan.**

## Étape 4 — Premier lancement

1. Ouvre l'adresse dans Chrome : la page Guerre se charge. Si elle affiche une erreur, regarde « Problèmes fréquents » plus bas.
2. Touche **Chef**, tape ton `CHEF_CODE` : tu peux maintenant choisir les cibles et dessiner.
3. Envoie l'adresse dans le chat du clan. Chaque joueur l'ouvre, choisit son nom dans « Je suis… » et voit sa cible.
4. Facultatif : dans Chrome, menu ⋮ puis « Ajouter à l'écran d'accueil » (vraie appli installable, car l'adresse est en HTTPS), ou installe `table-de-guerre.apk` et donne-lui cette adresse.

## Changer un réglage plus tard

Dans Cloudflare : **Workers & Pages** → ta table de guerre → **Settings** → **Variables and Secrets**. Tu peux y changer la clé, le tag du clan ou le code chef (une nouvelle clé API, par exemple), puis redéployer si Cloudflare le propose. Les noms des menus changent parfois : cherche « Variables » ou « Secrets » dans les réglages du Worker.

Pour changer le code lui-même, modifie le dépôt GitHub que Cloudflare a créé à l'étape 3 : chaque modification est redéployée automatiquement.

## Comment ça marche

- Les pages (dossier `public/`) sont servies directement par Cloudflare.
- Un seul « Durable Object » (`src/table.js`) tient les cibles, les dessins, les connexions en direct et les appels à l'API Clash. Son stockage (base SQLite) garde tout, même quand il dort. Les téléphones restent connectés pendant sa veille.
- `public/socket.io/socket.io.js` est un petit client temps réel qui remplace Socket.io : les pages sont **identiques** à celles de la version PC.
- L'API Clash est appelée toutes les 15 secondes au plus, **via** `https://cocproxy.royaleapi.dev/v1` (variable `CLASH_API_BASE`). Sans ce relais, il faudrait une clé liée à une adresse IP fixe, que Cloudflare ne fournit pas.

## Limites du plan gratuit (chiffres de Cloudflare)

- 100 000 requêtes par jour pour le Worker et autant pour le Durable Object. Les messages en direct d'un téléphone comptent pour 1/20 de requête, et les fichiers statiques (style, images, page du tableau) ne comptent pas ; seuls comptent la page d'accueil, l'API et la connexion en direct.
- Une page Guerre ouverte interroge le serveur toutes les 30 secondes **seulement quand elle est affichée** : environ 120 requêtes par heure. La limite correspond donc à environ 800 heures de pages ouvertes par jour, tous joueurs confondus. Exemple : 50 joueurs qui gardent la page ouverte 2 h chacun, c'est 12 % de la limite.
- 5 millions de lectures et 100 000 écritures de base par jour : un tracé = quelques écritures.
- Au-delà d'une limite, le service refuse les requêtes jusqu'à minuit (heure UTC).
- Tu peux suivre ta consommation dans Cloudflare, rubrique « Metrics » du Worker.

## Problèmes fréquents

| Message | Cause et solution |
|---|---|
| Clé API refusée : crée-la avec l'adresse IP 45.79.218.79 | La clé n'a pas été créée avec l'IP du relais. Crée-en une nouvelle (étape 1) et remplace `CLASH_API_TOKEN`. |
| Accès refusé : vérifie la clé API et que le journal de guerre du clan est public | Journal de guerre privé dans le jeu, ou token mal copié. |
| Clan introuvable | `CLAN_TAG` est faux : copie le tag depuis le jeu. |
| Trop de requêtes vers l'API Clash | Patiente quelques secondes. |
| Clé API manquante / Tag du clan manquant ou invalide | La valeur n'a pas été remplie, ou c'est encore la valeur d'exemple. |
| Impossible de joindre l'API Clash of Clans | Le relais ou l'API ne répondent pas. Réessaie plus tard. |
| L'API Clash of Clans est en maintenance | Supercell a coupé l'API (souvent lors des mises à jour du jeu). Réessaie plus tard. |
| Le mode chef n'est pas activé sur ce serveur | `CHEF_CODE` absent ou laissé à `choisis-un-code-secret`. |
| Trop d'essais : réessaie dans 10 minutes | 8 mauvais codes chef depuis la même adresse. |
| Pas de guerre en cours | Normal entre deux guerres. La Ligue de guerre de clans (LGC) n'est pas gérée. |

## Sécurité

- Quiconque a l'adresse peut **voir** la guerre et les plans ; seul le code chef permet de modifier cibles et dessins. Ne publie pas l'adresse hors du clan.
- Le code chef circule en HTTPS (chiffré). Après 8 essais ratés depuis une même adresse, elle est bloquée 10 minutes.
- La clé API et le code chef restent dans Cloudflare : ils ne sont jamais dans le dépôt GitHub et jamais envoyés aux téléphones.
- Les pages affichent la mention demandée par la [politique de contenu des fans de Supercell](https://supercell.com/en/fan-content-policy/). J'ai pu lire une version datée de 2020 : relis la politique en vigueur avant de diffuser l'appli largement (elle interdit notamment de faire payer l'accès).

## Pour les développeurs

```
npm install
cp .dev.vars.example .dev.vars    # puis remplis les 3 valeurs
npm run dev                       # http://localhost:8787
```

Dans `.dev.vars`, garde les valeurs entre guillemets si elles contiennent un `#`. Les pages de `public/` sont des copies de celles du dossier `public/` de la version PC (script `sync-cloudflare.sh` du projet complet). Seuls `public/socket.io/socket.io.js` et `public/_headers` sont propres à cette version. Les règles de validation (`src/core.js`) sont les mêmes que `server.js` ; si tu en changes une, change l'autre.

## État des tests

Testé en local avec le vrai moteur de Cloudflare (workerd) contre une **fausse** API Clash : l'interface dans Chrome en taille de téléphone, le temps réel à plusieurs appareils, le code chef et son blocage, les réponses comparées une à une à celles de la version PC sur des demandes piégées, la mise en veille du Durable Object (les connexions et les données survivent), le redémarrage complet avec reconnexion automatique, 60 joueurs en même temps, les captures lourdes, la limite de connexions.

**Non testé** : le déploiement réel chez Cloudflare (le bouton, la copie sur GitHub, les écrans d'inscription), le relais RoyaleAPI, la vraie API Clash (aucune clé disponible pendant la création) et de vrais téléphones. Si une étape se passe autrement que décrit ici, envoie la capture d'écran.

## Sources

- [Cloudflare : bouton « Deploy to Cloudflare »](https://developers.cloudflare.com/workers/platform/deploy-buttons/) (dépôt public, copie dans ton GitHub, secrets demandés d'après `.dev.vars.example`)
- [Cloudflare : tarifs des Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing) et [limites](https://developers.cloudflare.com/durable-objects/platform/limits) (plan gratuit, remise à zéro à 00:00 UTC, messages WebSocket facturés 20 pour 1)
- [Cloudflare : adresse workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [RoyaleAPI : relais pour l'API Clash](https://docs.royaleapi.com/proxy.html) (adresse du relais et IP à autoriser ; ses conditions d'usage ne sont pas publiées)
