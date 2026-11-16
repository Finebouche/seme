# Intégration directe dans Stremio

Sème 0.4.3 est un module CommonJS chargé par `server.js` dans le serveur local
Stremio. Il vit dans le processus Node existant de Stremio, sans processus
permanent supplémentaire, tâche macOS ni service de lancement à la connexion.
Ce même module expose une extension compagnon et sa page **Configure** sur
`http://127.0.0.1:17881`. Les anciens composants Go et React restent retirés.

## Réglages

**Sème Setup.app** configure les trois clients. Pour Deluge, utilisez le mot de
passe **Deluge Web**, pas le fichier d’authentification du RPC natif ; Deluge Web
doit être connecté au daemon. Son champ utilisateur n’est pas utilisé.

| Client | Adresse habituelle |
| --- | --- |
| Transmission | `http://127.0.0.1:9091/transmission/rpc` |
| qBittorrent | `http://127.0.0.1:8080` |
| Deluge Web | `http://127.0.0.1:8112/json` |

La première ouverture lit `server-settings.json` de Stremio pour proposer son
cache actif. Si vous changez ce dossier dans Stremio, actualisez-le aussi dans
Sème Setup. Cache et conservation ne doivent pas s’imbriquer. Les montages avec
des chemins différents côté client et les dossiers liés par symlink ne sont pas
pris en charge. Les dossiers temporaires séparés des clients sont refusés.

Les réglages sont dans
`~/Library/Application Support/Seme/integration/config.json`. Les paramètres
avancés `intervalSeconds` (5–3600), `minFreeBytes` et `enabled` peuvent y être
modifiés. Ils sont relus entre les scans ; une sauvegarde via Sème Setup réactive
les transferts. Changer de client ou de dossier n’adopte ni ne déplace les torrents
précédemment importés.

## Extension compagnon et configuration

Après avoir quitté Stremio, utilisez **Install integration** dans Sème Setup
pour installer ou mettre à jour le module chargé par son serveur. Rouvrez ensuite
Stremio et utilisez **Add to Stremio** dans Sème Setup. Ce bouton vérifie le
manifeste local, puis ouvre l’écran d’installation des extensions dans Stremio.
Confirmez l’ajout de **Sème** : son bouton **Configure** passe par
`http://127.0.0.1:17881/configure`, qui tente d’ouvrir **Sème Setup** avec le lien
`seme://configure`. Stremio impose cette route HTTP pour son bouton ; le navigateur
peut demander une confirmation ou un clic sur **Ouvrir Sème Setup**. Ouvrez une fois
la nouvelle application depuis le Finder pour enregistrer son protocole auprès de
macOS. Le lien ne transmet aucun réglage ni identifiant et remet au premier plan
la fenêtre existante sans remplacer les saisies en cours.

La configuration web reste accessible en secours à
`http://127.0.0.1:17881/configure?web=1` pendant que le serveur Stremio fonctionne.

Le manifeste `http://127.0.0.1:17881/manifest.json` porte l’identifiant
`org.finebouche.seme`, la version `0.4.3` et l’indication `configurable`. Cette
extension n’ajoute ni catalogue ni source vidéo : le transfert continue à lire
directement le cache de Stremio. Le serveur HTTP est limité à l’adresse de boucle
locale ; il utilise le processus Node déjà ouvert par Stremio. Stremio doit donc
être ouvert pour ajouter l’extension ou utiliser le bouton Configure. Sème Setup
peut également être ouvert directement lorsque Stremio est fermé.

Le logo de graine est servi localement à `/icon.png`. Si une ancienne fiche garde
l’icône de puzzle, réutilisez **Add to Stremio** pour actualiser son manifeste.
Si Stremio conserve encore l’ancienne fiche, retirez seulement son entrée dans
les extensions puis ajoutez-la à nouveau ; cela ne désinstalle pas le module.

Les deux installations ont des rôles distincts : **Install integration** modifie
le serveur, tandis que **Add to Stremio** enregistre son entrée visible dans
Stremio après redémarrage. Si le manifeste est inaccessible, quittez Stremio,
mettez le module à jour avec **Install integration**, puis rouvrez Stremio avant
de réessayer. Désinstaller l’extension dans Stremio retire uniquement son entrée
visible. Pour retirer le module chargé par le serveur, quittez Stremio et utilisez
**Uninstall** dans Sème Setup ; retirez aussi l’entrée de ses extensions si elle
est encore présente.

## Installation et retour arrière

