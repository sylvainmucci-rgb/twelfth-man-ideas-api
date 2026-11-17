# Twelfth Man Manager — API communautaire

Serveur Node autonome, **sans dépendance** (Node ≥ 18). Il sert la **Boîte à idées** du jeu et les **salons de Défi entre amis**.
⚠️ **Non déployé** : le choix de l'hébergement revient à Sylvain.

## Lancer en local
```
ADMIN_KEY="une-cle-longue-et-secrete-32c" node server.js     # http://localhost:8787
npm test                                                     # test de bout en bout (18 vérifications)
```
Dans le jeu, ouvrez Boîte à idées → « URL de l'API » et saisissez `http://localhost:8787`.

## Routes
| Méthode | Route | Rôle |
|---|---|---|
| GET | `/health` | état du serveur |
| GET | `/ideas?sort=top\|new` | idées publiques (sans identifiant d'appareil) |
| POST | `/ideas` | `{ title, description, category, pseudo?, deviceId }` : l'auteur vote automatiquement |
| POST | `/ideas/:id/vote` | `{ deviceId }` : 1 vote par appareil (409 sinon) |
| GET | `/admin/ideas` | 🔑 toutes les idées, masquées comprises |
| PATCH | `/ideas/:id` | 🔑 `{ status: proposee\|acceptee\|dev\|livree, adminNote?, hidden? }` |
| DELETE | `/ideas/:id` | 🔑 suppression |
| POST | `/duels` | `{ code }` (code de défi `TMM1-…`) → `{ id }`, salon valable 7 jours |
| GET | `/duels/:id` | `{ codeA, codeB }` |
| POST | `/duels/:id/join` | `{ code }` : l'ami dépose son code |

🔑 = en-tête `x-admin-key: <ADMIN_KEY>` (16 caractères minimum, comparaison à temps constant). Sans clé valide, la modération est désactivée.

Exemple de modération :
```
curl -X PATCH https://…/ideas/abcd1234 -H "x-admin-key: $ADMIN_KEY" -H "content-type: application/json" -d '{"status":"livree","adminNote":"Livré en V2.1"}'
```

## Protection
- **Limitation de débit** par IP : 120 requêtes par minute au total, 5 propositions par 10 min, 40 votes par 10 min, 20 salons par 10 min.
- **Anti-spam** :
  - pot de miel (`website`) ;
  - longueurs minimale et maximale, 2 liens au maximum ;
  - mots interdits (casino, paris en ligne…) et caractères répétés ;
  - doublons de titre ;
  - 3 idées par jour et par appareil ;
  - corps de requête limité à 8 Ko.
- **Vie privée** :
  - aucun compte, aucun e-mail ;
  - l'identifiant d'appareil est aléatoire et n'est stocké que haché (SHA-256 salé avec `DEVICE_SALT`) ;
  - il n'est jamais renvoyé par l'API.
- **CORS** limité à `ALLOWED_ORIGINS`. Par défaut : `https://localhost` (appli Android Capacitor), `capacitor://localhost`, `http://localhost:5173` et `null` (jeu ouvert en double-clic, file://). Ajoutez le domaine web du jeu quand il existera. Les autres origines reçoivent un 403.

## Variables d'environnement
`PORT`, `ADMIN_KEY`, `DEVICE_SALT`, `ALLOWED_ORIGINS` (séparées par des virgules), `DATA_DIR` (où écrire `db.json` ; l'écriture est atomique).

## Déploiement (plus tard, après accord de Sylvain)
- `render.yaml` est prêt : service web Node, offre gratuite, `ADMIN_KEY` et `DEVICE_SALT` générés par Render.
- **Limite de l'offre gratuite** : le disque est éphémère, donc les idées sont perdues à chaque redéploiement ou mise en veille. Pour les conserver, il faut :
  - soit un disque persistant (offre payante, bloc `disk` commenté dans `render.yaml`) ;
  - soit une base externe.
- L'instance gratuite se met en veille : la première requête peut prendre environ 30 s. Le jeu affiche alors « hors ligne » et met les actions en file d'attente.
