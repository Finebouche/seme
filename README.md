# Sème

<img src="web/public/seed.svg" alt="Logo Sème : une graine" width="80" height="80">

Sème est un **fork de [Seedstrem](https://github.com/kipsilabs/seedstrem)**, l’add-on Stremio créé par **kipsilabs**. Il propose ses propres sources issues de Torrentio, les télécharge avec Transmission et sert les mêmes fichiers à Stremio pendant leur téléchargement. Transmission conserve les fichiers et continue de partager après la fermeture du lecteur.

```text
Stremio → sources Sème → Torrentio (recherche)
        → lecture Sème → Transmission (téléchargement et seed)
                       → fichier local → Stremio (HTTP Range)
```

Cinemeta et OpenSubtitles restent utilisables. Une lecture choisie directement dans Torrentio ne passe pas par Sème : choisissez une source **Sème**. Aucun service de débridage n'est nécessaire. Les réponses Torrentio contenant uniquement une URL de débridage sont ignorées.

## Application Mac

Sur macOS 13 ou plus récent, **Sème.app** contient le serveur et son interface : aucun Terminal, Go ou Node.js n’est nécessaire pour l’utiliser. Transmission et Stremio restent des applications séparées.

1. Glissez **Sème.app** dans **Applications**, puis ouvrez-la.
2. L’assistant vous guide pour activer et tester l’accès distant de Transmission, choisir un dossier avec le sélecteur natif macOS et configurer Torrentio.
3. Cliquez sur **Install in Stremio**, puis confirmez l’installation dans Stremio.

Fermer la fenêtre laisse Sème dans la barre des menus. Le démarrage à l’ouverture de session est facultatif. Quitter Sème arrête la lecture locale, mais Transmission continue de télécharger et de partager.

L’application utilise `http://127.0.0.1:17880` et conserve ses réglages dans `~/Library/Application Support/Seme/`, séparément du `config.yaml` de développement. Son assistant télécharge uniquement le fichier choisi et conserve les données pour le seed.

Pour construire l’application : `make mac-app` ; pour produire aussi un installateur : `CREATE_DMG=1 make mac-app`. Les fichiers sont créés dans `dist/`. Le build local possède une signature ad hoc ; une distribution publique sans avertissement Gatekeeper nécessite une signature Developer ID et une notarisation Apple. Voir le [guide macOS](docs/macos.md).

## Démarrer en local avec le Terminal

Prérequis : Go 1.25 ou plus récent, Node.js 22 et npm, Transmission **4.1 ou plus récent** recommandé. Transmission 4.0 permet l'ajout isolé par label mais pas la priorisation séquentielle nécessaire à une lecture fluide avant la fin du téléchargement ; les versions antérieures sont refusées à l'ajout.

```sh
cd web && npm ci && cd ..
make build
cp config.example.yaml config.yaml
./bin/seme --config config.yaml
```

1. Activez l'accès distant RPC dans les réglages Transmission ; l'adresse habituelle est `http://127.0.0.1:9091/transmission/rpc`. Renseignez les identifiants RPC dans Sème si l'authentification est activée.
2. Ouvrez [Sème](http://localhost:8080). Le mot de passe administrateur est généré au premier lancement et enregistré dans `config.yaml` (également affiché au démarrage).
3. Dans les réglages, choisissez **Transmission**, le label `seme` et un dossier de téléchargement dédié. Le bouton **Browse…** permet de parcourir les dossiers existants sur l’ordinateur où tourne Sème ; **Use this local folder** sélectionne le dossier et ajoute son mapping local si nécessaire. Cliquez sur **Save** pour enregistrer. Le même sélecteur est disponible pour chaque chemin local dans **Path mappings**. Si macOS refuse l’accès à un dossier, autorisez le processus qui lance Sème dans les réglages de confidentialité ou choisissez un dossier accessible ; le bouton **Home folder** permet de revenir au dossier personnel.
4. Configurez un mapping de ce dossier vers lui-même lorsque Sème tourne sur le même ordinateur. Si Transmission utilise un dossier temporaire distinct, ajoutez aussi son mapping. Les fichiers partiels `.part` sont pris en charge. Les chemins doivent être accessibles à Sème.
5. Activez **Torrentio**. Le champ URL accepte l'adresse de l'add-on, son chemin de configuration ou l'URL complète se terminant par `/manifest.json`. Utilisez une configuration de torrent direct, sans débridage. Prowlarr est facultatif ; désactivez Torrentio pour utiliser le fournisseur Prowlarr historique.
6. Installez [le manifeste Sème](http://localhost:8080/stremio/manifest.json) dans Stremio. Choisissez ensuite une source Sème pour lancer la lecture.

Pour Stremio sur un autre appareil, adaptez `server.external_url` à une adresse joignable depuis cet appareil. `localhost` désigne toujours l'appareil du lecteur.

Les variables `SEME_*` permettent de surcharger la configuration ; les anciennes variables `SEEDSTREM_*` restent acceptées, avec priorité à `SEME_*`. Voir [config.example.yaml](config.example.yaml). Les identifiants Transmission sont masqués dans les réponses de configuration de l'API administrateur.

## Conservation et isolation

- `cleanup.keep_forever: true` désactive les suppressions automatiques, y compris pour une lecture interrompue. C'est le réglage par défaut.
- Les torrents ajoutés dans Transmission portent le label Sème ; Sème refuse de modifier ou d'adopter un torrent existant sans ce label. Les opérations de suppression et de priorité revérifient le label.
- Les limites globales de ratio et d'inactivité de Transmission sont désactivées **pour les torrents ajoutés par Sème**, afin qu'ils puissent continuer de seeder. Les réglages globaux et les autres torrents ne sont pas modifiés.
- `seeding.full: false` est le réglage par défaut : seul le fichier joué est sélectionné, et les données obtenues restent partageables après le visionnage. Avec `true`, le torrent entier est téléchargé, y compris les autres épisodes d’un pack de saison, en donnant la priorité au fichier choisi.
- Pour un nettoyage automatique volontaire, désactivez `keep_forever`, puis choisissez les seuils de durée/ratio. `storage.delete_files_on_remove` contrôle la suppression des données et vaut `false` par défaut. Une suppression manuelle explicite reste possible.

## Voir ses partages dans Stremio

Le catalogue **Sème — Currently seeding** affiche les torrents suivis par Sème
qui portent encore son label et que le client torrent signale en cours de seed,
y compris lorsqu’ils attendent des pairs. Les torrents en pause, en erreur ou
encore en téléchargement ne figurent pas dans cette liste.

Chaque fiche présente l’affiche du titre quand ses métadonnées sont connues,
sinon le logo Sème, ainsi que le volume envoyé, le ratio et l’état relevés à la
date indiquée. Ces statistiques concernent le torrent entier ; finir un épisode
ne signifie pas avoir téléchargé toute la saison. Stremio peut conserver les
résultats en cache : ce catalogue n’est pas un tableau de bord en temps réel.

Les vidéos déjà entièrement téléchargées et précédemment sélectionnées peuvent
être relues depuis leur fiche, sans nouvelle recherche Torrentio. Consulter le
catalogue ne lance aucun téléchargement et ne change aucune priorité.

Après une mise à jour depuis la version sans catalogue, retirez puis réinstallez
l’extension Sème dans Stremio pour actualiser son manifeste. Cela ne supprime
pas les torrents de Transmission. Le catalogue peut être vide tant qu’aucun
torrent géré n’est en seed ; cherchez-le aussi dans **Découvrir → Autres**.
Sème doit rester ouvert pour fournir le catalogue et les vidéos. Transmission
continue de partager après fermeture de Stremio, et même après fermeture de
Sème, tant que Transmission tourne et que le Mac reste éveillé et connecté.

## Lecture pendant le téléchargement

L'index `fileIdx` fourni par Torrentio est conservé, y compris l'index zéro. Sans index, Sème utilise la sélection d'épisode par nom de fichier héritée de Seedstrem. Les trackers de `sources` sont transmis dans le magnet ; la découverte DHT dépend également de son activation dans Transmission.

Sème attend les morceaux disponibles avant de servir les plages HTTP : il ne lance pas un second moteur torrent. Transmission 4.1 expose un curseur séquentiel, utilisé pour préparer et déplacer la lecture. Ce mécanisme ne garantit ni un délai de démarrage ni une avance instantanée : ils dépendent des pairs, du format vidéo et du débit. Les anciens clients ne simulent pas cette capacité.

Pour conserver le choix exact du fichier, la liste de sources Torrentio est interrogée à nouveau lors de la découverte ; une source déjà ajoutée est annotée comme telle. La redécouverte via Torrentio dépend donc de sa disponibilité, même si les données sont déjà présentes. Un lien de lecture déjà obtenu réutilise les fichiers locaux.

Consultez la [checklist de validation](docs/validation.md) pour les vérifications de lecture réelle, de navigation et de seed.

## Docker Desktop sur Mac

Le [docker-compose.yml](docker-compose.yml) se connecte au Transmission déjà installé via `host.docker.internal`. Définissez `SEME_DOWNLOADS` sur le dossier de téléchargement réel et les identifiants RPC, puis lancez `docker compose up --build`. Configurez le mapping du chemin macOS vers `/data` dans Sème. Montez aussi le dossier incomplet si nécessaire. Transmission doit autoriser les connexions RPC du réseau Docker. Aucun second Transmission n'est lancé.

## Développement et origine

```sh
make build
make test
make vet
cd web && npm test
```

Les clients qBittorrent et Deluge et le fournisseur Prowlarr restent disponibles. L'espace de noms Go `github.com/kipsilabs/seedstrem` est conservé pour limiter les changements sans rapport avec cette intégration ; l'exécutable est `seme`.

Sème reprend le travail de **kipsilabs / Seedstrem**. La [licence MIT et son copyright d'origine](LICENSE) sont conservés, ainsi que la [documentation amont](docs/seedstrem-upstream.md) et les mentions des composants tiers.
