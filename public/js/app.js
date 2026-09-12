// =========================================================================
// --- ANIMFLIX CORE APP (GLOBALS, ROUTING, TOASTS & UTILS) ---
// =========================================================================

const TORR_HOST = window.location.hostname || '127.0.0.1';
let streamTimeout = null;
let currentActiveMagnet = null;
let currentActiveFileIndex = 1;
let currentActiveAudioIndex = null;
let currentStreamOffset = 0;
let currentTotalDuration = 1440; // Durée totale en secondes (défaut 24 min)
let isScrubbing = false;
let controlsHideTimeout = null;
let currentSubAbort = null;
let currentTextTrack = null;
let currentAnimeItem = null;
let currentPlaySessionId = null;

// --- FORMATAGE ET ANALYSE D'ANIMES (DRY) ---
function getAnimeDetails(anime) {
    if (!anime) {
        return { animeName: 'Anime', season: 'Saison 1', episode: 'Épisode 1', resolution: '1080p Full HD', audioLang: 'VOSTFR' };
    }
    if (typeof anime === 'string') {
        return parseAnimeDetails(anime);
    }
    if (anime.animeName && anime.season && anime.episode) {
        return {
            animeName: anime.animeName,
            season: anime.season,
            episode: anime.episode,
            resolution: anime.resolution || '1080p Full HD',
            audioLang: anime.audioLang || 'VOSTFR'
        };
    }
    return parseAnimeDetails(anime.titre || anime.title || '');
}

