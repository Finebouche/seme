# Sème

<img src="assets/seed.svg" alt="Logo Sème : une graine" width="80" height="80">

**Conserver et partager les vidéos regardées dans Stremio**, avec **Transmission,
qBittorrent ou Deluge**. Sème est un **fork de
[Seedstrem](https://github.com/kipsilabs/seedstrem)**, créé par **kipsilabs**.
La licence MIT et les mentions d’origine sont conservées.

L’intégration **0.3.0, expérimentale** s’exécute directement dans le
serveur local de Stremio. Stremio continue à rechercher les sources et à lire les
vidéos avec ses extensions habituelles, dont Torrentio, Cinemeta et OpenSubtitles.
Sème récupère les vidéos complètes de son cache et les confie au client torrent.

```text
Stremio + ses extensions → lecture et cache torrent
                            ↓ module Sème intégré
                         copie locale vérifiée
                            ↓
                  Transmission / qBittorrent / Deluge → partage
```

**Pas de serveur Sème séparé, pas d’extension Sème à installer dans Stremio.**
La fenêtre **Sème Setup** sert uniquement aux réglages et à l’installation ; elle
peut être fermée. Après le transfert, seul le client torrent doit rester ouvert
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
5. Rouvrez Stremio et regardez normalement vos sources torrent directes.
   Vous pouvez fermer Sème Setup.

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
d’extension Stremio. Voir le [guide de l’intégration](docs/stremio-integration.md).

## Données et conservation

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

Les anciennes versions avec serveur Go, interface React et extension Stremio ont
été retirées de ce dépôt. Si vous migrez depuis Sème 0.2, quittez son application
et retirez son extension de Stremio. Les torrents déjà ajoutés restent dans leur
client. Les commandes `make integration-test`, `make integration-app` et
`make mac-app` restent des alias des commandes actuelles.

## Origine

Sème est un fork de [Seedstrem, créé par kipsilabs](https://github.com/kipsilabs/seedstrem),
dont la [licence MIT et la mention de copyright](LICENSE) sont conservées. L’intégration est
inspirée du principe de [stremio-seed](https://github.com/Vance-ng-vn/stremio-seed),
qui relie le cache Stremio à qBittorrent. Son code n’a pas été copié : le module de
transfert et ses trois adaptateurs sont une implémentation indépendante.
