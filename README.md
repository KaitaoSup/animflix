# 🍿 Animflix (ServeurAnimeTorr)

[![Node.js](https://img.shields.io/badge/Node.js-v18+-68a063?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PWA Ready](https://img.shields.io/badge/PWA-Installable-blueviolet?logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)
[![TorrServer](https://img.shields.io/badge/Engine-TorrServer_MatriX-orange)](https://github.com/YouROK/TorrServer)
[![FFmpeg](https://img.shields.io/badge/Transcoder-FFmpeg-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![AniList API](https://img.shields.io/badge/Metadata-AniList_GraphQL-02a9ff?logo=anilist&logoColor=white)](https://anilist.co/)

Application web complète et moderne de streaming d'animes en direct à partir de torrents (Nyaa.si), sans attente de téléchargement complet. Intègre un lecteur multimédia sur-mesure optimisé pour desktop et mobile (PWA), la synchronisation en temps réel avec AniList, l'extraction de sous-titres WebVTT à la volée (0% CPU), la détection intelligente des pistes audio/sous-titres français (FFprobe), et le transcodage matériel/logiciel (FFmpeg).

---

## 📋 Sommaire
1. [Fonctionnalités Clés](#-fonctionnalités-clés)
2. [Architecture Technique de l'Application](#-architecture-technique-de-lapplication)
   - [Diagramme d'Architecture Globale](#diagramme-darchitecture-globale)
   - [Flux de Données & Streaming](#flux-de-données--streaming)
   - [Organisation Modulaire des Fichiers](#organisation-modulaire-des-fichiers)
3. [Prérequis Système](#-prérequis-système)
4. [Installation & Configuration](#-installation--configuration)
5. [Déploiement & Lancement](#-déploiement--lancement)
   - [Option A : PM2 (Recommandé en Production)](#option-a--pm2-recommandé-en-production)
   - [Option B : Docker & Docker-Compose](#option-b--docker--docker-compose)
   - [Option C : Lancement Manuel (Développement)](#option-c--lancement-manuel-développement)
6. [Guide d'Utilisation](#-guide-dutilisation)
7. [Contrôles, Gestes & Raccourcis](#-contrôles-gestes--raccourcis)
   - [📱 Gestes Tactiles Mobile & Tablette](#-gestes-tactiles-mobile--tablette)
   - [⌨️ Raccourcis Clavier Desktop](#️-raccourcis-clavier-desktop)
8. [Dépannage & FAQ](#-dépannage--faq)

---

## ✨ Fonctionnalités Clés

### 🍿 1. Découverte & Accueil à Froid (Cold Start)
- **Onglet Découverte Automatique** : Les nouveaux visiteurs sans historique ou non connectés arrivent directement sur une sélection riche d'animes au lieu d'un écran vide.
- **Double Sélection AniList en Temps Réel** :
  - **🔥 Tendances du Moment** : Les 12 séries les plus populaires et discutées cette semaine.
  - **🌸 Saison en Cours** : Calculée dynamiquement selon la date (Automne, Hiver, Printemps, Été + Année) avec les sorties incontournables.
- **Cartes Interactives & Détaillées** : Note moyenne, format (TV, Movie, OVA), genres, compte à rebours de diffusion en direct (`⏳ Ép. X dans 2j 5h`). Un clic ouvre la fiche de l'anime (Découverte, Planning, « En cours » et favoris).
- **Cache Local Haute Performance** : Données mises en cache 30 minutes dans `localStorage` pour un affichage instantané (0 ms de latence) lors des changements d'onglets.
- **Squelettes de chargement** : Les grilles (recherche, Découverte, Planning, « En cours », fiche anime) affichent des cartes fantômes animées pendant le chargement au lieu d'un spinner.

### 📺 2. Fiche Anime & Lecture en 1 Clic
- **Fiche AniList complète** (`#/anime/<id>`) : bannière, couverture, synopsis, note, genres, statut de diffusion, liens vers les autres saisons (préquelle, suite, spin-off).
- **Grille des épisodes** avec titres et miniatures AniList :
  - ✓ épisodes vus (progression AniList ou historique local), barre de progression pour un épisode entamé ;
  - pastille verte = épisode disponible seul, jaune = disponible dans un pack ;
  - tuile « à venir » avec compte à rebours du prochain épisode ;
  - plages d'épisodes (1–100, 101–200…) pour les longues séries.
- **Bouton principal contextuel** : `▶ Reprendre l'épisode N à 12:34`, `Regarder l'épisode N` ou `Commencer`.
- **Choix automatique du torrent** :
  - recherche Nyaa en parallèle sur tous les titres AniList (anglais, romaji…) ;
  - torrents sans seeders et d'une autre saison écartés ;
  - priorité à l'épisode seul, puis au pack d'épisodes, puis au pack de saison (le bon fichier est sélectionné dans le pack) ;
  - classement selon les **préférences de release** (groupe, résolution), puis les seeders ;
  - recherche ciblée (`Titre 05`, `Titre S01E05`) si rien ne correspond ; en dernier recours, ouverture de la liste brute.
- **« Si vous avez aimé… »** : jusqu'à 10 recommandations AniList les mieux notées par la communauté (hors saisons de la même série, animes à venir et 18+ sauf préférence contraire), avec l'état dans votre liste AniList (✓ Vu, ▶ En cours, 🔖 Prévu).
- **« 📋 Choisir la source »** : accès à la liste complète des torrents pour choisir manuellement.
- **Recherche texte** : les fiches AniList correspondantes sont proposées au-dessus des résultats Nyaa.

### 🔗 3. Navigation par URL
- Chaque vue possède son adresse, partageable et compatible avec le rafraîchissement (F5) :

  | URL | Vue |
  | :--- | :--- |
  | `#/` | Accueil |
  | `#/discover`, `#/schedule`, `#/anilist`, `#/history`, `#/favorites` | Onglets de l'accueil |
  | `#/search?q=Frieren&type=vf` | Résultats Nyaa (`type` omis pour VOSTFR) |
  | `#/anime/154587` | Fiche anime AniList |
  | `#/watch/<infohash>/<fichier>` | Lecteur |
- **Boutons Précédent / Suivant du navigateur** (et geste retour sur mobile) fonctionnels ; revenir du lecteur vers des résultats ne relance pas la recherche Nyaa.
- Un lien `#/watch/…` ouvert sur un autre appareil relance le torrent à partir de son infohash (connexion aux pairs via la DHT).
- **Dialogues intégrés** : les confirmations (suppression de profil, purge du cache, historique…) utilisent une fenêtre accessible au clavier et à la télécommande (Échap annule, focus sur « Annuler » pour les actions destructives).

### 🔍 4. Recherche & Filtrage Multi-Critères
- **Scraping Nyaa.si ultra-rapide (< 400 ms)** avec extraction d'infoHash et génération directe de magnets P2P (contourne les protections Cloudflare).
- **Barre d'outils dynamique** avec compteur de résultats.
- **Filtres rapides (Chips)** : `Tous`, `1080p Full HD`, `720p HD`, `📦 Packs / Saisons`.
- **Tri intelligent** : `🌱 Seeders (Les plus rapides)`, `⚡ Pertinence` (avec priorité à l'épisode ciblé), `📦 Taille (Plus grand)`, `📦 Taille (Plus léger)`.
- **Inspection des Packs & Saisons (Batches)** : Détection automatique des fichiers vidéo au sein d'un pack torrent avec menu interactif de sélection d'épisodes.

### 🎬 5. Lecteur Multimédia Sur-Mesure & Sous-Titres WebVTT
- **Deux Modes de Lecture** :
  - ⚡ **Lecture Directe (0% CPU, ultra-rapide)** : Copie brute du flux vidéo MP4 vers le navigateur avec extraction et streaming des pistes de sous-titres WebVTT.
  - 🔄 **Transcodage H.264 Universel** : Encodage multithread FFmpeg à la volée en cas de codec audio/vidéo non supporté nativement.
- **Timeline Scrubber Fluide** : Prévisualisation temporelle (tooltip), indicateur de tampon réseau (buffer), scrubbing interactif à la souris et au toucher.
- **Contrôles Avancés** :
  - Saut d'opening en 1 clic (**Skip OP +85s**).
  - **Passer le récap, l'opening, l'ending et l'aperçu du prochain épisode** : bouton « Passer… » pendant le passage (ou saut automatique, *Paramètres ⚙️*), marqueurs colorés sur la timeline. Les temps viennent des chapitres du fichier (« Recap », « Résumé », « OP », « ED », « Preview », « Prochain épisode »…) en priorité, sinon d'AniSkip (opening, ending, récap, génériques « mixtes »). Passer l'aperçu final lance directement l'épisode suivant si le compte à rebours est affiché.
  - Sauts temporels rapides (`-10s` / `+10s`).
  - Sélecteur de vitesse de lecture (`0.75x`, `1x`, `1.25x`, `1.5x`, `2x`).
  - **Enchaînement automatique** : épisode suivant (même pack ou nouvelle recherche), puis **saison suivante** à la fin du dernier épisode (suite AniList TV / ONA / film déjà sortie : sa fiche s'ouvre et l'épisode 1 démarre après un compte à rebours de 10 s).
  - **Boost Vocal & Égalisation (Web Audio API)** : Compresseur dynamique pour rendre les voix intelligibles sans subir d'explosions sonores assourdissantes.
- **Moteur de Sous-Titres Sur-Mesure** :
  - Synchronisation temporelle calée au **Keyframe réel** (`/api/play-sync`).
  - Fusion intelligente des coupures artificielles sur une seule ligne tout en préservant les répliques de dialogue (`- `) et les paroles de chansons (`♪`).
  - Personnalisation intégrale : taille, couleurs (Blanc, Jaune VOSTFR, Cyan, Vert, Rose), fond, contours 360°, ombrages et polices.
  - Ajustement manuel à la volée de la synchronisation des sous-titres (<kbd>G</kbd>/<kbd>H</kbd>) et de l'audio (<kbd>J</kbd>/<kbd>K</kbd>).

### 📱 6. Expérience Mobile & PWA (Progressive Web App)
- **Installable en 1 clic** sur Android, iOS, Windows et macOS (manifeste complet, icônes maskable).
- **Raccourcis d'Application (App Shortcuts)** : Accès direct depuis l'écran d'accueil à la Recherche, à l'Historique ou aux Favoris.
- **Verrouillage d'Orientation Paysage** : En plein écran sur mobile, bascule et verrouille automatiquement la vidéo en mode paysage.
- **Intégration Native MediaSession API** : Métadonnées, affiche HD et contrôles multimédias sur l'écran de verrouillage du smartphone et les casques/écouteurs Bluetooth.
- **Gestes Tactiles Naturels** : Double-tap gauche (-10s), double-tap droite (+10s), double-tap centre (Pause / Play), tap simple pour afficher/masquer les commandes avec temporisation intelligente (4,5s).

### ☁️ 7. Suivi AniList, Historique & Favoris
- **Synchronisation AniList Bi-directionnelle** : Connexion OAuth sécurisée, synchronisation automatique de l'épisode visionné à 85% ou à la fin, affichage des animés en cours.
- **⭐ Ma liste AniList depuis la fiche** : panneau « Ma liste » sous les boutons de la fiche anime (compte AniList connecté) :
  - statut (En cours, À voir, Terminé, Je le revois, En pause, Abandonné), ajout ou retrait de la liste (avec confirmation) ; « Terminé » met la progression au dernier épisode ;
  - note en 5 étoiles par demi-étoile (= note sur 10), recliquer sur la note la retire ; AniList la convertit dans votre format de notation (sur 10, sur 100, sur 5, smileys) ;
  - un anime terminé sans note est mis en avant (« Terminé : votre note ? ») et, à la fin du dernier épisode sans saison suivante, le lecteur propose de le noter.
- **📅 Planning dans votre agenda (.ics)** : onglet *Planning* → **📅 Mon agenda** (compte Animflix lié à AniList). Un lien d'abonnement personnel ajoute à Google Agenda, Apple Calendrier, Outlook ou Thunderbird les épisodes de vos animes « En cours » (option : « À voir aussi ») sur 7 jours passés et 5 semaines à venir, mis à jour toutes les heures ; chaque événement renvoie vers la fiche de l'épisode dans Animflix. Le lien contient un jeton secret (« Nouveau lien » révoque l'ancien). Les agendas en ligne (Google, Outlook.com) doivent pouvoir joindre le serveur : utilisez son adresse HTTPS publique (Tailscale Funnel).
- **💾 Garder sur le serveur (épisodes hors ligne)** : le bouton 💾 du lecteur télécharge l'épisode en entier sur le serveur (dossier `downloads/`, ou `DOWNLOADS_DIR` dans `.env`). Ensuite :
  - toute lecture de ce torrent (direct, transcodage, HLS, sous-titres, miniatures) lit le fichier local : l'épisode reste regardable **sans seeders**, même si TorrServer est arrêté ;
  - sur la fiche anime, l'épisode porte un badge 💾 et un clic lance la copie du serveur en priorité ;
  - onglet **« 💾 Sur le serveur »** : progression et débit en direct, Regarder, « 📲 Sur l'appareil » (enregistre le fichier depuis le disque du serveur), suppression, nouvel essai en cas d'échec ;
  - un téléchargement à la fois (les lectures en cours ne sont pas ralenties), reprise automatique après une coupure ou un redémarrage, refus si moins de 2 Go resteraient libres sur le disque ;
  - bibliothèque commune aux comptes du serveur (compte Animflix requis) ; un épisode n'est supprimable que par la personne qui l'a ajouté ou par l'administrateur. La page « Serveur » affiche l'espace occupé.
- **Historique Local & Reprise** : Mémorisation exacte de la position de lecture à la seconde près dans `localStorage`, avec bannière de reprise automatique.
- **Favoris Locaux Hors Ligne** : Sauvegarde d'animes favoris accessible sans compte tiers.
- **📊 Statistiques personnelles** (`#/stats`, par profil) : temps réellement regardé (total, 7 et 30 jours), épisodes terminés (à 85 %), série de jours consécutifs (en cours et record), activité des 30 derniers jours, animes et genres les plus regardés. Comptées à partir de leur installation et synchronisées entre appareils pour un compte connecté ; avec AniList lié, les statistiques de tout l'historique AniList s'y ajoutent (animes, épisodes, jours de visionnage, note moyenne, genres).
- **🛠️ Page « Serveur » (administrateur, `#/admin`)** : état de TorrServer, Nyaa, Tokyo Toshokan, Torznab et de l'API AniList (en ligne / lent / hors ligne, latence), espace disque, taille de la base et des caches, dernière sauvegarde (bouton « Sauvegarder maintenant »), notifications d'épisodes et activité (transcodages, sessions, mémoire). L'administrateur est le premier compte créé, ou les noms listés dans `ANIMFLIX_ADMINS` (`.env`, séparés par des virgules). Les réglages des sources torrent (mode, Torznab) lui sont réservés.
  - **📋 Journal des erreurs** : échecs FFmpeg / ffprobe, TorrServer injoignable, torrent sans liste de fichiers, téléchargements, notifications, agenda, sauvegardes et lectures échouées signalées par les lecteurs. Horodatage, détails (dernières lignes de FFmpeg, torrent concerné), filtre par source, compteur sur 24 h. Une erreur répétée dans les 10 min est regroupée (×N) ; seules les 500 dernières entrées sont gardées.
  - **💾 Sauvegardes** : une par jour, **vérifiée** (relue par SQLite) avant d'être gardée, avec rotation par paliers : les 7 derniers jours, une par semaine sur 4 semaines et une par mois sur 6 mois (`DATABASE_BACKUP_KEEP_DAILY`, `_WEEKLY`, `_MONTHLY` dans `.env`). Chaque sauvegarde est téléchargeable depuis la page, pour en garder une copie hors du serveur.
- **🚫 Sources signalées** : quand un torrent ne démarre pas en 60 s (« Aucun pair » / « Ne démarre pas ») ou reste illisible même en HLS, le lecteur le signale au serveur ; le bouton **🚫 Source cassée** permet aussi de le faire à la main, puis propose les autres sources. Pour tous les comptes, la source passe alors **après les autres** dans le choix automatique (fiche anime, épisode suivant, tri des résultats) et porte un badge ⚠️ dans la liste, sans être masquée. Dès que quelqu'un réussit à la lire, le signalement s'efface. Un signalement par personne et par source toutes les 6 h, oubliés après 30 jours ; les épisodes gardés sur le serveur ne sont jamais signalés.
- **🔒 Protection anti brute-force de la connexion** : 5 essais par compte (20 par adresse IP), puis blocage temporaire qui double à chaque nouvel échec (1, 2, 4, 8 puis 15 min max). Pendant le blocage, même le bon mot de passe est refusé ; le compteur s'efface après une connexion réussie ou 15 min sans échec. Derrière un proxy local (Tailscale Funnel, nginx), l'IP réelle est lue dans `X-Forwarded-For`.
- **🔔 Notifications de nouveaux épisodes (Web Push)** : *Paramètres ⚙️ → Notifications*, avec un compte Animflix lié à AniList. Toutes les 15 min, le serveur regarde les épisodes diffusés de votre liste « En cours » et cherche une source torrent dans la langue de recherche par défaut :
  - source trouvée → « Épisode N disponible » ; toujours rien 6 h après la diffusion → « Épisode N sorti » ;
  - une seule notification par épisode, rien pour un épisode déjà vu ou diffusé avant l'activation ;
  - un clic ouvre la fiche de l'anime sur l'épisode. HTTPS requis (Tailscale Funnel convient) ; sur iPhone / iPad, l'app doit être installée sur l'écran d'accueil (iOS 16.4+).
  - Variables `.env` optionnelles : `VAPID_SUBJECT` (contact, `mailto:…`), `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (sinon générées au premier démarrage et gardées dans la base), `EPISODE_NOTIFIER=off` pour couper la surveillance.

### ⚡ 8. Feedback P2P & TorrServer en Direct
- **Télémétrie en temps réel (`/api/torrserver/stats`)** :
  - Débit descendant et montant instantané (Mo/s, Ko/s).
  - Nombre de pairs actifs connectés et swarm total détecté.
  - Nombre de seeders sources disponibles.
  - Progression en pourcentage et volume du tampon de préchargement (preload buffer).
- **Écran de chargement interactif (`#player-status`)** :
  - Remplacement du simple spinner figé par des puces dynamiques en direct (Débit ⚡, Pairs 🌱, Tampon 📦 avec jauge de progression animée).
  - Messages d'état évolutifs selon la phase réelle de TorrServer (*Recherche métadonnées & pairs*, *Mise en mémoire tampon*, *Démarrage du flux*).
  - Détection proactive des torrents sans seeders avec alerte visuelle et invitation à basculer sur un autre flux ou VLC.
- **Badge HUD Flottant interactif dans le lecteur** :
  - Puce discrète avec témoin LED dynamique (Vert clignotant en streaming rapide, Jaune en buffer, Gris en veille).
  - Carte HUD popup tactile/cliquable affichant l'ensemble des métriques BitTorrent sans interrompre le visionnage.
  - Gestion optimisée des ressources : polling accéléré (1s) lors des transitions et rebuffering, allégé (2,5s) en lecture fluide, et coupure immédiate dès la fermeture du lecteur.

---

## 🏛️ Architecture Technique de l'Application

### Diagramme d'Architecture Globale

```mermaid
flowchart TB
    subgraph Client ["Client (Navigateur Web / PWA)"]
        UI["Interface Utilisateur (HTML5 / CSS3 / Vanilla JS)"]
        SW["Service Worker (sw.js - Cache Shell & Offline)"]
        Player["Lecteur Vidéo Custom (js/player/)"]
        SubEngine["Moteur Sous-titres (js/subtitles/)"]
        MediaSession["MediaSession API & Touch Gestures"]
    end

    subgraph Backend ["Serveur Node.js (animflix.js)"]
        Router["Routeur Express & Middlewares"]
        NyaaScraper["Scraper & Parser Nyaa.si (RSS/HTML)"]
        MetaService["Service Métadonnées & Affiches (TVMaze / Kitsu / TMDB)"]
        AnilistProxy["Proxy GraphQL & OAuth AniList"]
        MediaProcessor["Contrôleur de Médias (FFprobe & FFmpeg)"]
        SubExtractor["Extracteur & Convertisseur WebVTT"]
    end

    subgraph P2PEngine ["Moteur de Téléchargement P2P (Port 8090)"]
        TorrServer["TorrServer MatriX (Binaire Go Autonome)"]
        RAMCache["Cache Tampon RAM / Disque"]
    end

    subgraph External ["Services Externes"]
        Nyaa["Nyaa.si (Réseau BitTorrent)"]
        AniListAPI["AniList GraphQL API"]
        TVMaze["TVMaze API"]
        Kitsu["Kitsu API"]
        TMDB["The Movie Database (TMDB)"]
    end

    %% Interactions Client <-> Backend
    UI <-->|APIs HTTP et JSON| Router
    SW -.->|Mise en cache statique| UI
    Player <-->|Flux Video HTTP Range| Router
    Player <-->|Pistes WebVTT synchronisees| SubExtractor
    Player <--> MediaSession

    %% Interactions Backend <-> Moteur P2P
    MediaProcessor <-->|Flux HTTP Interne| TorrServer
    Router <-->|Gestion et Purge des Torrents| TorrServer

    %% Interactions Backend <-> Externes
    NyaaScraper <-->|Scraping Magnets et Torrents| Nyaa
    AnilistProxy <-->|Requetes GraphQL et OAuth| AniListAPI
    MetaService <-->|Requetes REST Jaquettes| TVMaze
    MetaService <-->|Fallback Metadonnees Kitsu| Kitsu
    MetaService <-->|Fallback Metadonnees TMDB| TMDB

    %% TorrServer P2P Swarm
    TorrServer <-->|Echanges P2P BitTorrent| Nyaa
```

---

### Flux de Données & Streaming

```mermaid
sequenceDiagram
    autonumber
    actor User as Utilisateur
    participant Browser as Navigateur (Client PWA)
    participant Server as Serveur Express (animflix.js)
    participant Torr as TorrServer (Port 8090)
    participant FFmpeg as Moteur FFprobe / FFmpeg

    User->>Browser: Recherche un anime ou clique sur Découverte
    Browser->>Server: GET /api/search?q=...&type=vostfr
    Server->>Server: Scraping Nyaa + Récupération jaquettes (TVMaze/Kitsu)
    Server-->>Browser: Liste JSON des torrents filtrés et enrichis

    User->>Browser: Sélectionne un épisode ou torrent
    Browser->>Server: GET /api/play-sync?magnet=...&fileIndex=...&offset=...
    Server->>Torr: Charge le torrent en mémoire P2P
    Server->>FFmpeg: FFprobe analyse les flux (vidéo, audio, sous-titres)
    Server->>FFmpeg: Extrait la piste de sous-titres en WebVTT
    Server-->>Browser: Réponse Sync (Keyframe offset, durée, pistes audio et sous-titres)

    Browser->>Browser: Configure le lecteur, charge la piste VTT et initialise MediaSession
    Browser->>Server: GET /api/stream?mode=direct&offset=...
    Server->>Torr: Récupère les octets P2P
    alt Mode Direct (0% CPU)
        Server-->>Browser: Flux MP4 brut par morceaux (HTTP 206 Partial Content)
    else Mode Transcodage
        Server->>FFmpeg: Transcodage H.264 / AAC multithread
        FFmpeg-->>Browser: Flux vidéo transcodé en continu
    end

    Note over Browser,Server: Progression à 85% : Mise à jour automatique AniList + Historique local
```

---

### Organisation Modulaire des Fichiers

```
ServeurAnimeTorr/
├── animflix.js               # Serveur Express, APIs REST, streaming, proxy AniList, FFmpeg
├── TorrServer-linux-amd64    # Binaire serveur BitTorrent autonome (TorrServer MatriX)
├── ecosystem.config.cjs      # Fichier d'orchestration pour le gestionnaire PM2
├── Dockerfile                # Image de conteneurisation optimisée (Node.js + FFmpeg + TorrServer)
├── docker-compose.yml        # Déploiement multi-services Docker Compose
├── package.json              # Dépendances Node.js (express, axios, xml2js, cors, etc.)
│
├── public/                   # Frontend SPA & PWA (servi par Express)
│   ├── index.html            # Structure HTML5 (Catalogue, Lecteur, Modales, Bannières)
│   ├── manifest.json         # Manifeste PWA (icônes, orientation, raccourcis d'application)
│   ├── sw.js                 # Service Worker (stratégie de cache pour mode hors-ligne)
│   │
│   ├── css/
│   │   ├── style.css         # Thème global, grille, bannières, filtres & modales
│   │   ├── player.css        # Lecteur vidéo personnalisé, scrubber timeline, styles VTT
│   │   └── anilist.css       # Widgets AniList, onglet Découverte, badges de statut
│   │
│   ├── js/                   # Scripts classiques (portée globale partagée) — ORDRE de chargement
│   │   │                     # fixé dans index.html et repris dans le pré-cache de sw.js
│   │   ├── auth.js           # Comptes Animflix, session
│   │   ├── app.js            # État global, utilitaires (escapeHtml, jsArg), PWA, réglages
│   │   ├── ui.js             # Dialogues (uiConfirm / uiAlert), squelettes de chargement, affiche de repli
│   │   ├── subtitles/        # libass (JASSUB), WebVTT, piste panneaux, polices, pistes, styles
│   │   ├── player/           # Contrôles, sync audio, AniSkip, épisode suivant, PiP/vitesse/boost,
│   │   │                     # MediaSession, stats P2P, streaming/HLS, timeline, Cast/téléchargement
│   │   ├── history.js        # Historique local, reprise de lecture, onglets, favoris
│   │   ├── sync.js           # Synchro multi-appareils (historique, reprise, favoris, profils) si connecté
│   │   ├── release-prefs.js  # Groupes de release / résolution préférés (tri « Mes préférences »)
│   │   ├── search.js         # Recherche Nyaa, filtrage & tri, analyse des packs d'épisodes
│   │   ├── anilist/          # Session & GraphQL, Découverte, Planning, Accueil, liste En cours, suivi,
│   │   │                     # fiche anime (anime-page.js : épisodes, choix automatique du torrent)
│   │   ├── router.js         # Routes dans le hash (#/anime/…, #/watch/…), précédent/suivant, F5
│   │   └── tv.js             # Navigation manette / TV
│   │
│   └── icons/                # Icônes de l'application PWA (SVG, PNG standard & maskable)
│
└── cache/                    # Répertoire temporaire (sous-titres extraits .vtt, logs TorrServer)
```

---

## 📦 Prérequis Système

- **Système d'exploitation** : Linux (Ubuntu, Debian, Arch, CentOS), macOS ou Windows (via WSL2).
- **Node.js** : Version 18.0.0 ou supérieure.
- **FFmpeg & FFprobe** : Indispensables pour l'analyse des flux et l'extraction de sous-titres.
  ```bash
  # Debian / Ubuntu / Raspberry Pi OS
  sudo apt update && sudo apt install -y ffmpeg

  # Arch Linux
  sudo pacman -S ffmpeg

  # macOS (Homebrew)
  brew install ffmpeg
  ```

---

## 🔧 Installation & Configuration

### 1. Cloner et installer les dépendances

```bash
git clone https://github.com/votre-compte/ServeurAnimeTorr.git
cd ServeurAnimeTorr
npm install
```

### 2. Rendre le binaire TorrServer exécutable

```bash
chmod +x TorrServer-linux-amd64
```

### 3. (Optionnel) Configuration AniList OAuth

Pour activer l'authentification officielle AniList :
1. Créez une application sur [AniList Developer Settings](https://anilist.co/settings/developer).
2. Définissez le Redirect URI sur votre URL d'accès (ex: `http://localhost:3000` ou `http://192.168.1.50:3000`).
3. Renseignez votre `Client ID` directement dans l'interface de l'application via le bouton **Paramètres ⚙️**.

---

## 🚀 Déploiement & Lancement

### Option A : PM2 (Recommandé en Production)

PM2 garantit une exécution continue en tâche de fond avec redémarrage automatique en cas d'erreur ou au redémarrage de la machine.

```bash
# 1. Installer PM2 globalement
sudo npm install -g pm2

# 2. Démarrer les services avec le fichier ecosystem fourni
pm2 start ecosystem.config.cjs

# 3. Sauvegarder pour le démarrage automatique au boot
pm2 save
pm2 startup
```

**Commandes utiles au quotidien :**
```bash
pm2 status               # Afficher l'état d'Animflix et TorrServer
pm2 logs animflix        # Consulter les logs en temps réel
pm2 restart animflix     # Redémarrer l'application
pm2 restart all          # Redémarrer tous les services
pm2 stop all             # Arrêter les services
```

---

### Option B : Docker & Docker-Compose

Un environnement conteneurisé prêt à l'emploi est disponible :

```bash
# Démarrer en arrière-plan
docker compose up -d

# Voir les logs
docker compose logs -f

# Arrêter
docker compose down
```

---

### Option C : Lancement Manuel (Développement)

Dans deux terminaux distincts :

```bash
# Terminal 1 : Lancement du moteur P2P TorrServer
./TorrServer-linux-amd64

# Terminal 2 : Lancement du serveur d'application Animflix
npm start
```

---

## 🖥️ Guide d'Utilisation

1. **Accès à l'application** :
   - Depuis le serveur : [http://localhost:3000](http://localhost:3000)
   - Depuis un autre appareil sur le même réseau local (smartphone, tablette, TV) : `http://<IP_DU_SERVEUR>:3000` (ex: `http://192.168.1.45:3000`).
2. **Page d'Accueil & Découverte** :
   - Explorez les tendances et la saison en cours dès l'ouverture.
   - Si vous connectez votre compte AniList, l'onglet **🍿 AniList En cours** se synchronise instantanément.
   - Cliquez sur une carte pour ouvrir la **fiche de l'anime**.
3. **Fiche Anime** :
   - Le gros bouton lance l'épisode à reprendre ou le suivant ; un clic sur une tuile lance cet épisode.
   - Le meilleur torrent est choisi selon vos préférences de release ; **📋 Choisir la source** affiche la liste complète.
   - Copiez l'URL pour partager la fiche, ou utilisez le bouton Précédent du navigateur pour revenir en arrière.
4. **Recherche & Filtres** :
   - Saisissez le nom d'un anime : les fiches AniList correspondantes apparaissent au-dessus des torrents.
   - Filtrez par langue (VOSTFR, VF, Multi-Sub, VOSTA) et affinez avec les chips de résolution (`1080p`, `720p`, `Packs`).
5. **Lecture & Gestion d'Épisodes** :
   - Choisissez le mode de lecture (Direct ou Transcodage).
   - Pour les packs complets, sélectionnez l'épisode souhaité dans la liste.
6. **Personnalisation & Confort** :
   - Personnalisez le rendu visuel des sous-titres via le bouton **`🎨 Style`**.
   - Activez le **Boost Vocal** si les voix sont masquées par les effets sonores.
   - Utilisez **`🧹 Nettoyer le cache`** pour libérer la mémoire vive du moteur P2P si besoin.

---

## 🎮 Contrôles, Gestes & Raccourcis

### 📱 Gestes Tactiles Mobile & Tablette

| Geste sur l'écran | Action | Zone d'Effet |
| :--- | :--- | :--- |
| **Tap Simple** | 👁️ Afficher ou masquer les contrôles (auto-masquage après 4,5s) | Tout l'écran |
| **Double-Tap Gauche** | ⏪ Reculer de **-10s** (cumulatif : -20s, -30s...) | Tiers gauche (< 35% largeur) |
| **Double-Tap Milieu** | ⏯️ **Mettre en Pause / Relancer la vidéo** (avec feedback visuel) | Zone centrale (35% à 65%) |
| **Double-Tap Droite** | ⏩ Avancer de **+10s** (cumulatif : +20s, +30s...) | Tiers droit (> 65% largeur) |
| **Plein Écran Mobile** | 🔄 Verrouillage automatique en mode **Paysage** | Bouton ⛶ ou bascule native |

---

### ⌨️ Raccourcis Clavier Desktop

| Touche | Action |
| :---: | :--- |
| <kbd>Espace</kbd> | Lecture / Pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Reculer / Avancer de **10 secondes** |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Augmenter / Diminuer le volume sonore (+5% / -5%) |
| <kbd>M</kbd> | Couper / Réactiver le son (Mute) |
| <kbd>C</kbd> | Activer / Désactiver les sous-titres (CC ON / OFF) |
| <kbd>S</kbd> | Ouvrir / Fermer le menu de style et synchronisation des sous-titres |
| <kbd>G</kbd> / <kbd>H</kbd> | Ajuster la **synchronisation des sous-titres** (-0.1s / +0.1s) |
| <kbd>J</kbd> / <kbd>K</kbd> | Ajuster la **synchronisation de la piste audio** (-0.1s / +0.1s) |
| <kbd>F</kbd> | Basculer en mode Plein écran |
| <kbd>Échap</kbd> | Quitter le plein écran, fermer les modales et dialogues, ou revenir à la vue précédente (fiche, résultats…) |

---

## ❓ Dépannage & FAQ

<details>
<summary><b>1. Les sous-titres ou le son ont un léger décalage ?</b></summary>
Certains encodages de torrents possèdent un délai audio/texte intrinsèque. Utilisez simplement les touches <kbd>G</kbd> / <kbd>H</kbd> pour caler les sous-titres et <kbd>J</kbd> / <kbd>K</kbd> pour l'audio au dixième de seconde près. Le réglage est conservé durant tout le visionnage.
</details>

<details>
<summary><b>2. La vidéo saccade ou le processeur monte à 100% ?</b></summary>
Passez le mode de lecture en <b>⚡ Lecture Directe</b>. Ce mode effectue une copie brute du flux vidéo sans solliciter le processeur (0% CPU). Si votre matériel ne supporte pas le codec de base, vous pouvez également cliquer sur <b>🟠 Ouvrir dans VLC</b> pour déléguer le décodage au lecteur VLC externe.
</details>

<details>
<summary><b>3. TorrServer sature la mémoire RAM ?</b></summary>
Cliquez sur le bouton <b>`🧹`</b> dans la barre de navigation pour vider le cache en mémoire vive. De plus, Animflix purge automatiquement le torrent de la mémoire dès que vous fermez la fiche de lecture.
</details>

<details>
<summary><b>4. Comment installer l'application sur smartphone (PWA) ?</b></summary>
Ouvrez l'adresse de votre serveur sur Chrome (Android) ou Safari (iOS). Cliquez sur <b>"Installer l'application"</b> (ou <i>Partager > Sur l'écran d'accueil</i> sur iOS). Animflix s'ouvrira alors en plein écran comme une application native sans barre d'adresse.
</details>

---

<p align="center">
  Développé pour les passionnés d'anime 🍿
</p>