// =========================================================================
// --- ANIMFLIX SERVICE WORKER (PWA SHELL, OFFLINE CACHE & STREAM BYPASS) ---
// =========================================================================

const CACHE_NAME = 'animflix-shell-v1.0.0';

const PRECACHE_ASSETS = [
  '/',
  '/css/style.css',
  '/css/player.css',
  '/css/anilist.css',
  '/js/app.js',
  '/js/subtitles.js',
  '/js/player.js',
  '/js/history.js',
  '/js/search.js',
  '/js/anilist.js',
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

  // Contournement strict du cache pour tout flux vidéo, sous-titres temps réel ou API TorrServer
  if (
    url.pathname.startsWith('/play') ||
    url.pathname.startsWith('/stream') ||
    url.pathname.startsWith('/api/subtitles') ||
    url.pathname.startsWith('/api/play-sync') ||
    url.pathname.startsWith('/api/torrserver') ||
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
        .catch(() => caches.match('/') || caches.match(req))
    );
    return;
  }

  // 3. Ressources statiques (CSS, JS, Icônes) : Stale-While-Revalidate
  if (
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json'
  ) {
    event.respondWith(
      caches.match(req).then((cachedRes) => {
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
    fetch(req).catch(() => caches.match(req))
  );
});
