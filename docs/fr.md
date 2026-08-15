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

Tout passe ensuite par le canal local ci-dessous : l'intégration pilote votre
boîtier sur votre propre réseau, et n'appelle jamais airsend.cloud pour envoyer
un ordre.

### Local

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

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Collez la **chaîne de connexion** de votre boîtier. C'est suffisant : le
   service AirSend tourne déjà dans l'intégration.
3. Collez votre **liste d'appareils** (voir plus bas).
4. Enregistrez, puis cliquez sur **Tester la connexion** : le résultat indique
   l'état du service intégré, du canal local, et le nombre d'appareils compris.
5. Les appareils apparaissent dans l'onglet **Découverte**, prêts à être
   ajoutés à Gladys.

L'**URL du service AirSend** ne sert que dans le cas décrit plus haut : un
service à vous.

Chaque appareil affiche en pastille le canal qui a porté son dernier ordre :
`local` quand votre boîtier a répondu, `unreachable` quand il n'a pas pu être
joint.

## La liste d'appareils

Sur airsend.cloud, ouvrez **Import/Export** et exportez vos appareils en
**JSON**. Cet export est lu tel quel, y compris sur une seule ligne, ce qui est
exactement ce qu'attend le champ **Appareils**.

### L'export JSON

Il se présente ainsi — une liste, et le canal radio écrit à plat :

```json
{
  "devices": [
    {
      "name": "Baie vitrée",
      "localip": "fe80::dcf6:e5ff:fe8f:89cd",
      "type": 4098,
      "pid": 25455,
      "addr": 8295
    }
  ]
}
```

Collez-le tel quel, y compris sur une seule ligne. `pid` et `addr` sont le
canal radio de l'appareil : `pid` en est l'identifiant de canal (le protocole,
partagé par tous les appareils pilotés de la même façon) et `addr` sa source
(l'adresse de l'émetteur). `localip` est l'adresse du boîtier auquel l'appareil
est rattaché ; le boîtier reste joint par la chaîne de connexion `sp://` saisie
plus haut.

Une entrée sans canal radio est ignorée : le boîtier n'aurait rien à émettre
pour elle. Le boîtier lui-même (`type: 0`) fait exception — il répond toujours
sur le canal 1.

### Écrire la liste à la main

La même liste peut s'écrire à la main, indexée par nom, avec le canal imbriqué
sous `channel` plutôt que le couple `pid` / `addr` à plat. Cela reste du JSON :

```json
{
  "devices": {
    "Boîtier AirSend": { "type": 0, "sensors": true, "refresh": 300 },
    "Volet salon": {
      "type": 4098,
      "invert": true,
      "channel": { "id": 25455, "source": 94311 }
    },
    "Lumière pergola": { "type": 4100, "channel": { "id": 26848, "source": 1442421508 } },
    "Capteur extérieur": {
      "type": 1,
      "features": ["temperature", "humidity"],
      "channel": { "id": 1368, "source": 542 }
    }
  }
}
```

### Types d'appareils

| `type` | Appareil               | Ce que vous obtenez dans Gladys                        |
| ------ | ---------------------- | ------------------------------------------------------ |
| `0`    | Boîtier AirSend        | Ses capteurs de température et de luminosité           |
| `1`    | Capteur / télécommande | Ce qu'il émet (voir `features` ci-dessous)             |
| `4096` | Bouton                 | Un bouton poussoir qui envoie TOGGLE                   |
| `4097` | Interrupteur           | Marche/Arrêt                                           |
| `4098` | Volet                  | Ouvrir / Stop / Fermer (**+** position si chronométré) |
| `4099` | Volet avec position    | Ouvrir / Stop / Fermer **+** une position 0-100 %      |
| `4100` | Lampe variable         | Marche/Arrêt **+** luminosité                          |

### Options d'un appareil

| Option              | Signification                                                                  |
| ------------------- | ------------------------------------------------------------------------------ |
| `type`              | Type d'appareil (tableau ci-dessus), **obligatoire**                           |
| `channel`           | Canal radio (`id`, `source`, `mac`, `seed`), **obligatoire**                   |
| `pid`               | Le `channel.id` de l'export JSON (utilisez l'un ou l'autre)                    |
| `addr`              | Le `channel.source` de l'export JSON                                           |
| `remotes`           | Autres émetteurs qui pilotent l'appareil (voir « La télécommande murale »)     |
| `spurl`             | Chaîne de connexion propre à cet appareil, si différente de la globale         |
| `wait`              | Attendre la confirmation radio avant de répondre (`false` par défaut)          |
| `invert`            | Inverser ouverture et fermeture, pour les volets posés à l'envers              |
| `travel_up`         | Sur un volet : durée d'une ouverture complète, en secondes (voir plus bas)     |
| `travel_down`       | Sur un volet : durée d'une fermeture complète, en secondes                     |
| `travel`            | Les deux à la fois, pour un moteur qui se comporte pareil dans les deux sens   |
| `favorite_position` | Sur un volet : la position programmée dans le moteur, en %                     |
| `sensors`           | Sur un boîtier (`type: 0`), exposer ses capteurs de température et lumière     |
| `refresh`           | Intervalle de lecture de ces capteurs, en secondes                             |
| `features`          | Sur un capteur (`type: 1`) : `temperature`, `humidity`, `illuminance`, `click` |

