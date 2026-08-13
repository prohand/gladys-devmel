# Devmel (AirSend)

Cette intégration relie Gladys à une passerelle radio **Devmel AirSend** ou
**AirSend Duo**, et à travers elle aux équipements 433 MHz / 868 MHz qu'elle
pilote : volets roulants, interrupteurs, lampes variables, portails, et les
capteurs qui émettent en retour (Somfy RTS, Chacon DiO, Nice, FAAC,
Bubendorff…).

## Avant de commencer

Vos appareils s'appairent dans l'**application mobile AirSend** ou sur
[airsend.cloud](https://airsend.cloud), pas dans Gladys : cette intégration
rejoue les ordres radio qu'ils connaissent déjà. Faites-les d'abord
fonctionner là-bas.

Il vous faut ensuite au moins un des deux canaux ci-dessous — les deux, c'est
mieux : ils se relaient.

### Local (recommandé)

Le canal local dialogue avec le **service web AirSend**, le petit serveur HTTP
fourni par Devmel pour piloter le boîtier depuis votre réseau.

**Il est inclus.** L'intégration le fait tourner dans son propre conteneur, sur
`http://127.0.0.1:33863`, et le surveille : rien à installer à côté de Gladys,
aucune URL à renseigner. C'est l'interrupteur **Utiliser le service AirSend
intégré**, activé par défaut, qui le commande.

La seule chose que le canal local attend de vous est donc la **chaîne de
connexion** exportée par airsend.cloud, de la forme :

```
sp://motdepasse@[fe80::xxxx:xxxx:xxxx:xxxx]?gw=0&rhost=192.168.1.50
```

Conservez toujours la partie `?gw=0&rhost=<IPv4 du boîtier>` : sans elle le
boîtier n'est joignable qu'en IPv6 lien-local et le service renvoie des
erreurs inattendues.

#### Utiliser un service que vous faites déjà tourner

Si le service web AirSend tourne déjà quelque part sur votre réseau — l'add-on
Home Assistant, le démon Jeedom, un conteneur à vous — renseignez simplement le
champ **URL du service AirSend** (`http://192.168.1.50:33863/`). Une URL saisie
là l'emporte : l'intégration l'utilise et ne démarre rien de son côté.

### Cloud

Le canal cloud appelle directement `airsend.cloud` avec la **clé d'API** de
votre compte. C'est un **repli**, totalement facultatif : il prend le relais
quand le boîtier est injoignable en local. Il ne sait qu'envoyer des ordres —
les capteurs et les trames radio entrantes sont réservés au canal local — et
chaque appareil doit porter son `id` airsend.cloud pour qu'il fonctionne.

#### La clé d'API du cloud

La clé est celle de votre **compte airsend.cloud**, celui où vos appareils sont
déclarés : connectez-vous sur [app.airsend.cloud](https://app.airsend.cloud) et
cherchez la clé d'API de votre compte.

Deux choses à savoir avant de partir à sa recherche :

- **vous n'en avez probablement pas besoin.** Avec le service intégré
  ci-dessus, le canal local fonctionne seul ; la clé n'achète qu'un repli pour
  les moments où le boîtier est injoignable, et les ordres envoyés pendant ce
  temps-là ;
- **elle est peut-être déjà dans votre export.** L'export YAML la référence
  sous la forme `!secret apiKey`, et ce champ est ce que cette référence vient
  chercher. Un export qui porte la clé en clair (`apiKey: xxxxx`) est utilisé
  tel quel, appareil par appareil — rien à renseigner du tout.

L'API elle-même est documentée sur
[asp.devmel.com/api-docs](https://asp.devmel.com/api-docs).

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Collez la **chaîne de connexion** de votre boîtier. C'est suffisant : le
   service AirSend tourne déjà dans l'intégration.
3. Collez votre **liste d'appareils** (voir plus bas).
4. Enregistrez, puis cliquez sur **Tester la connexion** : le résultat indique
   l'état du service intégré, des deux canaux, et le nombre d'appareils
   compris.
5. Les appareils apparaissent dans l'onglet **Découverte**, prêts à être
   ajoutés à Gladys.

L'**URL du service AirSend** et la **clé d'API airsend.cloud** ne servent que
dans les deux cas décrits plus haut : un service à vous, et le repli cloud.

L'interrupteur **Préférer la connexion locale** décide du canal essayé en
premier. Chaque appareil affiche en pastille le canal qui a réellement porté
son dernier ordre, avec un point orange s'il a fonctionné en mode dégradé
(local refusé, repli sur le cloud).

## La liste d'appareils

Sur airsend.cloud, ouvrez **Import/Export → Export YAML** et cochez `spurl`
pour la connexion locale. C'est cet export qu'attend le champ **Appareils**,
et les références `!secret spurl` / `!secret apiKey` qu'il contient sont
résolues avec les identifiants saisis plus haut.

Le champ est une saisie sur une seule ligne : le collage le plus sûr est donc
la forme **JSON** de cette liste — le même contenu, sur une ligne :

```json
{ "Volet salon": { "type": 4098, "channel": { "id": 25455, "source": 94311 } } }
```

L'export YAML est lu également, tant que les retours à la ligne survivent au
collage :

```yaml
devices:
  Boîtier AirSend:
    type: 0
    spurl: !secret spurl
    sensors: true
    refresh: 300

  Volet salon:
    id: 12345
    type: 4098
    invert: true
    apiKey: !secret apiKey
    channel:
      id: 25455
      source: 94311

  Lumière pergola:
    id: 65838
    type: 4100
    channel:
      id: 26848
      source: 1442421508

  Capteur extérieur:
    type: 1
    features: [temperature, humidity]
    channel:
      id: 1368
      source: 542
```

### Types d'appareils

| `type` | Appareil               | Ce que vous obtenez dans Gladys                   |
| ------ | ---------------------- | ------------------------------------------------- |
| `0`    | Boîtier AirSend        | Ses capteurs de température et de luminosité      |
| `1`    | Capteur / télécommande | Ce qu'il émet (voir `features` ci-dessous)        |
| `4096` | Bouton                 | Un bouton poussoir qui envoie TOGGLE              |
| `4097` | Interrupteur           | Marche/Arrêt                                      |
| `4098` | Volet                  | Ouvrir / Stop / Fermer                            |
| `4099` | Volet avec position    | Ouvrir / Stop / Fermer **+** une position 0-100 % |
| `4100` | Lampe variable         | Marche/Arrêt **+** luminosité                     |

### Options d'un appareil

| Option     | Signification                                                                  |
| ---------- | ------------------------------------------------------------------------------ |
| `type`     | Type d'appareil (tableau ci-dessus), **obligatoire**                           |
| `id`       | Identifiant airsend.cloud — nécessaire pour le canal cloud                     |
| `channel`  | Canal radio (`id`, `source`, `mac`, `seed`) — nécessaire pour le canal local   |
| `spurl`    | Chaîne de connexion propre à cet appareil, si différente de la globale         |
| `apiKey`   | Clé d'API propre à cet appareil, si différente de la globale                   |
| `wait`     | Attendre la confirmation radio avant de répondre (`false` par défaut)          |
| `invert`   | Inverser ouverture et fermeture, pour les volets posés à l'envers              |
| `sensors`  | Sur un boîtier (`type: 0`), exposer ses capteurs de température et lumière     |
| `refresh`  | Intervalle de lecture de ces capteurs, en secondes                             |
| `features` | Sur un capteur (`type: 1`) : `temperature`, `humidity`, `illuminance`, `click` |

Un boîtier déclaré sans `sensors: true` ne crée aucun appareil dans Gladys :
il n'est là que pour porter la chaîne de connexion.

## Écouter la radio (optionnel, nécessite Gladys Plus)

Le boîtier AirSend peut retransmettre chaque trame qu'il entend — une
télécommande murale actionnée à la main, un capteur météo qui se réveille —
pour que Gladys suive ce qui se passe dans la maison, et pas seulement ce
qu'il a lui-même commandé.

Le boîtier pousse ces trames vers une URL publique, fournie par Gladys Plus :
liez votre compte Gladys Plus et collez votre clé Open API dans le bloc
**Webhooks** de l'écran de configuration. L'intégration abonne alors le
boîtier au **canal d'écoute** (canal `1` par défaut ; `0` désactive l'écoute).

Sans Gladys Plus tout le reste continue de fonctionner, et les capteurs du
boîtier sont rafraîchis par interrogation périodique.

## Actions

- **Tester la connexion** — vérifie les deux canaux et indique les appareils
  lus. Le moyen le plus rapide de repérer une chaîne de connexion mal saisie
  ou une liste d'appareils qui n'a pas été comprise.
- **Identifier un appareil** — choisissez un appareil, un PING lui est envoyé.
  Tous les équipements 433 MHz n'y réagissent pas.

## Bon à savoir

- Le 433 MHz est un protocole **unidirectionnel** pour la plupart des
  équipements : rien ne confirme qu'un ordre a été reçu, et Gladys affiche la
  valeur envoyée. L'écoute (ci-dessus) transforme cette hypothèse en état réel.
- Les capteurs sont lus **dans le boîtier** : ils nécessitent le canal local.
- Le service intégré joint votre boîtier **depuis le conteneur de
  l'intégration**, à travers votre réseau : le `rhost=<IPv4>` de la chaîne de
  connexion est l'adresse qu'il compose, et elle doit être routable depuis
  l'hôte Gladys.
- Changer le `type` d'un appareil dans la liste crée un nouvel appareil dans
  Gladys (l'identifiant change) — sauf entre `4098` et `4099`, qui le
  partagent.

## En cas de problème

| Symptôme                               | À vérifier                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `Invalid connection string`            | L'URL `sp://`, et que son mot de passe correspond au boîtier                           |
| `Invalid input`                        | Le `channel` de l'appareil (`id` et `source`)                                          |
| `no radio confirmation`                | Normal sans retour d'état : laissez `wait: false`                                      |
| Aucun appareil dans « Découverte »     | **Tester la connexion** : la liste n'a sans doute pas été lue                          |
| Le boîtier est injoignable             | La partie `?gw=0&rhost=<IPv4>` de la chaîne de connexion                               |
| `Service AirSend intégré indisponible` | Les logs de l'intégration : le service y journalise son démarrage                      |
| Le boîtier répond à la main, pas ici   | L'IPv4 `rhost=` doit être joignable **depuis le conteneur**, pas seulement de votre PC |

L'intégration journalise tout ce qu'elle fait : consultez les logs de
l'intégration depuis l'interface de Gladys (ou `docker logs` sur l'hôte), avec
`LOG_LEVEL=debug` pour le détail complet.
