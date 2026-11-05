// =========================================================================
// --- ANIMFLIX SERVICE WORKER (PWA SHELL, OFFLINE CACHE & STREAM BYPASS) ---
// =========================================================================

// {{ASSET_VERSION}} est remplacé par le serveur (empreinte du contenu de public/) :
// toute modification du front change le service worker, qui purge alors l'ancien cache.
const CACHE_NAME = 'animflix-shell-{{ASSET_VERSION}}';

const PRECACHE_ASSETS = [
  '/',
  '/vendor/hls.min.js',
  '/css/style.css',
  '/css/player.css',
  '/css/anilist.css',
  '/css/tv.css',
  '/js/auth.js',
  '/js/app.js',
  '/js/ui.js',
  '/js/subtitles/libass.js',
  '/js/subtitles/vtt.js',
  '/js/subtitles/signs.js',
  '/js/subtitles/jassub.js',
  '/js/subtitles/tracks.js',
  '/js/subtitles/style.js',
  '/js/player/controls.js',
  '/js/player/audio-sync.js',
  '/js/player/aniskip.js',
  '/js/player/next-episode.js',
  '/js/player/features.js',
  '/js/player/media-session.js',
  '/js/player/p2p-stats.js',
  '/js/player/streaming.js',
  '/js/player/init-controls.js',
  '/js/player/cast.js',
  '/js/history.js',
  '/js/sync.js',
  '/js/release-prefs.js',
  '/js/search.js',
  '/js/anilist/core.js',
  '/js/anilist/discover.js',
  '/js/anilist/schedule.js',
  '/js/anilist/home.js',
  '/js/anilist/watching.js',
  '/js/anilist/session.js',
  '/js/anilist/tracking.js',
  '/js/anilist/anime-page.js',
  '/js/router.js',
  '/js/tv.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png'
];

// Installation : Mise en cache des ressources d'interface statiques
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
      .catch((err) => {
        console.warn('[SW] Pré-cache incomplet (serveur local en démarrage) :', err);
      })
  );
});

// Activation : Nettoyage des anciens caches et prise de contrôle immédiate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Interception des requêtes : Protection absolue des flux multimédias P2P & Streaming
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. NE JAMAIS INTERCEPTER les requêtes non-GET ou les flux streaming vidéo / TorrServer
  if (req.method !== 'GET') return;

  // Contournement strict du cache pour tout flux vidéo, HLS, miniatures, téléchargement ou API TorrServer
  if (
    url.pathname.startsWith('/play') ||
    url.pathname.startsWith('/stream') ||
    url.pathname.startsWith('/api/hls/') ||
    url.pathname.startsWith('/api/thumbnail') ||
    url.pathname.startsWith('/api/download') ||
    url.pathname.startsWith('/api/subtitles') ||
    url.pathname.startsWith('/api/fonts') ||
    url.pathname.startsWith('/api/play-sync') ||
    url.pathname.startsWith('/api/torrserver') ||
    url.pathname.startsWith('/vendor/jassub/') ||
    url.pathname.endsWith('.wasm') ||
    url.port === '8090' ||
    req.headers.has('range')
  ) {
    // Laisser passer directement au réseau natif sans toucher aux Range headers
    return;
  }

  // 2. Requêtes de navigation (HTML principal) : Réseau en priorité, repli sur le cache
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return networkRes;
        })
        .catch(() => caches.match('/', { ignoreSearch: true }) || caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // 3. Ressources statiques (CSS, JS, Vendor, Icônes) : Stale-While-Revalidate
  if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/vendor/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(
      caches.match(req, { ignoreSearch: true }).then((cachedRes) => {
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              const resClone = networkRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
            }
            return networkRes;
          })
          .catch(() => cachedRes);

        return cachedRes || fetchPromise;
      })
    );
    return;
  }

  // 4. Par défaut : Réseau avec secours cache si disponible
  event.respondWith(
    fetch(req).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
