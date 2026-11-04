// =========================================================================
// --- ANIMFLIX ANILIST INTEGRATION (AUTH, GRAPHQL, TRACKING, AIRING) ---
// =========================================================================

    // =========================================================================
    // --- INTÉGRATION & SUIVI ANILIST API ---
    // =========================================================================

    let currentAnilistUser = null;
    try {
        const savedUser = localStorage.getItem('anilist_user');
        if (savedUser) currentAnilistUser = JSON.parse(savedUser);
    } catch(e) {}
    let anilistWatchingList = [];
    try {
        const savedWatching = localStorage.getItem('anilist_watching_cache');
        if (savedWatching) anilistWatchingList = JSON.parse(savedWatching);
    } catch(e) {}
    let currentTargetNextEpisode = null;
    let currentAnilistMedia = null;
    let currentDetectedEpisode = 1;
    let hasAutoTrackedCurrentEpisode = false;
    let isLoadingWatchingList = false;

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    // Formatage compte à rebours de sortie d'épisode
    function formatAiringCountdown(diffMs) {
        if (diffMs <= 0) return 'Disponible ! 🚀';
        const totalSec = Math.floor(diffMs / 1000);
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;

        if (days > 0) {
            return `${days}j ${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
        } else if (hours > 0) {
            return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
        } else {
            return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
        }
    }

    // Ticker d'actualisation en temps réel (seconde par seconde)
    let airingCountdownInterval = null;
    function startAiringCountdownTicker() {
        if (airingCountdownInterval) clearInterval(airingCountdownInterval);
        airingCountdownInterval = setInterval(() => {
            const countdownEls = document.querySelectorAll('[data-airing-at]');
            if (countdownEls.length === 0) return;
            const now = Date.now();
            countdownEls.forEach(el => {
                const timestamp = parseInt(el.getAttribute('data-airing-at'), 10);
                if (!timestamp) return;
                const diffMs = (timestamp * 1000) - now;
                const formatted = formatAiringCountdown(diffMs);
                const epNum = el.getAttribute('data-ep');
                if (el.classList.contains('badge-tag-airing-timer')) {
                    el.innerText = `⏳ Ép. ${epNum ? epNum + ' : ' : ''}${formatted}`;
                } else if (el.classList.contains('airing-countdown-text')) {
                    el.innerText = formatted;
                } else {
                    el.innerText = formatted;
                }
            });
        }, 1000);
    }

    // --- GESTION DU FILTRE NSFW / CONTENU ADULTE (18+) ---
    function getShowNsfwPreference() {
        const profile = (typeof getActiveProfile === 'function') ? getActiveProfile() : null;
        if (profile && profile.isKid) {
            return false;
        }
        const stored = localStorage.getItem('animflix_show_nsfw');
        if (stored !== null) {
            return stored === 'true';
        }
        if (currentAnilistUser && currentAnilistUser.options && typeof currentAnilistUser.options.displayAdultContent === 'boolean') {
            return currentAnilistUser.options.displayAdultContent;
        }
        return false;
    }

    function toggleNsfwFilter(checked) {
        localStorage.setItem('animflix_show_nsfw', checked ? 'true' : 'false');
        renderHomeScreen();
        renderAnilistNav();
        if (typeof showToast === 'function') {
            showToast(checked ? "🔞 Contenu adulte (18+) affiché" : "🛡️ Contenu adulte (18+) masqué");
        }
    }

    function onNsfwContainerClick(e) {
        if (e && e.target && e.target.tagName === 'INPUT') return;
        const cb = document.getElementById('nsfwToggleInput');
        if (cb) {
            cb.checked = !cb.checked;
            toggleNsfwFilter(cb.checked);
        } else {
            toggleNsfwFilter(!getShowNsfwPreference());
        }
    }

