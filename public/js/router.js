// =========================================================================
// --- ANIMFLIX ROUTER (URLS PARTAGEABLES, BOUTON RETOUR, RAFRAÎCHISSEMENT) ---
// =========================================================================
//
// Routes (dans le hash, pour rester compatible avec le service worker et le serveur) :
//   #/                      accueil (onglet Accueil)
//   #/discover | #/schedule | #/anilist | #/history | #/favorites   onglets de l'accueil
//   #/search?q=Frieren&type=vostfr                                   résultats Nyaa
//   #/anime/154587[?ep=5]                                            fiche anime AniList
//   #/watch/<infohash>/<fileIndex>                                   lecteur
//
// Principe : les vues mettent l'URL à jour avec AppRouter.sync() (sans re-rendu),
// et le bouton précédent/suivant du navigateur passe par dispatch() pour afficher la vue.

(function () {
    const HOME_TABS = ['discover', 'schedule', 'anilist', 'history', 'favorites', 'stats', 'admin'];
    const TORRENT_CACHE_KEY = 'animflix_route_torrents';
    const STACK_KEY = 'animflix_route_stack';

    let depth = 0;
    let stack = [];
    let dispatching = false;

    try {
        const saved = JSON.parse(sessionStorage.getItem(STACK_KEY) || '[]');
        if (Array.isArray(saved)) stack = saved;
    } catch (e) {}

    function saveStack() {
        try { sessionStorage.setItem(STACK_KEY, JSON.stringify(stack.slice(0, depth + 1).slice(-60))); } catch (e) {}
    }

    function currentPath() {
        const hash = window.location.hash || '';
        return hash.startsWith('#/') ? hash.substring(1) : '/';
    }

    function parse(path) {
        const [pathname, queryString] = String(path || '/').split('?');
        const query = Object.fromEntries(new URLSearchParams(queryString || ''));
        const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);

        if (parts.length === 0) return { name: 'home', tab: 'home', query };
        if (HOME_TABS.includes(parts[0])) return { name: 'home', tab: parts[0], query };
        if (parts[0] === 'search') return { name: 'search', query };
        if (parts[0] === 'anime' && /^\d+$/.test(parts[1] || '')) {
            return { name: 'anime', id: parseInt(parts[1], 10), query };
        }
        if (parts[0] === 'watch' && /^[a-z0-9]{32,40}$/i.test(parts[1] || '')) {
            return { name: 'watch', hash: parts[1].toLowerCase(), fileIndex: parseInt(parts[2], 10) || 1, query };
        }
        return { name: 'home', tab: 'home', query };
    }

    // --- CONSTRUCTEURS D'URL ---

    function homePath(tab) {
        return (!tab || tab === 'home') ? '/' : '/' + tab;
    }

    function searchPath(q, type) {
        const params = new URLSearchParams();
        if (q) params.set('q', q);
        if (type && type !== 'vostfr') params.set('type', type);
        return '/search' + (params.toString() ? '?' + params.toString() : '');
    }

    function animePath(id, ep) {
        return '/anime/' + Number(id) + (ep ? '?ep=' + Number(ep) : '');
    }

    function watchPath(magnet, fileIndex) {
        const hash = (typeof extractTorrentHash === 'function') ? extractTorrentHash(magnet) : null;
        if (!hash || hash === 'unknown') return null;
        return '/watch/' + hash + '/' + (fileIndex || 1);
    }

    // --- HISTORIQUE ---

    function writeState(path, replace) {
        const url = window.location.pathname + window.location.search + '#' + path;
        if (replace) {
            stack[depth] = path;
            history.replaceState({ animflix: true, depth }, '', url);
        } else {
            depth += 1;
            stack = stack.slice(0, depth);
            stack[depth] = path;
            history.pushState({ animflix: true, depth }, '', url);
        }
        saveStack();
    }

    /** Met l'URL en accord avec la vue déjà affichée (aucun rendu). */
    function sync(path, opts = {}) {
        if (!path || dispatching) return;
        if (path === currentPath()) return;
        writeState(path, !!opts.replace);
    }

    /** Navigue vers une route et l'affiche. */
    function go(path, opts = {}) {
        if (path !== currentPath()) writeState(path, !!opts.replace);
        dispatch(parse(path));
    }

    function previousPath() {
        return depth > 0 ? stack[depth - 1] : null;
    }

    /** Retour arrière dans l'app (ou repli si la page a été ouverte directement). */
    function back(fallback = '/') {
        if (depth > 0) {
            history.back();
        } else {
            go(fallback, { replace: true });
        }
    }

    // --- TORRENTS MÉMORISÉS POUR RESTAURER #/watch APRÈS RAFRAÎCHISSEMENT ---

    function rememberTorrent(torrent) {
        if (!torrent || !torrent.lienMagnet || typeof extractTorrentHash !== 'function') return;
        const hash = extractTorrentHash(torrent.lienMagnet);
        if (!hash || hash === 'unknown') return;
        try {
            const map = JSON.parse(sessionStorage.getItem(TORRENT_CACHE_KEY) || '{}');
            map[hash] = { ...torrent, _savedAt: Date.now() };
            const entries = Object.entries(map).sort((a, b) => (b[1]._savedAt || 0) - (a[1]._savedAt || 0)).slice(0, 30);
            sessionStorage.setItem(TORRENT_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)));
        } catch (e) {}
    }

    function findTorrentByHash(hash) {
        try {
            const map = JSON.parse(sessionStorage.getItem(TORRENT_CACHE_KEY) || '{}');
            if (map[hash]) return map[hash];
        } catch (e) {}

        // Historique de lecture (persistant) : suffisant pour relancer le flux
        const hist = (typeof getPlaybackHistory === 'function') ? getPlaybackHistory() : [];
        const h = hist.find(item => item.magnet && extractTorrentHash(item.magnet) === hash);
        if (h) {
            return {
                titre: h.rawTitle || h.animeName,
                animeName: h.animeName,
                season: h.season,
                episode: h.episode,
                resolution: h.resolution,
                audioLang: h.audioLang,
                lienMagnet: h.magnet,
                taille: h.taille,
                seeders: h.seeders,
                poster: h.poster,
                rating: h.rating
            };
        }
        return null;
    }

    // --- ÉTAT DES VUES ---

    function isDetailOpen() {
        const v = document.getElementById('detailView');
        return !!v && v.style.display !== 'none';
    }

    function catalogSubView() {
        const anime = document.getElementById('animeView');
        if (anime && anime.style.display !== 'none') return 'anime';
        const search = document.getElementById('searchView');
        if (search && search.style.display !== 'none') return 'search';
        return 'home';
    }

    /** Chemin correspondant à ce qu'affiche le catalogue (sous la vue lecteur). */
    function catalogPath() {
        const sub = catalogSubView();
        if (sub === 'anime' && window._currentAnimePageId) return animePath(window._currentAnimePageId);
        if (sub === 'search' && window._lastSearchRoute) return window._lastSearchRoute;
        const tab = (typeof getActiveHomeTab === 'function') ? getActiveHomeTab() : 'home';
        return homePath(tab);
    }

    /** Appelé quand le lecteur se ferme par l'UI (bouton Retour, Échap, télécommande). */
    function leaveWatch() {
        if (!currentPath().startsWith('/watch/')) return;
        const prev = previousPath();
        if (prev && !prev.startsWith('/watch/')) {
            history.back();
        } else {
            sync(catalogPath(), { replace: true });
        }
    }

    // --- AFFICHAGE D'UNE ROUTE ---

    function dispatch(route) {
        dispatching = true;
        try {
            if (route.name !== 'watch' && isDetailOpen() && typeof closeDetailView === 'function') {
                closeDetailView({ navigate: false });
            }

            if (route.name === 'home') {
                const input = document.getElementById('searchInput');
                if (input) input.value = '';
                if (typeof switchHomeTab === 'function') switchHomeTab(route.tab, { syncUrl: false });
            } else if (route.name === 'search') {
                const q = (route.query.q || '').trim();
                const type = route.query.type || 'vostfr';
                if (!q) {
                    if (typeof showHomeScreen === 'function') showHomeScreen({ syncUrl: false });
                } else {
                    const input = document.getElementById('searchInput');
                    if (input) input.value = q;
                    const typeSel = document.getElementById('searchType');
                    if (typeSel) typeSel.value = type;
                    const routeKey = searchPath(q, type);
                    if (window._renderedSearchRoute === routeKey && (window._currentRawTorrents || []).length > 0) {
                        // Résultats encore en mémoire : simple ré-affichage, pas de nouvelle requête Nyaa
                        if (typeof showCatalogSubView === 'function') showCatalogSubView('search');
                    } else if (typeof executeSearchForAnime === 'function') {
                        const target = (typeof currentTargetNextEpisode !== 'undefined') ? currentTargetNextEpisode : null;
                        const keepTarget = target && [target.searchTitle, target.animeName, target.english, target.romaji]
                            .some(t => t && t.toLowerCase() === q.toLowerCase());
                        executeSearchForAnime(q, keepTarget ? target : null);
                    }
                }
            } else if (route.name === 'anime') {
                if (typeof openAnimePage === 'function') {
                    openAnimePage(route.id, { ep: parseInt(route.query.ep, 10) || null, syncUrl: false });
                }
            } else if (route.name === 'watch') {
                const playing = (typeof currentActiveMagnet !== 'undefined' && currentActiveMagnet)
                    ? extractTorrentHash(currentActiveMagnet) : null;
                const playingIndex = (typeof currentActiveFileIndex !== 'undefined') ? currentActiveFileIndex : 1;
                if (isDetailOpen() && playing === route.hash && playingIndex === route.fileIndex) return;

                let torrent = findTorrentByHash(route.hash);
                if (!torrent) {
                    // Inconnu localement (lien partagé) : un magnet minimal suffit à TorrServer via la DHT
                    torrent = {
                        titre: 'Torrent ' + route.hash.substring(0, 8),
                        lienMagnet: 'magnet:?xt=urn:btih:' + route.hash +
                            '&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce',
                        seeders: 0
                    };
                    if (typeof showToast === 'function') showToast('🔗 Torrent inconnu de cet appareil : connexion aux pairs…');
                }
                if (isDetailOpen() && typeof closeDetailView === 'function') closeDetailView({ navigate: false });
                if (typeof openAnimeDetail === 'function') openAnimeDetail(torrent, route.fileIndex, 0);
            }
        } finally {
            dispatching = false;
        }
    }

    function onPopState(e) {
        const state = e.state;
        depth = (state && state.animflix && typeof state.depth === 'number') ? state.depth : 0;
        if (window.location.hash && !window.location.hash.startsWith('#/')) return; // ex. retour OAuth AniList
        dispatch(parse(currentPath()));
    }

    function init() {
        const hash = window.location.hash || '';
        const state = history.state;
        depth = (state && state.animflix && typeof state.depth === 'number') ? state.depth : 0;

        window.addEventListener('popstate', onPopState);

        if (!hash.startsWith('#/')) {
            // Pas de route (ou ancien #detail) : on part de l'accueil sans toucher aux autres hashs (OAuth)
            if (!hash || hash === '#detail') {
                stack = ['/'];
                history.replaceState({ animflix: true, depth: 0 }, '', window.location.pathname + window.location.search);
                saveStack();
            }
            return;
        }

        const path = currentPath();
        stack[depth] = path;
        history.replaceState({ animflix: true, depth }, '', window.location.href);
        saveStack();

        const route = parse(path);
        if (route.name === 'home' && route.tab === 'home') return; // rendu par défaut de initApp
        dispatch(route);
    }

    window.AppRouter = {
        parse, go, sync, back, leaveWatch, dispatch,
        homePath, searchPath, animePath, watchPath,
        rememberTorrent, catalogPath, isDetailOpen, catalogSubView,
        currentPath, previousPath
    };

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
