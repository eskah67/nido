# Nido

**Une interface moderne pour Home Assistant, générée automatiquement à partir de ta maison.**

Nido lit les pièces, appareils et capteurs de ton Home Assistant et construit tout seul une application : accueil, lumières, chauffage, consommation, sécurité… Tu peux ensuite masquer, renommer, changer l'icône ou déplacer n'importe quelle carte. Elle s'installe sur l'écran d'accueil du téléphone comme une vraie application.

*English: Nido is a modern web app (PWA) for Home Assistant that builds its interface automatically from your areas, devices and sensors. Every card can be hidden, renamed, re-iconed or moved. The interface is in French for now.*

## Ce que fait Nido

- **Interface générée automatiquement** à partir des pièces (zones) de Home Assistant : il n'y a rien à configurer.
- **Accueil :**
  - heure, météo et présence du foyer ;
  - un résumé « En un coup d'œil » ;
  - la température de chaque pièce sur 24 h, avec l'état du chauffage ;
  - les lumières et les volets.
- **Une page par pièce :** courbes de température et d'humidité, radiateurs, lumières, volets et capteurs.
- **Lumières :** allumer d'un geste, régler luminosité et teinte avec un appui long.
- **Chauffage :** consigne, modes (Éco, Confort, Hors-gel…), plannings et courbe des températures.
- **Consommation :** puissance en direct et consommation par heure, jour ou mois avec son coût, d'après le tableau Énergie de Home Assistant.
- **Ménage, sécurité, système :** aspirateur, caméra, portes, mouvements, carte du foyer, mises à jour et automatisations.
- **Fiches détaillées :** touche une valeur pour voir son historique sur 24 h.
- **Personnalisable :** chaque carte peut être masquée, renommée, changée d'icône ou déplacée.
- **Réglages synchronisés :** les choix sont enregistrés dans le compte Home Assistant de chaque utilisateur et le suivent sur tous ses appareils.
- **Comme une vraie app :** sur téléphone, tablette ou ordinateur, en plein écran, démarrage instantané, reconnexion automatique, thème clair ou sombre.

Une page n'apparaît que si les appareils correspondants existent : sans aspirateur, pas de page Ménage.

## Installation

### Méthode 1 — Script (Terminal & SSH)

Dans Home Assistant, installe l'app **Terminal & SSH**, ouvre-la, puis lance :

```sh
curl -fsSL https://raw.githubusercontent.com/eskah67/nido/main/scripts/install.sh | sh
```

La même commande sert pour les mises à jour. Ta configuration personnelle (`config.js`) est conservée.

### Méthode 2 — À la main

1. Télécharge le dépôt (bouton **Code → Download ZIP**).
2. Avec l'app **File editor** ou **Samba share**, copie le dossier `www/nido` dans le dossier `config/www/` de Home Assistant.

Avec l'une ou l'autre méthode, si le dossier `www` n'existait pas, redémarre Home Assistant une fois.

### Ouvrir et installer l'app

1. Dans le navigateur du téléphone, ouvre `https://<adresse-de-ton-home-assistant>/local/nido/index.html`.
2. Touche **Se connecter** : c'est la page de connexion habituelle de Home Assistant. Coche « Rester connecté ».
3. Installe l'app :
   - **iPhone (Safari) :** **Partager** → **Sur l'écran d'accueil**.
   - **Android (Chrome) :** menu **⋮** → **Installer l'application**.

L'app fonctionne partout où ton Home Assistant est accessible : chez toi, et à l'extérieur si tu as un accès distant (DuckDNS, Nabu Casa…).

Pour voir l'app sans te connecter, ajoute `?demo` à l'adresse : elle affiche une maison d'exemple.

## Personnaliser

**Les cartes.** Ouvre le bouton ⚙ en haut à droite, puis **Personnaliser les cartes**. Chaque carte affiche alors des boutons :
- **← → / ↑ ↓** pour la déplacer ;
- **✎** pour la renommer ou changer son icône (toutes les icônes [Material Design](https://pictogrammers.com/library/mdi/) fonctionnent) ;
- **👁** pour la masquer ou la réafficher.

Touche **Terminé** pour revenir à l'utilisation normale, ou **Tout rétablir** pour annuler toutes les personnalisations.

**Les réglages.** Toujours dans ⚙ :
- **Thème :** automatique, clair ou sombre.
- **Pages :** affiche ou masque les pages et les onglets.
- **Pièce « en chauffe » :** une pièce compte comme en chauffe dès qu'un radiateur chauffe, ou seulement s'il chauffe en mode Confort.

**Chaque membre du foyer** a ses propres réglages, enregistrés dans son compte Home Assistant.

## Pour une bonne détection

Nido se base sur l'organisation de ton Home Assistant :
- **Range tes appareils dans leurs pièces** : Paramètres → Zones, étages et étiquettes.
- **Les pièces affichées** sont celles qui ont un capteur de température ou un radiateur.
- **Ce qui est ignoré :** les entités masquées, désactivées ou techniques (diagnostic, configuration), et les groupes de lumières (pour éviter les doublons).
- **La consommation** s'appuie sur le tableau Énergie (Paramètres → Tableaux de bord → Énergie).

### Forcer une configuration (facultatif)

Si la détection ne te convient pas, tu peux décrire une section toi-même dans `www/nido/config.js` :
- **Le modèle :** [examples/config.complet.js](examples/config.complet.js) contient toutes les options.
- **Le principe :** une section présente dans `config.js` remplace la détection, les autres restent automatiques.
- **Seulement par ce fichier :** quelques cartes ne sont pas détectées et ne s'ajoutent qu'ainsi, comme le NAS Synology, la box internet ou le chauffe-eau.

## Questions fréquentes

**Faut-il un jeton d'accès ?**
Non, si l'app est ouverte depuis Home Assistant (`/local/nido/`) : elle utilise la connexion habituelle. Le jeton longue durée ne sert que si tu l'héberges ailleurs.

**Mes identifiants sont-ils envoyés quelque part ?**
Non. L'app parle uniquement à ton Home Assistant. Seuls les polices, les icônes et la carte du foyer (bibliothèque Leaflet et fond OpenStreetMap) viennent d'Internet.

**L'app ne se met pas à jour sur l'iPhone.**
Ferme-la complètement (balaie-la vers le haut dans le sélecteur d'apps), puis rouvre-la. Elle vérifie ensuite seule les nouvelles versions à chaque ouverture.

## Structure du dépôt

```
www/nido/         l'application (à copier dans config/www/nido)
  config.js       configuration facultative (vide par défaut)
  discovery.js    détection automatique depuis Home Assistant
  app.js          interface, navigation, personnalisation
  ha.js           connexion à Home Assistant (WebSocket) et mode démo
  styles.css      thèmes clair et sombre, mise en page
examples/         configuration complète commentée
scripts/          script d'installation et de mise à jour
```

Aucune étape de compilation : ce sont des fichiers HTML, CSS et JavaScript.

## Licence

MIT — voir [LICENSE](LICENSE).