Un boîtier déclaré sans `sensors: true` ne crée aucun appareil dans Gladys :
il n'est là que pour porter la chaîne de connexion.

## La position d'un volet

Un volet 433 MHz ne dit jamais où il est : la radio transporte des ordres, pas
des positions. Ce qu'il a, en revanche, c'est une **durée** — un moteur donné
met toujours le même temps pour aller d'une butée à l'autre. Chronométrez cette
course une fois, et la position devient calculable.

Chronomètre en main, du démarrage du volet jusqu'à son arrêt tout seul, notez
les deux durées :

```json
{
  "devices": {
    "Volet salon": {
      "type": 4098,
      "travel_up": 22,
      "travel_down": 20,
      "channel": { "id": 25455, "source": 94311 }
    }
  }
}
```

L'intégration suit alors le volet seconde par seconde, que l'ordre vienne de
Gladys ou d'une télécommande murale entendue à la radio (ce qui suppose le
canal d'écoute décrit plus bas). Trois conséquences :

- un **`4098` obtient lui aussi une position** — la fonctionnalité apparaît dès
  que le volet est chronométré, et son curseur pilote le moteur par un
  Ouvrir/Stop minuté : l'intégration lance le volet dans le bon sens et lui
  envoie le Stop au moment où la course dit qu'il est arrivé ;
- **le stop ne ment plus** : un volet arrêté à mi-course remonte la position
  qu'il a réellement atteinte, au lieu de conserver les 100 % annoncés par
  l'ordre ;
- **l'estimation se répare toute seule** : un volet qu'on laisse aller jusqu'à
  sa butée est exactement à 0 % ou à 100 %, puisque le moteur s'y arrête
  physiquement. Chaque ouverture ou fermeture complète efface l'erreur
  accumulée par les courses partielles précédentes.

Comptez ±5 % de précision : un moteur ralentit en charge et par temps froid. Si
un volet dérive, un scénario qui l'ouvre entièrement une fois par jour suffit à
le remettre d'aplomb.

Un volet que vous n'avez pas chronométré garde le comportement précédent :
Gladys affiche la destination du dernier ordre, ce qui est tout ce qu'un
protocole unidirectionnel peut offrir.

Deux détails qui comptent :

- tant qu'il n'a pas fait sa première course complète, la position d'un volet
  chronométré est **inconnue**, et l'intégration ne publie rien plutôt que
  d'inventer une valeur. Ouvrez-le ou fermez-le une fois et c'est réglé.
  Demander une position avant cela envoie le volet à la butée la plus proche,
  ce qui est précisément ce qui établit la référence ;
- la position **survit aux redémarrages** de l'intégration : elle repart de la
  valeur conservée par Gladys.

### La position favorite

Beaucoup de moteurs ont une position à eux, programmée dans le matériel (le
bouton « my » de Somfy). La radio dit « va à ta position » sans jamais dire
laquelle. Mesurez-la une fois et déclarez-la avec `"favorite_position": 40` :
appuyer sur ce bouton remonte alors 40 % dans Gladys. Sans elle, le volet est
signalé arrêté quelque part entre les deux — la réponse honnête.

## Écouter la radio

Le boîtier AirSend peut retransmettre chaque trame qu'il entend — une
télécommande murale actionnée à la main, un capteur météo qui se réveille —
pour que Gladys suive ce qui se passe dans la maison, et pas seulement ce
qu'il a lui-même commandé. C'est ce qui fait bouger la position d'un volet
quand on l'ouvre depuis sa télécommande.

C'est **actif par défaut**, et il n'y a rien à régler : l'intégration abonne le
boîtier au protocole radio de vos appareils et reçoit les trames chez elle.
Rien à installer, rien à lier.

### Le canal d'écoute

Ce que le boîtier écoute est un **protocole**, pas un appareil : il n'a qu'une
radio, et l'abonner le fait basculer en réception permanente **d'un seul
protocole** à la fois. Le canal `1` est l'écoute générique 433 MHz, qui couvre
les protocoles conçus pour y entrer — mais pas les autres, et un volet Somfy
écouté sur le canal `1` reste silencieux exactement comme une télécommande sur
laquelle personne n'appuie.

L'intégration n'a donc pas à le deviner : elle demande au service AirSend quel
canal décode quel protocole, et abonne le boîtier à celui de vos appareils.
Laissez le champ **Canal d'écoute** vide.

