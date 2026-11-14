# Sème sur macOS

L’application nécessite macOS 13 ou plus récent. Elle contient le serveur Sème et
son interface web ; Transmission reste une application distincte à installer et
à laisser ouverte pour télécharger et partager.

## Installation et premier lancement

1. Décompressez l’archive correspondant à votre Mac : `arm64` pour Apple Silicon,
   `x86_64` pour Intel. Glissez **Sème.app** dans **Applications**. Le DMG facultatif
   propose le même glisser-déposer vers son raccourci **Applications**.
2. Ouvrez Sème. L’application lance son serveur local et affiche son interface
   dans une fenêtre ; aucun Terminal n’est nécessaire.
3. Suivez l’assistant initial. Transmission 4.1 ou plus récent est recommandé
   pour la lecture pendant le téléchargement. Dans Transmission, activez l’accès distant RPC,
   puis renseignez dans Sème l’adresse locale habituelle
   `http://127.0.0.1:9091/transmission/rpc` et les identifiants éventuels. Testez la
   connexion et choisissez un dossier de téléchargement accessible aux deux
   applications. Les réglages de Sème permettent de modifier ces valeurs ensuite.
4. Cliquez sur **Install in Stremio**, confirmez l’installation dans Stremio,
   puis choisissez une source **Sème** pour lancer une lecture.

**Démarrer à l’ouverture de session** est une option volontaire, désactivée par
défaut. Elle se gère depuis le menu de Sème ; macOS affiche aussi les applications
autorisées dans **Réglages Système → Général → Ouverture**. Conservez l’application
dans Applications avant d’activer cette option.

Fermer la fenêtre laisse Sème disponible dans la barre des menus. **Quitter Sème**
arrête son serveur local ; Transmission conserve les téléchargements et continue
de partager les torrents. Les lectures servies par Sème s’arrêtent quand vous
quittez l’application.

## Données et dépannage

Les données propres à l’application sont conservées dans
`~/Library/Application Support/Seme/` : configuration, base de données et fichiers
d’exécution. Elles restent sur place quand vous remplacez l’application pour une
mise à jour. Les médias restent dans le dossier choisi dans l’assistant.
Le fichier `config.yaml` du dépôt n’est pas importé automatiquement.

Le service écoute exclusivement sur `http://127.0.0.1:17880`. Cette installation
est destinée à Stremio sur le même Mac. Une seconde instance ou un port déjà
occupé provoque une erreur ; Sème ne prend pas le contrôle d’un autre serveur.

Le lanceur affiche une alerte si le serveur ne peut pas démarrer. Le journal du
serveur est `~/Library/Application Support/Seme/seme.log` ; gardez son contenu
privé lorsque vous partagez un diagnostic. Pour les diagnostics du lanceur,
utilisez aussi l’application Console de macOS. Vérifiez que Transmission est lancé, que le RPC
est activé et que les deux applications ont accès au dossier choisi. Un dossier
dans votre dossier personnel est généralement plus simple à autoriser qu’un
volume protégé.

Un build local porte une signature **ad hoc**, sans certificat Developer ID ni
notarisation Apple. Il convient au développement sur votre Mac ; une archive
téléchargée ainsi construite peut être bloquée par Gatekeeper. Pour une diffusion
publique, produisez et testez une version signée Developer ID et notariée. Ne
présentez pas un build local comme une version validée par Apple.

## Construire l’application

Prérequis sur macOS : les outils de ligne de commande Xcode (`xcode-select
--install`), Go compatible avec `go.mod`, Node.js avec npm, et les dépendances
natives fournies avec macOS. Aucune bibliothèque Swift tierce n’est nécessaire.

Depuis la racine du dépôt :

```sh
make mac-app
```

Le script exécute `npm ci` avec le lockfile, construit l’interface, la compile dans
le serveur Go, compile le lanceur Swift, génère le jeu d’icônes ICNS, copie la
licence MIT et les informations d’origine, puis signe et archive le bundle :

```text
dist/Sème.app
dist/Seme-macos-arm64.zip       # ou Seme-macos-x86_64.zip
```

L’icône utilise le PNG 512 px versionné, dérivé de `web/public/seed.svg` ; sa
représentation 1024 px est agrandie avec `sips`. La construction utilise les
outils macOS standard `iconutil`, `codesign` et `ditto`.

L’architecture par défaut est celle de la machine de compilation. Pour préciser
une architecture ou produire aussi un DMG :

```sh
ARCH=arm64 CREATE_DMG=1 make mac-app
ARCH=x86_64 make mac-app
```

Chaque archive contient une seule architecture. Construisez et testez séparément
les deux versions ; aucun bundle universel n’est produit. Une nouvelle exécution
remplace `dist/Sème.app` et l’archive de l’architecture choisie.

`VERSION` identifie le serveur (par défaut `git describe --tags --always --dirty`).
`MACOS_VERSION` définit la version affichée du bundle (défaut `0.1.0`) et
`MACOS_BUILD_NUMBER` son numéro de build (défaut `1`). Pour un build de release,
fixez ces valeurs et utilisez les mêmes versions de Go, Node/npm, Xcode et macOS.
Le lockfile et `go.sum` fixent les dépendances ; les signatures horodatées et les
métadonnées des archives ne garantissent pas une identité binaire entre builds.

```sh
VERSION=1.0.0 MACOS_VERSION=1.0.0 MACOS_BUILD_NUMBER=1 make mac-app
```

Pour vérifier le lancement et l’authentification de la fenêtre intégrée avec des
données temporaires, sans enregistrer l’assistant ni ajouter de torrent :

```sh
SEME_DESKTOP_DATA_DIR="$(mktemp -d /tmp/seme-smoke.XXXXXX)" \
  'dist/Sème.app/Contents/MacOS/Seme' --smoke-test
```

Quittez votre autre instance de Sème avant ce test : le service utilise le même
port local fixe. Le test doit afficher `SEME_SMOKE_OK` et fermer son propre
serveur. Il ne valide pas une lecture réelle dans Stremio.

## Signature de distribution et notarisation

Le build par défaut signe localement et ne contacte aucun service de notarisation.
Pour signer avec un certificat **Developer ID Application** déjà installé dans le
trousseau :

```sh
DEVELOPER_ID='Developer ID Application: Votre organisation (TEAMID)' make mac-app
```

Le serveur et le lanceur sont signés avec le runtime renforcé et un horodatage
sécurisé. La signature Developer ID seule ne constitue pas une notarisation.
Consultez les [conditions de notarisation d’Apple](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

La soumission nécessite un compte développeur Apple et un profil `notarytool`
stocké dans le trousseau, préparé selon le
[guide Apple du workflow de notarisation](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).
Une fois la soumission à Apple explicitement décidée, lancez :

```sh
DEVELOPER_ID='Developer ID Application: Votre organisation (TEAMID)' \
NOTARY_PROFILE='seme-notary' NOTARIZE=1 CREATE_DMG=1 make mac-app
```

Cette commande envoie l’archive à Apple, attend le résultat, agrafe le ticket au
bundle puis recrée le ZIP. Si demandé, elle signe, soumet et agrafe aussi le DMG.
Les identifiants sont lus depuis le profil du trousseau, sans secret dans le dépôt.
Le script vérifie la signature, le ticket et l’évaluation Gatekeeper du bundle.
Testez ensuite l’ouverture d’une copie téléchargée sur un Mac avant de distribuer
les fichiers. Le script ne publie rien, n’installe rien et ne modifie pas les
réglages d’ouverture de session du Mac de compilation.
