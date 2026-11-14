# Validation de Sème

## Tests automatisés

`make test` couvre le backend, les routes Stremio, la sélection de fichiers, la disponibilité des morceaux et les règles de conservation. `make vet` et `cd web && npm test && npm run build` vérifient le code et l'interface.

Les tests Transmission utilisent un serveur RPC simulé : session HTTP 409, authentification, versions/protocoles, labels, doublons étrangers, fichiers, bitfields, priorités et erreurs. Les tests Torrentio utilisent des réponses simulées et vérifient la propagation de l'index zéro et des trackers, les torrents de saison et l'exclusion des réponses de débridage.

## Test réel à effectuer avec un contenu autorisé

1. Activer l'accès RPC de Transmission et vérifier la connexion depuis les réglages Sème. Un HTTP 409 au premier appel est le mécanisme normal de négociation de session ; un refus de connexion signifie que le serveur RPC n'est pas accessible.
2. Noter les torrents déjà présents ; choisir une source Sème dans Stremio. Vérifier qu'un seul torrent est ajouté, avec le label `seme` et le bon dossier.
3. Attendre que la lecture démarre alors que Transmission affiche moins de 100 %. Vérifier que le fichier partiel est lu à son emplacement réel.
4. Avancer vers une partie encore absente, puis revenir au début. Un délai est possible pendant l'arrivée des morceaux ; aucune plage ne doit être remplie de zéros à la place des données manquantes.
5. Pour un pack de saison, vérifier que l'épisode joué correspond au `fileIdx` annoncé par Torrentio, puis essayer un autre épisode.
6. Fermer Stremio avant la fin du téléchargement. Vérifier que Transmission continue le téléchargement puis le seed ; rouvrir la même source ne doit pas ajouter un doublon.
7. Vérifier que les torrents non étiquetés `seme` ont conservé fichiers, priorités, limites de seed et état. Demander une source dont le hash existe déjà sans label doit être refusé, sans adoption.
8. Avec `cleanup.keep_forever: true`, laisser des seuils de ratio/durée dépassés et vérifier qu'aucun torrent n'est supprimé. Tester toute suppression volontaire uniquement avec un torrent de test.
9. Réinstaller l’extension Sème après mise à jour pour charger son nouveau catalogue. Dans **Sème — Currently seeding** (ou **Découvrir → Autres**), vérifier l’affiche, le volume envoyé, le ratio et la date du relevé par rapport à Transmission. Les compteurs sont ceux du torrent entier, même si seul un épisode a été téléchargé.
10. Avec un torrent de test géré par Sème, mettre le seed en pause dans Transmission : après actualisation du catalogue il doit disparaître, et sa fiche déjà ouverte doit indiquer la pause au prochain chargement. Le relancer dans Transmission doit le faire réapparaître. Vérifier que la consultation du catalogue ne change pas les réglages et n’ajoute aucun torrent.
11. Relire une vidéo terminée depuis sa fiche : le lien doit utiliser les données locales sans interroger Torrentio. Une ancienne sélection de fichier restée incomplète ne doit pas être proposée. Sans connexion au client torrent, Sème doit signaler l’indisponibilité plutôt que présenter des statistiques inventées.

La présence de Transmission 4.1.4 (RPC 19, API 6.0.1) sur le poste de développement a été vérifiée par appel réel en lecture seule ; version, espace disponible, suffixe `.part` et filtrage par label répondent correctement. Une réponse réelle Torrentio de 23 sources a été capturée pour tester le décodage. Le client s’identifie avec `Seme/0.1`, car Torrentio refuse l’agent HTTP générique de Go. Les tests simulés ne remplacent pas ces vérifications dans Stremio avec un essaim réel.

## Références du protocole

- [Spécification RPC Transmission](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md)
- [Compatibilité RPC de Transmission 4.1.4](https://github.com/transmission/transmission/blob/4.1.4/libtransmission/api-compat.cc)
- [Réponse stream du SDK Stremio](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md)