Renseignez-le seulement pour écouter autre chose : le `pid` d'un protocole que
vous n'avez pas encore déclaré, `1` pour l'écoute générique, ou `0` pour couper
l'écoute.

Pour vérifier, cliquez sur **Tester la connexion** : la ligne _Écoute_ dit quel
protocole est écouté, quels appareils il couvre, et vers où les trames sont
poussées — ou pourquoi elles ne le sont pas.

### La télécommande murale

Un même volet est piloté par plusieurs émetteurs : le boîtier AirSend, et la
télécommande vissée au mur. Ils parlent le même protocole depuis des **adresses
différentes**, donc le boîtier les entend sur des canaux différents, et une
trame venue du mur n'appartient à aucun appareil déclaré. Elle est notée dans
les logs de l'intégration, avec son `pid` et son `addr`.

Rattachez cette adresse à l'appareil qu'elle pilote, et appuyer sur la
télécommande murale met à jour le volet dans Gladys comme le ferait Gladys :

```json
{
  "devices": {
    "Baie vitrée": {
      "type": 4098,
      "travel_up": 30,
      "travel_down": 26,
      "channel": { "id": 25455, "source": 8295 },
      "remotes": [94311]
    }
  }
}
```

Une adresse seule est lue sur le protocole de l'appareil lui-même ; une
télécommande sur un autre protocole s'écrit en entier :
`"remotes": [{ "pid": 1368, "addr": 542 }]`.

### Si vous faites tourner le service AirSend ailleurs

Le service web AirSend pousse les trames depuis la machine où il tourne. Quand
c'est l'intégration qui le fait tourner (le cas par défaut), il les pousse
directement chez elle. Un service qui tourne **sur une autre machine**, lui, ne
sait pas joindre l'intégration : les trames doivent alors passer par une URL
publique, fournie par Gladys Plus. Liez votre compte Gladys Plus et collez
votre clé Open API dans le bloc **Webhooks** de l'écran de configuration.

## Actions

- **Tester la connexion** — vérifie le canal local et indique les appareils
  lus. Le moyen le plus rapide de repérer une chaîne de connexion mal saisie
  ou une liste d'appareils qui n'a pas été comprise.
- **Identifier un appareil** — choisissez un appareil, un PING lui est envoyé.
  Tous les équipements 433 MHz n'y réagissent pas.

## Bon à savoir

- Le 433 MHz est un protocole **unidirectionnel** pour la plupart des
  équipements : rien ne confirme qu'un ordre a été reçu, et Gladys affiche la
  valeur envoyée. L'écoute (ci-dessus) transforme cette hypothèse en état réel,
  et chronométrer un volet (ci-dessus) lui donne une position.
- Les capteurs sont lus **dans le boîtier**, par le canal local.
- Le service intégré joint votre boîtier **depuis le conteneur de
  l'intégration**, à travers votre réseau : le `rhost=<IPv4>` de la chaîne de
  connexion est l'adresse qu'il compose, et elle doit être routable depuis
  l'hôte Gladys.
- Changer le `type` d'un appareil dans la liste crée un nouvel appareil dans
  Gladys (l'identifiant change) — sauf entre `4098` et `4099`, qui le
  partagent.

## En cas de problème

| Symptôme                               | À vérifier                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `Invalid connection string`            | L'URL `sp://`, et que son mot de passe correspond au boîtier                               |
| `Invalid input`                        | Le `channel` de l'appareil (`id`/`pid` et `source`/`addr`)                                 |
| `no radio channel` (logs)              | L'entrée n'a pas de canal : il lui faut `channel.id`, ou le couple `pid`/`addr`            |
| `no radio confirmation`                | Normal sans retour d'état : laissez `wait: false`                                          |
| Aucun appareil dans « Découverte »     | **Tester la connexion** : la liste n'a sans doute pas été lue                              |
| Le boîtier est injoignable             | La partie `?gw=0&rhost=<IPv4>` de la chaîne de connexion                                   |
| `Service AirSend intégré indisponible` | Les logs de l'intégration : le service y journalise son démarrage                          |
| Le boîtier répond à la main, pas ici   | L'IPv4 `rhost=` doit être joignable **depuis le conteneur**, pas seulement de votre PC     |
| Un volet n'affiche pas de position     | Chronométrez-le : `travel_up` / `travel_down`, puis ouvrez-le ou fermez-le à fond une fois |
| La position dérive avec le temps       | Rechronométrez la course, et ouvrez le volet à fond une fois par jour pour le recaler      |

L'intégration journalise tout ce qu'elle fait : consultez les logs de
l'intégration depuis l'interface de Gladys (ou `docker logs` sur l'hôte), avec
`LOG_LEVEL=debug` pour le détail complet.
