# Sème

<img src="assets/seed.svg" alt="Logo Sème : une graine" width="80" height="80">

**Conserver et partager les vidéos regardées dans Stremio**, avec **Transmission,
qBittorrent ou Deluge**. Sème est un **fork de
[Seedstrem](https://github.com/kipsilabs/seedstrem)**, créé par **kipsilabs**.
La licence MIT et les mentions d’origine sont conservées.

Sa deuxième source d’inspiration est
**[stremio-seed](https://github.com/Vance-ng-vn/stremio-seed)**, de **Vance-ng-vn** :
intégrer le transfert du cache directement dans Stremio pour continuer à partager
les vidéos avec un client torrent, sans application Sème à garder ouverte.

L’intégration **0.4.3, expérimentale** s’exécute directement dans le
serveur local de Stremio. Stremio continue à rechercher les sources et à lire les
vidéos avec les extensions choisies par l’utilisateur. Sème ne dépend d’aucun
fournisseur de sources : il récupère les vidéos complètes du cache torrent local
et les confie au client torrent. Les extensions de catalogue et de sous-titres
restent utilisables.

Utilisez Sème uniquement pour les contenus dont vous êtes autorisé à conserver
une copie et à partager les données. La conservation automatique démarre leur
partage dans le client torrent ; celui-ci peut continuer après la fermeture de
Stremio, tant que le client reste actif.

```text
Stremio + ses extensions → lecture et cache torrent
                            ↓ module Sème intégré
                         copie locale vérifiée
                            ↓
                  Transmission / qBittorrent / Deluge → partage
```

**Pas de processus Sème permanent séparé.** Le module expose une extension
compagnon locale sur `http://127.0.0.1:17881`, dans le processus Node existant de
Stremio. Son entrée **Sème** dans les extensions permet d’ouvrir **Configure**
pour ouvrir l’application **Sème Setup** via un relais local. Elle ne fournit aucune source
vidéo et ne remplace pas les extensions habituelles. La fenêtre **Sème Setup**
sert aux réglages et à l’installation ; elle peut être fermée. Après le transfert, seul le client torrent doit rester ouvert
pour continuer à partager, avec l’ordinateur éveillé et connecté.

## Installation sur Mac

1. Installez Stremio dans `/Applications` et ouvrez-le au moins une fois. Son cache
   torrent doit être activé. Le format a été examiné sur Stremio **5.1.30**, dont
   le serveur embarque Node **16.20.2**.
2. Activez l’accès local RPC/Web UI de votre client : Transmission **4.0+**,
   qBittorrent avec Web API **2.7+**, ou Deluge **2.x avec Deluge Web connecté à son
   daemon**. Les trois adaptateurs sont testés sur des serveurs simulés. Une utilisation
   réelle avec Transmission a été confirmée par l’utilisateur ; qBittorrent et
   Deluge restent à valider en conditions réelles.
3. Ouvrez **Sème Setup.app**. Choisissez le client et ses identifiants, le dossier
   de cache Stremio et un dossier de conservation séparé. Utilisez **Test connection**.
4. Quittez complètement Stremio, puis cliquez sur **Install integration**.
5. Rouvrez Stremio, puis cliquez sur **Add to Stremio** dans Sème Setup.
   Confirmez l’installation de **Sème** dans Stremio. Le bouton **Configure** de
   cette extension ouvre **Sème Setup** via une page relais. Autorisez l’ouverture
   de l’application si le navigateur le demande. Un bouton permet de réessayer ;
   la configuration web reste accessible en secours. Ouvrez une fois la nouvelle
   application depuis le Finder pour enregistrer son lien `seme://configure`.
6. Regardez normalement vos sources torrent directes. Vous pouvez fermer
   Sème Setup et la page de configuration.

Après une mise à jour de Stremio, quittez-le et cliquez de nouveau sur
**Install integration**. Sème Setup vérifie la signature officielle et l’intégrité
de la nouvelle version avant de sauvegarder son serveur et de réinstaller Sème.
Il conserve vos réglages, les vidéos et les anciennes sauvegardes ; une version
modifiée ou signée par un éditeur inconnu reste refusée.

Le module examine le cache toutes les 30 secondes pendant que le serveur Stremio
tourne. Il copie les vidéos entièrement disponibles, vérifie leurs morceaux,
ajoute le torrent en pause, sélectionne les fichiers concernés puis demande une
vérification au client. Le partage démarre seulement lorsque les fichiers
sélectionnés sont reconnus complets. Une lecture interrompue est ignorée tant que
les morceaux nécessaires ne sont pas tous dans le cache.

**L’installation modifie `server.js` dans Stremio.app : elle invalide la signature
de l’application et macOS peut refuser son lancement.** Sème ne re-signe pas
Stremio. Une sauvegarde exacte permet de restaurer le fichier avec **Uninstall**,
si celui-ci n’a pas été modifié entre-temps. Une mise à jour de Stremio peut retirer
l’intégration ; réinstallez-la après vérification. Ce n’est pas une API officielle
d’extension du serveur Stremio. Retirer l’extension **Sème** depuis Stremio
supprime uniquement son entrée visible : utilisez **Uninstall** dans Sème Setup
pour retirer le module du serveur. Voir le [guide de l’intégration](docs/stremio-integration.md).

## Données et conservation

- Les nouveaux dossiers portent le nom du torrent, sans extension vidéo pour
  un fichier unique. Un suffixe court est ajouté uniquement si un nom est déjà
  utilisé. Le hash reste l’identifiant interne ; les noms des fichiers torrent
  ne sont pas modifiés.

- Aucun second téléchargement des morceaux déjà vérifiés n’est demandé. Les
  copies locales sont indépendantes du cache ; APFS peut les cloner pour limiter
  l’espace occupé, mais une copie complète reste possible.
- Pour un pack de saison, seuls les épisodes complets trouvés dans le cache sont
  sélectionnés. De petits fragments de fichiers voisins sont conservés si un
  morceau torrent traverse la frontière de l’épisode. Les épisodes suivants
  peuvent être ajoutés au même torrent sans effacer les précédents.
- Les torrents déjà présents dans le client sont ignorés. Le journal local,
  le chemin et, pour Transmission/qBittorrent, un marqueur identifient les imports.
  Une collision d’ajout simultané peut toutefois faire fusionner des trackers par
  qBittorrent ou Deluge avant leur refus : évitez d’importer simultanément le même
  torrent ailleurs. Sème ne supprime aucun torrent ni fichier de votre cache.
- Une réserve de **2 Gio** est conservée par défaut, avec une estimation prudente
  de l’espace nécessaire aux copies. Si l’espace manque, le transfert échoue sans
  supprimer les fichiers conservés.
- Les dossiers temporaires séparés de Transmission et qBittorrent ne sont pas
  pris en charge dans cette version. La connexion les signale ; Sème ne change
  aucun réglage global du client. Les clients doivent tourner sur le même Mac et
  accéder aux mêmes chemins locaux.
- Les réglages et identifiants sont enregistrés dans
  `~/Library/Application Support/Seme/integration/config.json` avec les permissions
  `0600`. **Refresh status** affiche l’état de l’installation et le dernier relevé
  du module. Les mots de passe ne figurent pas dans les diagnostics.

Les vidéos de débridage/HTTP sans torrent local ne sont pas concernées. Les
torrents v2 seuls sont ignorés. Fermer Stremio avant le transfert ou laisser son
cache être nettoyé peut empêcher la conservation de la vidéo. Les statistiques de
partage se consultent dans le client torrent.

## Développement

Le code se trouve dans [`stremio-integration/`](stremio-integration/).
Il utilise uniquement les modules fournis avec Node, sans `npm install`, et
fonctionne avec le Node embarqué de Stremio. Le lanceur de tests nécessite Node 22.

```sh
make check test
make build
```

Le build macOS produit `dist/Sème Setup.app` et
`dist/Seme-Stremio-Integration-macos.zip`. Il nécessite les outils de développement
Apple, pas Go ni le frontend React. L’installateur local possède une signature
ad hoc, sans notarisation Apple. Aucune publication n’est effectuée.

Les anciennes versions avec serveur Go et interface React ont été retirées
de ce dépôt ; l’extension compagnon 0.4.3 utilise uniquement le module intégré
actuel, sans réintroduire ces composants. Si vous migrez depuis Sème 0.2, quittez son application
et retirez son extension de Stremio. Les torrents déjà ajoutés restent dans leur
client. Les commandes `make integration-test`, `make integration-app` et
`make mac-app` restent des alias des commandes actuelles.

## Origine et inspirations

Sème est un fork de [Seedstrem, créé par kipsilabs](https://github.com/kipsilabs/seedstrem),
dont la [licence MIT et la mention de copyright](LICENSE) sont conservées. Sa deuxième
source d’inspiration est [stremio-seed, de Vance-ng-vn](https://github.com/Vance-ng-vn/stremio-seed),
qui relie le cache Stremio à qBittorrent. Son code n’a pas été copié : le module de
transfert et ses trois adaptateurs sont une implémentation indépendante.