L’installateur ajoute un bloc `require()` au début du serveur, après son éventuel
shebang. Il place le module et les réglages dans le dossier utilisateur. Une
exception de chargement n’empêche pas Stremio de démarrer.

Les sauvegardes et empreintes SHA-256 sont dans le sous-dossier `installations`.
La désinstallation restaure les octets et le mode du fichier original. Elle ne
supprime pas les données conservées, les réglages ou les torrents. Un fichier
Stremio modifié après l’installation n’est jamais écrasé par une ancienne copie.
Quittez Stremio avant toute installation ou désinstallation.

Si les fichiers d’installation ont disparu mais que le bloc Sème correspond
exactement au bloc généré pour les chemins actuels, **Install integration** peut
récupérer l’installation. Il conserve une copie complète du serveur actuel,
reconstitue une sauvegarde en retirant uniquement ce bloc et réinstalle le module
sans modifier `server.js`. Cette sauvegarde reconstituée ne certifie pas que le
reste du fichier est identique à une distribution officielle de Stremio. Un bloc
modifié, dupliqué ou pointant vers d’autres chemins reste refusé. Conservez le
dossier `Application Support/Seme` tant que l’intégration est installée.

**Modifier Stremio.app invalide sa signature.** Si l’application reste bloquée
après restauration du fichier, réinstallez une copie officielle de Stremio.
Ne désactivez pas Gatekeeper globalement. Le module n’effectue pas de re-signature
et ne garantit pas sa compatibilité avec les prochaines versions de Stremio.

Pour inspecter sans modification, ou utiliser un autre emplacement :

```sh
NODE=/Applications/Stremio.app/Contents/MacOS/node
"$NODE" stremio-integration/cli.cjs preview --server /Applications/Stremio.app/Contents/MacOS/server.js
"$NODE" stremio-integration/cli.cjs install --server /Applications/Stremio.app/Contents/MacOS/server.js
"$NODE" stremio-integration/cli.cjs status
"$NODE" stremio-integration/cli.cjs uninstall
```

`--config /chemin/config.json` isole une installation de test. `configure` lit le
JSON sur l’entrée standard, sans mot de passe dans les arguments de processus.
`defaults` propose la configuration initiale. Après une mise à jour de Stremio,
quittez Stremio puis utilisez **Install integration** : si le fichier a changé,
Sème vérifie l’intégrité du paquet macOS, sa signature Developer ID officielle
(West Bridge Ltd, équipe `BH62GT22G7`, application `com.westbridge.stremio5-mac`)
et la protection de `server.js` par cette signature avant de le sauvegarder et
de réinstaller le module. Les anciennes sauvegardes, les réglages et les vidéos
sont conservés. Une signature invalide, un autre éditeur ou un bloc Sème résiduel
font échouer cette adoption automatique. La vérification de signature ne garantit
pas la compatibilité fonctionnelle avec chaque future version de Stremio.

La commande `install` utilise la même vérification. `install --accept-update`
reste un recours manuel pour une distribution déjà inspectée : cette option
contourne la vérification automatique et refuse toujours un bloc Sème modifié.

## Noms des dossiers et migration

Les nouveaux imports utilisent un dossier nommé d’après le torrent. Les noms
sont adaptés au système de fichiers ; les collisions reçoivent un suffixe court.
Les journaux restent identifiés par hash et les anciens dossiers restent valides.

Pour migrer les anciens dossiers avec Transmission, quittez Stremio et installez
le module à jour. Laissez Transmission ouvert. Prévisualisez puis appliquez :

```sh
NODE=/Applications/Stremio.app/Contents/MacOS/node
"$NODE" stremio-integration/cli.cjs migrate-folders
"$NODE" stremio-integration/cli.cjs migrate-folders --apply
```

La migration ne concerne que les imports identifiés par le journal et le marqueur
Sème. Elle met le torrent en pause, demande à Transmission de déplacer ses fichiers,
vérifie les données puis reprend le partage si le torrent était actif. Une pause
manuelle est conservée. Les autres torrents et les fichiers étrangers sont laissés
en place. En cas d’erreur, le journal conserve l’opération en cours et le torrent
reste en pause ; ne renommez pas les dossiers dans Finder pendant la migration.
Cette commande de migration est réservée à Transmission ; les nouveaux noms sont
utilisés avec les trois clients.

## Transfert et limites

Le cache attendu contient `<infohash>/cache` (métadonnées bencode), `bitfield`
et les fichiers numérotés `0`, `1`, etc. Sème ne modifie pas ce cache. Il conserve
les octets exacts du torrent, trackers inclus, et valide les chemins et tailles.
Il ne télécharge ni métadonnées ni vidéo.

