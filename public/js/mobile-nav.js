// =========================================================================
// --- NAVIGATION TÉLÉPHONE : BARRE D'ONGLETS DU BAS, MENU « PLUS », EN-TÊTE ---
// =========================================================================
//
// Affichée uniquement sous 680 px (css/mobile.css). Elle réutilise les onglets
// de l'accueil (switchHomeTab) : aucune logique de vue n'est dupliquée ici.
//   - classe body.m-watching quand le lecteur est ouvert (barre et en-tête masqués)
//   - classe body.m-header-hidden quand on fait défiler vers le bas

(function () {
    const PHONE_QUERY = window.matchMedia('(max-width: 680px)');
    const PRIMARY_TABS = ['home', 'discover', 'schedule', 'history'];

    const ICONS = {
        home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
        discover: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
        schedule: '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
        history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
        more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
    };

    function icon(name) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    }

    function isShown(id) {
        const el = document.getElementById(id);
        return !!el && el.style.display !== 'none';
    }

    function activeHomeTab() {
        return (typeof getActiveHomeTab === 'function') ? getActiveHomeTab() : 'home';
    }

    // --- BARRE D'ONGLETS ---

    function buildTabBar() {
        const bar = document.getElementById('mobileTabBar');
        if (!bar) return null;
        const tabs = [
            { id: 'home', label: 'Accueil' },
            { id: 'discover', label: 'Découvrir' },
            { id: 'schedule', label: 'Planning' },
            { id: 'history', label: 'Historique' },
            { id: 'more', label: 'Plus' }
        ];
        bar.innerHTML = tabs.map(t => `
            <button type="button" class="m-tab" data-tab="${t.id}" aria-label="${t.label}">
                ${icon(t.id)}<span class="m-tab-label">${t.label}</span>
            </button>
        `).join('');
        bar.addEventListener('click', (e) => {
            const btn = e.target.closest('.m-tab');
            if (!btn) return;
            const tab = btn.dataset.tab;
            if (tab === 'more') {
                openMoreSheet();
                return;
            }
            goToTab(tab);
        });
        return bar;
    }

    function goToTab(tab) {
        closeMoreSheet();
        const alreadyThere = isShown('homeView') && isShown('catalogView') && !isShown('detailView') && activeHomeTab() === tab;
        if (alreadyThere) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        if (isShown('detailView') && typeof closeDetailView === 'function') closeDetailView();
        if (typeof switchHomeTab === 'function') switchHomeTab(tab);
        window.scrollTo({ top: 0 });
        showHeader();
    }

    // --- MENU « PLUS » ---

    function moreItems() {
        const hasAnilist = !!(localStorage.getItem('anilist_token') && typeof currentAnilistUser !== 'undefined' && currentAnilistUser);
        const loggedIn = typeof currentAnimflixUser !== 'undefined' && !!currentAnimflixUser;
        const isAdmin = typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin();
        const favCount = (typeof getFavorites === 'function') ? getFavorites().length : 0;
        const anilistCount = (typeof anilistWatchingList !== 'undefined' && anilistWatchingList) ? anilistWatchingList.length : 0;
        const keptCount = (typeof serverDownloads !== 'undefined' && serverDownloads.items) ? serverDownloads.items.length : 0;
        const pwaBtn = document.getElementById('pwaInstallBtn');

        const sections = [
            {
                title: 'Ma bibliothèque',
                items: [
                    { tab: 'anilist', icon: '🍿', label: hasAnilist ? 'AniList en cours' : 'Connexion AniList', badge: hasAnilist ? anilistCount : 0 },
                    { tab: 'favorites', icon: '❤️', label: 'Favoris', badge: favCount },
                    loggedIn && { tab: 'downloads', icon: '💾', label: 'Sur le serveur', badge: keptCount },
                    { tab: 'stats', icon: '📊', label: 'Statistiques' },
                    isAdmin && { tab: 'admin', icon: '🛠️', label: 'Serveur' }
                ]
            },
            {
                title: 'Application',
                items: [
                    { action: 'settings', icon: '⚙️', label: 'Paramètres' },
                    { action: 'tv', icon: '📺', label: 'Mode TV' },
                    { action: 'cache', icon: '🧹', label: 'Purger le cache' },
                    pwaBtn && pwaBtn.style.display !== 'none' && { action: 'install', icon: '📲', label: "Installer l'app" }
                ]
            }
        ];

        const current = isShown('homeView') ? activeHomeTab() : null;
        return sections.map(sec => `
            <div class="m-sheet-title">${sec.title}</div>
            <div class="m-sheet-grid">
                ${sec.items.filter(Boolean).map(it => `
                    <button type="button" class="m-sheet-item ${it.tab && it.tab === current ? 'active' : ''}" ${it.tab ? `data-tab="${it.tab}"` : `data-action="${it.action}"`}>
                        <span class="m-sheet-item-icon" aria-hidden="true">${it.icon}</span>
                        <span>${it.label}</span>
                        ${it.badge ? `<span class="m-sheet-item-badge">${Number(it.badge)}</span>` : ''}
                    </button>
                `).join('')}
            </div>
        `).join('');
    }

    function openMoreSheet() {
        const overlay = document.getElementById('mobileMoreSheet');
        if (!overlay) return;
        overlay.querySelector('.m-sheet-content').innerHTML = moreItems();
        overlay.hidden = false;
        requestAnimationFrame(() => overlay.classList.add('open'));
    }

    function closeMoreSheet() {
        const overlay = document.getElementById('mobileMoreSheet');
        if (!overlay || overlay.hidden) return;
        overlay.classList.remove('open');
        setTimeout(() => { if (!overlay.classList.contains('open')) overlay.hidden = true; }, 220);
    }

    function runAction(action) {
        closeMoreSheet();
        if (action === 'settings' && typeof toggleSettingsModal === 'function') toggleSettingsModal();
        else if (action === 'tv' && typeof toggleTvMode === 'function') toggleTvMode();
        else if (action === 'cache' && typeof cleanTorrServerCache === 'function') cleanTorrServerCache();
        else if (action === 'install' && typeof triggerPwaInstall === 'function') triggerPwaInstall();
    }

    function buildMoreSheet() {
        const overlay = document.getElementById('mobileMoreSheet');
        if (!overlay) return;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { closeMoreSheet(); return; }
            const item = e.target.closest('.m-sheet-item');
            if (!item) return;
            if (item.dataset.tab) goToTab(item.dataset.tab);
            else runAction(item.dataset.action);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeMoreSheet();
        });
    }

    // --- ÉTAT : ONGLET ACTIF, LECTEUR OUVERT ---

    function updateState() {
        const watching = isShown('detailView');
        document.body.classList.toggle('m-watching', watching);
        if (watching) document.body.classList.remove('m-header-hidden');

        const bar = document.getElementById('mobileTabBar');
        if (!bar) return;
        let active = null;
        if (!watching && isShown('catalogView') && isShown('homeView')) {
            const tab = activeHomeTab();
            active = PRIMARY_TABS.includes(tab) ? tab : 'more';
        }
        bar.querySelectorAll('.m-tab').forEach(btn => {
            const on = btn.dataset.tab === active;
            btn.classList.toggle('active', on);
            if (on) btn.setAttribute('aria-current', 'page');
            else btn.removeAttribute('aria-current');
        });
    }

    let stateQueued = false;
    function queueState() {
        if (stateQueued) return;
        stateQueued = true;
        requestAnimationFrame(() => { stateQueued = false; updateState(); });
    }

    function observeViews() {
        const observer = new MutationObserver(queueState);
        ['catalogView', 'homeView', 'searchView', 'animeView', 'detailView'].forEach(id => {
            const el = document.getElementById(id);
            if (el) observer.observe(el, { attributes: true, attributeFilter: ['style'] });
        });
        // L'accueil est re-rendu à chaque changement d'onglet
        const home = document.getElementById('homeView');
        if (home) observer.observe(home, { childList: true });
        window.addEventListener('popstate', queueState);
        window.addEventListener('hashchange', queueState);
    }

    // --- EN-TÊTE MASQUÉ AU DÉFILEMENT VERS LE BAS ---

    let lastY = 0;
    function showHeader() { document.body.classList.remove('m-header-hidden'); }

    function onScroll() {
        const y = Math.max(0, window.scrollY);
        if (!PHONE_QUERY.matches || document.body.classList.contains('m-watching')) {
            lastY = y;
            return;
        }
        const delta = y - lastY;
        if (y < 80 || delta < -6) showHeader();
        else if (delta > 6 && !document.activeElement?.closest?.('.navbar')) document.body.classList.add('m-header-hidden');
        if (Math.abs(delta) > 6) lastY = y;
    }

    function init() {
        if (!buildTabBar()) return;
        buildMoreSheet();
        observeViews();
        updateState();
        window.addEventListener('scroll', onScroll, { passive: true });
        const search = document.getElementById('searchInput');
        if (search) search.addEventListener('focus', showHeader);
        PHONE_QUERY.addEventListener?.('change', () => { showHeader(); if (typeof syncNavbarHeight === 'function') syncNavbarHeight(); });
    }

    window.openMobileMoreSheet = openMoreSheet;
    window.closeMobileMoreSheet = closeMoreSheet;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
