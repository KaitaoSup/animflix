// =========================================================================
// --- ANIMFLIX SERVICE WORKER (PWA SHELL, OFFLINE CACHE & STREAM BYPASS) ---
// =========================================================================

// {{ASSET_VERSION}} est remplacé par le serveur (empreinte du contenu de public/) :
// toute modification du front change le service worker, qui purge alors l'ancien cache.
const CACHE_NAME = 'animflix-shell-{{ASSET_VERSION}}';

// Page affichée quand le serveur est injoignable (PC éteint, Node arrêté → 502 de Tailscale Funnel)
const OFFLINE_URL = '/offline.html';

const PRECACHE_ASSETS = [
  '/',
  '/offline.html',
  '/vendor/hls.min.js',
  '/css/style.css',
  '/css/player.css',
  '/css/anilist.css',
  '/css/tv.css',
  '/js/theme.js',
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
  '/js/stats.js',
  '/js/admin.js',
  '/js/downloads.js',
  '/js/calendar-export.js',
  '/js/sync.js',
  '/js/notifications.js',
  '/js/release-prefs.js',
  '/js/search.js',
  '/js/anilist/core.js',
  '/js/anilist/discover.js',
  '/js/anilist/schedule.js',
  '/js/anilist/home.js',
  '/js/anilist/watching.js',
  '/js/anilist/session.js',
  '/js/anilist/tracking.js',
  '/js/anilist/list-entry.js',
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

const GATEWAY_ERROR_STATUSES = new Set([502, 503, 504]);

// Page hors ligne depuis le cache (statut 503 pour que le navigateur ne la prenne pas pour la vraie page)
async function offlineResponse() {
  const cached = await caches.match(OFFLINE_URL);
  if (cached) {
    return new Response(cached.body, {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
  return new Response(
    '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Animflix – Serveur hors ligne</title>' +
    '<body style="background:#141414;color:#fff;font-family:sans-serif;text-align:center;padding:60px 16px">' +
    '<h1 style="color:#e50914">ANIMFLIX</h1><p>Le serveur Animflix est hors ligne.</p>' +
    '<button onclick="location.reload()">Réessayer</button></body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

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

  // Sonde de disponibilité utilisée par offline.html : toujours réseau, jamais de cache
  if (url.pathname === '/api/ping') return;

  // 2. Requêtes de navigation (HTML principal) : Réseau en priorité, page hors ligne en secours
  //    - échec réseau (PC éteint, Tailscale coupé) → offline.html
  //    - 502/503/504 (Tailscale Funnel ne joint plus le serveur Node) → offline.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (GATEWAY_ERROR_STATUSES.has(networkRes.status)) {
            return offlineResponse();
          }
          if (networkRes.status === 200) {
            const resClone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
          }
          return networkRes;
        })
        .catch(() => offlineResponse())
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

// =========================================================================
// --- NOTIFICATIONS PUSH (NOUVEAUX ÉPISODES) ---
// =========================================================================

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Animflix';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: data.icon || '/icons/icon-192.png',
      badge: '/icons/icon-maskable-192.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      data: { url: data.url || '/#/', mediaId: data.mediaId || null, episode: data.episode || null }
    })
  );
});

// Clic : fiche de l'anime sur l'épisode concerné, dans l'onglet / la PWA déjà ouverte si possible
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { url = '/#/', mediaId = null, episode = null } = event.notification.data || {};
  const target = new URL(url, self.location.origin).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(c => new URL(c.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      client.postMessage({ type: 'animflix-notification-open', url: target, mediaId, episode });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