Les vidéos dont tous les morceaux de couverture sont disponibles sont copiées
dans un espace temporaire privé sur le disque de destination. Les SHA-1 sont
vérifiés, y compris les fragments nécessaires des fichiers voisins. Les clones
APFS sont indépendants des fichiers du cache ; aucun lien symbolique ou physique
ne permet au client d’écrire dans le cache.

Les données sont ensuite placées dans `<destination>/<infohash>/`, avec leur
arborescence originale. Pour un nouvel épisode d’un torrent déjà géré, Sème le met
en pause avant la fusion et ne tronque pas les fichiers existants. Un torrent
mis en pause par l’utilisateur reste en pause après l’import. Le client vérifie
les données avant la reprise ; en cas d’erreur il reste arrêté. Les limites de
ratio/inactivité sont désactivées pour les nouveaux imports uniquement. Les
limites globales de file d’attente restent applicables.

Le contrôle disque réserve une marge et une estimation prudente du volume
temporaire. Même un clone possible peut être refusé si l’espace est faible.
Aucun nettoyage automatique n’est utilisé pour faire de la place.

La vérification doit être observable dans le client ou prouvée par la progression
de fichiers auparavant incomplets. Un contrôle trop rapide, avec des compteurs
déjà complets, peut laisser le torrent en pause plutôt que risquer un démarrage
sans preuve. Vérifiez et reprenez alors le torrent manuellement dans le client.

qBittorrent et Deluge peuvent fusionner les trackers lorsqu’un autre logiciel
ajoute le même torrent entre notre contrôle et notre demande d’ajout. La
vérification préalable évite les doublons ordinaires, mais leurs API ne permettent
pas de garantir une isolation absolue face à cette course. N’ajoutez pas
simultanément le même torrent par plusieurs applications.

## Diagnostics

**Refresh status** lit `status.json`, écrit par Stremio. C’est le dernier scan,
pas une mesure permanente du partage. Si aucune date n’apparaît, vérifiez que
Stremio a été relancé après l’installation. Ses journaux contiennent aussi des
messages courts préfixés `[Sème]`.

| Code | Action |
| --- | --- |
| `UNSUPPORTED_STORAGE` | Le dossier temporaire séparé est incompatible. Sème ne change pas ce réglage global. |
| `AMBIGUOUS_ADD` / `ADDED_SETUP_FAILED` | L’ajout a pu réussir sans confirmation complète. Inspectez le torrent en pause ; Sème ne l’adopte pas automatiquement. |
| `OWNERSHIP_CHANGED` | Chemin, marqueur ou torrent modifié. Aucun nouvel import dans ce torrent. |
| `INVALID_STATE` / `INVALID_LOCK` | Inspectez le journal avant toute réinitialisation. Les données restent conservées. |
| `TRANSFER_FAILED` | Vérifiez connexion, espace disque, accès aux dossiers et résultat du contrôle dans le client. |
| `CACHE_UNAVAILABLE` | Cache supprimé, incomplet ou format non pris en charge. Les autres caches restent examinés. |

Le journal dans `state/` identifie les imports et permet de reprendre les copies
interrompues. Ne le supprimez pas pour réparer un problème : cela retire la preuve
de propriété et les torrents existants deviennent des doublons ignorés.
Des copies abandonnées peuvent rester dans `<destination>/.seme-staging` après
un arrêt brutal ; ne les effacez pas pendant un transfert.

## Validation et essais complémentaires

Les tests couvrent les caches mono/multifichiers, les frontières de morceaux,
l’import d’un second épisode, l’isolation, les erreurs et reprises, les trois RPC
simulés et la restauration de Stremio. Le module et l’installateur sont vérifiés
avec Node 16.20.2 embarqué. L’ajout de l’extension visible et son bouton
**Configure** doivent aussi être vérifiés dans l’interface Stremio après
installation du module et redémarrage du serveur.

Une utilisation réelle avec Transmission a été confirmée par l’utilisateur. Cela
ne valide pas tous les cas de transfert, ni les clients qBittorrent et Deluge.
Pour compléter la validation sur chaque client, utilisez une vidéo
autorisée, observez sa lecture depuis une source habituelle Stremio, vérifiez que
le client reconnaît les données sans les télécharger, puis fermez Stremio et
contrôlez que le partage continue. Testez un deuxième fichier d’un même torrent
et le nettoyage du cache Stremio. Charger le module dans le serveur ne valide pas
à lui seul le comportement complet du lecteur.