function parseAnimeDetails(rawTitle) {
    if (!rawTitle) {
        return { animeName: 'Anime', season: 'Saison 1', episode: 'Épisode 1', resolution: '1080p Full HD', audioLang: 'VOSTFR' };
    }
    let resolution = '1080p Full HD';
    if (/2160p|4k\b/i.test(rawTitle)) resolution = '4K Ultra HD';
    else if (/1080p/i.test(rawTitle)) resolution = '1080p Full HD';
    else if (/720p/i.test(rawTitle)) resolution = '720p HD';
    else if (/480p/i.test(rawTitle)) resolution = '480p SD';

    let audioLang = 'VOSTFR';
    if (/multi/i.test(rawTitle)) audioLang = 'MULTI (VF / VOSTFR)';
    else if (/\bvf\b/i.test(rawTitle)) audioLang = 'VF';
    else if (/vostfr/i.test(rawTitle)) audioLang = 'VOSTFR';
    else if (/vosta|sub\b/i.test(rawTitle)) audioLang = 'VOSTA';

    let season = null;
    const sMultiMatch = rawTitle.match(/S(\d{1,2})\s*[-+&]\s*S?(\d{1,2})/i) || 
                        rawTitle.match(/Saisons?\s*(\d{1,2})\s*[-+&]\s*(\d{1,2})/i);
    if (sMultiMatch) {
        const separator = /[-~]/.test(sMultiMatch[0]) ? ' à ' : ' & ';
        season = `Saisons ${parseInt(sMultiMatch[1], 10)}${separator}${parseInt(sMultiMatch[2], 10)}`;
    } else {
        const seMatch = rawTitle.match(/\bS0*(\d{1,2})E\d+/i);
        if (seMatch) {
            season = `Saison ${parseInt(seMatch[1], 10)}`;
        } else {
            const sMatch = rawTitle.match(/\bS(?:aison|eason)?\s*0*(\d{1,2})(?=[^\w]|$)/i) ||
                           rawTitle.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i) ||
                           rawTitle.match(/\bSeason\s*0*(\d{1,2})\b/i) ||
                           rawTitle.match(/\bSaison\s*0*(\d{1,2})\b/i);
            if (sMatch) {
                season = `Saison ${parseInt(sMatch[1], 10)}`;
            }
        }
    }
    if (!season) season = 'Saison 1';

    let episode = null;
    const epMultiMatch = rawTitle.match(/\b(?:E|EP|Episode|Épisode)\s*0*(\d{1,4})\s*[-~]\s*0*(\d{1,4})\b/i) ||
                         rawTitle.match(/[-_]\s*0*(\d{1,4})\s*[-~]\s*0*(\d{1,4})\b/);
    if (epMultiMatch) {
        episode = `Épisodes ${parseInt(epMultiMatch[1], 10)}-${parseInt(epMultiMatch[2], 10)}`;
    } else {
        const seMatch = rawTitle.match(/S\d{1,2}\s*E0*(\d{1,4})\b/i);
        if (seMatch) {
            episode = `Épisode ${parseInt(seMatch[1], 10)}`;
        } else {
            const epMatch = rawTitle.match(/\b(?:E|EP|Episode|Épisode)\s*0*(\d{1,4})\b/i) ||
                            rawTitle.match(/\s-\s0*(\d{1,4})(?:v\d+)?(?:\s|$|\[|\()/);
            if (epMatch) {
                episode = `Épisode ${parseInt(epMatch[1], 10)}`;
            }
        }
    }

    if (!episode) {
        if (/complete|intégrale|integrale|batch|s\d+[-+]s\d+/i.test(rawTitle)) {
            episode = 'Intégrale / Pack';
        } else if (/\bmovie\b|\bfilm\b/i.test(rawTitle)) {
            episode = 'Film';
        } else if (season && season !== 'Saison 1') {
            episode = 'Saison Complète';
        } else {
            episode = 'Épisode 1';
        }
    }

    let name = rawTitle.replace(/^\[.*?\]\s*/g, '');
    const cutPattern = /(\bS\d+|\bSeason\s*\d+|\bSaison\s*\d+|\b\d+(?:st|nd|rd|th)\s+Season|\s-\s\d+|\bE\d{1,4}\b|\bEP\s*\d+|\bEpisode\s*\d+|\bÉpisode\s*\d+|\b1080p\b|\b720p\b|\b4k\b|\b2160p\b|\bVOSTFR\b|\bVF\b|\bMULTI\b)/i;
    const matchCut = name.search(cutPattern);
    if (matchCut > 2) {
        name = name.substring(0, matchCut);
    }
    name = name.replace(/[._]/g, ' ').replace(/\s*-\s*$/, '').trim();
    if (!name) name = rawTitle;

    return {
        animeName: name,
        season,
        episode,
        resolution,
        audioLang
    };
}

// --- UTILITAIRES DIVERS ---
function formatTimestamp(sec) {
    if (!sec || isNaN(sec) || sec < 0) return "00:00";
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) {
        return `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerText = msg;
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
}

function copyToClipboard(text) {
    if (!text) return false;
    if (navigator.clipboard && window.isSecureContext) {
        try {
            navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
            return true;
        } catch (e) {
            return fallbackCopyText(text);
        }
    }
    return fallbackCopyText(text);
}

function fallbackCopyText(text) {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        textArea.remove();
        return true;
    } catch (err) {
        textArea.remove();
        return false;
    }
}

// --- NAVIGATION PRINCIPALE ET ROUTING SIMPLE ---
function handleLogoClick() {
    closeDetailView();
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
    showHomeScreen();
}

function showHomeScreen() {
    document.getElementById('searchView').style.display = 'none';
    document.getElementById('homeView').style.display = 'block';
    document.getElementById('detailView').style.display = 'none';
    document.getElementById('catalogView').style.display = 'block';
    if (typeof renderHomeScreen === 'function') {
        renderHomeScreen();
    }
}

// --- INITIALISATION DE L'APPLICATION ---
function initApp() {
    if (typeof loadSavedSubStyle === 'function') loadSavedSubStyle();
    if (typeof initAnilistSession === 'function') initAnilistSession();
    if (typeof setupVideoPlayerTracking === 'function') setupVideoPlayerTracking();
    if (typeof initCustomPlayerControls === 'function') initCustomPlayerControls();
}

if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}
