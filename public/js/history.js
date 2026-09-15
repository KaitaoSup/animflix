// =========================================================================
// --- ANIMFLIX HISTORY & FAVORITES (LOCAL STORAGE, RESUME & TABS) ---
// =========================================================================

const STORAGE_KEY_HISTORY = 'animflix_playback_history';
const STORAGE_KEY_FAVORITES = 'animflix_favorites';
const STORAGE_KEY_HOME_TAB = 'animflix_home_tab';

let lastPlaybackSaveTime = 0;
let pendingResumeSeconds = 0;
let resumeBannerTimeout = null;

// Extraction du hash SHA1 depuis un magnet link
function extractTorrentHash(magnet) {
    if (!magnet) return 'unknown';
    const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
    return match ? match[1].toLowerCase() : 'unknown';
}

function getStreamKey(magnet, fileIndex) {
    const hash = extractTorrentHash(magnet);
    return `${hash}_f${fileIndex || 1}`;
}

// --- GESTION DE L'HISTORIQUE DE LECTURE ---

function getPlaybackHistory() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn("Erreur lecture historique:", e);
        return [];
    }
}

function savePlaybackHistoryList(list) {
    try {
        localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(list.slice(0, 50)));
    } catch (e) {
        console.warn("Erreur écriture historique:", e);
    }
}

// Vérifie si une reprise de lecture existe pour un stream donné
function getPlaybackResume(magnet, fileIndex, animeName = null, episode = null) {
    if (!magnet) return null;
    const history = getPlaybackHistory();
    const key = getStreamKey(magnet, fileIndex);

    // 1. Recherche directe par clé hash torrent + fileIndex
    let item = history.find(h => h.key === key);

    // 2. Recherche par nom d'anime + numéro d'épisode si pas trouvé par hash
    if (!item && animeName && episode) {
        const cleanName = animeName.toLowerCase().trim();
        const epStr = String(episode).toLowerCase();
        item = history.find(h => 
            h.animeName && h.animeName.toLowerCase().trim() === cleanName &&
            h.episode && String(h.episode).toLowerCase().includes(epStr)
        );
    }

    if (!item) return null;

    // Critères pour proposer une reprise : au moins 15s de lecture, pas encore terminé (< durée - 35s), non marqué completed
    const duration = item.duration > 0 ? item.duration : 1440;
    if (item.currentTime >= 15 && item.currentTime < (duration - 35) && !item.completed) {
        return item;
    }

    return null;
}

// Sauvegarde périodique de la progression de lecture
function savePlaybackProgress(force = false) {
    if (!currentActiveMagnet || !currentAnimeItem) return;

    const now = Date.now();
    if (!force && (now - lastPlaybackSaveTime < 3500)) return;
    lastPlaybackSaveTime = now;

    const video = document.getElementById('videoPlayer');
    const effectiveTime = Math.max(0, currentStreamOffset + (video?.currentTime || 0));
    const totalDuration = currentTotalDuration > 0 ? currentTotalDuration : 1440;

    // On ne sauvegarde pas les toutes premières secondes pour éviter de polluer l'historique
    if (effectiveTime < 8) return;

    const progressPct = Math.min(100, Math.max(0, Math.round((effectiveTime / totalDuration) * 100)));
    const isCompleted = (effectiveTime >= totalDuration - 40) || (progressPct >= 94);

    const parsed = getAnimeDetails(currentAnimeItem);
    const animeName = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle || 'Anime';
    const episode = currentDetectedEpisode || (currentAnimeItem ? parseAnimeDetails(currentAnimeItem.titre).episode : null) || parsed.episode || 'Épisode 1';
    const season = parsed.season || 'Saison 1';
    const poster = currentAnimeItem.poster || 
                   (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.coverImage?.large) || 
                   (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.coverImage?.medium) || '';

    const streamKey = getStreamKey(currentActiveMagnet, currentActiveFileIndex);

    const historyEntry = {
        key: streamKey,
        magnet: currentActiveMagnet,
        fileIndex: currentActiveFileIndex,
        animeName: animeName,
        season: season,
        episode: typeof episode === 'number' ? `Épisode ${episode}` : episode,
        rawTitle: currentAnimeItem.titre || animeName,
        poster: poster,
        rating: currentAnimeItem.rating || null,
        taille: currentAnimeItem.taille || '',
        seeders: currentAnimeItem.seeders || 0,
        resolution: parsed.resolution || '1080p Full HD',
        audioLang: parsed.audioLang || 'VOSTFR',
        currentTime: Math.round(effectiveTime),
        duration: Math.round(totalDuration),
        progressPct: progressPct,
        completed: isCompleted,
        updatedAt: now
    };

    let history = getPlaybackHistory();
    // Retirer toute ancienne entrée avec la même clé ou même épisode de l'anime
    history = history.filter(h => h.key !== streamKey);
    // Insérer en première position
    history.unshift(historyEntry);
    savePlaybackHistoryList(history);

    // Mettre à jour le bouton de reprise sur la fiche si visible
    updateDetailResumeButton(historyEntry);
}

// Marque l'épisode en cours comme terminé
function markCurrentPlaybackCompleted() {
    if (!currentActiveMagnet) return;
    const streamKey = getStreamKey(currentActiveMagnet, currentActiveFileIndex);
    let history = getPlaybackHistory();
    const item = history.find(h => h.key === streamKey);
    if (item) {
        item.completed = true;
        item.progressPct = 100;
        item.updatedAt = Date.now();
        savePlaybackHistoryList(history);
    }
    dismissResumeBanner(false);
}

// Réinitialise la position de reprise pour ce stream
function clearPlaybackResume(magnet, fileIndex) {
    if (!magnet) return;
    const streamKey = getStreamKey(magnet, fileIndex);
    let history = getPlaybackHistory();
    const item = history.find(h => h.key === streamKey);
    if (item) {
        item.currentTime = 0;
        item.progressPct = 0;
        item.completed = false;
        item.updatedAt = Date.now();
        savePlaybackHistoryList(history);
    }
}

// Supprime un élément spécifique de l'historique
function deleteHistoryItem(key, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    let history = getPlaybackHistory();
    history = history.filter(h => h.key !== key);
    savePlaybackHistoryList(history);
    showToast("🗑️ Retiré de l'historique");
    renderHomeScreen();
}

// Efface tout l'historique
function clearAllPlaybackHistory() {
    if (!confirm("Voulez-vous vraiment effacer tout votre historique de visionnage local ?")) return;
    localStorage.removeItem(STORAGE_KEY_HISTORY);
    showToast("🧹 Historique local entièrement effacé");
    renderHomeScreen();
}

// Lance la reprise depuis une carte de l'historique
function resumeAnimeFromHistory(key) {
    const history = getPlaybackHistory();
    const item = history.find(h => h.key === key);
    if (!item) return;

    const anime = {
        titre: item.rawTitle || item.animeName,
        animeName: item.animeName,
        season: item.season,
        episode: item.episode,
        lienMagnet: item.magnet,
        poster: item.poster,
        taille: item.taille || '',
        seeders: item.seeders || 0,
        rating: item.rating || null
    };

    const targetSeek = (!item.completed && item.currentTime > 15) ? item.currentTime : 0;
    if (typeof openAnimeDetail === 'function') {
        openAnimeDetail(anime, item.fileIndex || 1, targetSeek);
        if (targetSeek > 0) {
            showToast(`⏱️ Reprise de ${item.animeName} à ${formatTimestamp(targetSeek)}`);
        }
    }
}

// --- BANNIÈRE DE REPRISE DE LECTURE DANS LE MEDIA PLAYER ---

function checkAndShowResumeBanner(magnet, fileIndex, animeItem) {
    const banner = document.getElementById('playerResumeBanner');
    const timeLabel = document.getElementById('playerResumeTimeLabel');
    const detailResumeBtn = document.getElementById('detailResumeBtn');

    if (resumeBannerTimeout) {
        clearTimeout(resumeBannerTimeout);
        resumeBannerTimeout = null;
    }

    if (!magnet) {
        if (banner) banner.style.display = 'none';
        if (detailResumeBtn) detailResumeBtn.style.display = 'none';
        pendingResumeSeconds = 0;
        return;
    }

    const parsed = animeItem ? getAnimeDetails(animeItem) : null;
    const animeName = animeItem?.animeName || parsed?.animeName || null;
    const curEp = currentDetectedEpisode || parsed?.episode || null;

    const saved = getPlaybackResume(magnet, fileIndex, animeName, curEp);

    if (saved && saved.currentTime >= 15 && !saved.completed) {
        pendingResumeSeconds = saved.currentTime;
        const timeFormatted = formatTimestamp(saved.currentTime);

        if (timeLabel) {
            timeLabel.innerHTML = `Reprendre à <b>${timeFormatted}</b> (${saved.progressPct}%)`;
        }
        if (banner) {
            banner.style.display = 'flex';
        }
        if (detailResumeBtn) {
            detailResumeBtn.innerText = `▶ Reprendre à ${timeFormatted}`;
            detailResumeBtn.style.display = 'inline-flex';
        }

        // Auto-fermeture après 14 secondes si l'utilisateur ne clique pas
        resumeBannerTimeout = setTimeout(() => {
            if (banner) banner.style.display = 'none';
        }, 14000);
    } else {
        pendingResumeSeconds = 0;
        if (banner) banner.style.display = 'none';
        if (detailResumeBtn) detailResumeBtn.style.display = 'none';
    }
}

function updateDetailResumeButton(item) {
    const detailResumeBtn = document.getElementById('detailResumeBtn');
    if (!detailResumeBtn) return;
    if (item && item.currentTime >= 15 && !item.completed) {
        detailResumeBtn.innerText = `▶ Reprendre à ${formatTimestamp(item.currentTime)}`;
        detailResumeBtn.style.display = 'inline-flex';
        pendingResumeSeconds = item.currentTime;
    }
}

function resumePlaybackFromBanner() {
    if (pendingResumeSeconds > 0) {
        const target = pendingResumeSeconds;
        dismissResumeBanner(false);
        if (typeof seekVideoTo === 'function') {
            seekVideoTo(target);
            showToast(`⏱️ Reprise à ${formatTimestamp(target)}`);
        }
    }
}

function resumePlaybackFromSaved() {
    resumePlaybackFromBanner();
}

function dismissResumeBanner(resetProgress = false) {
    if (resumeBannerTimeout) {
        clearTimeout(resumeBannerTimeout);
        resumeBannerTimeout = null;
    }
    const banner = document.getElementById('playerResumeBanner');
    if (banner) banner.style.display = 'none';

    if (resetProgress && currentActiveMagnet) {
        clearPlaybackResume(currentActiveMagnet, currentActiveFileIndex);
        const detailResumeBtn = document.getElementById('detailResumeBtn');
        if (detailResumeBtn) detailResumeBtn.style.display = 'none';
        pendingResumeSeconds = 0;
        showToast("↺ Lecture réinitialisée au début");
    }
}

// --- GESTION DES FAVORIS LOCAUX ---

function getFavorites() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY_FAVORITES);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        console.warn("Erreur lecture favoris:", e);
        return [];
    }
}

function saveFavoritesList(list) {
    try {
        localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(list));
    } catch (e) {
        console.warn("Erreur écriture favoris:", e);
    }
}

function isAnimeFavorite(animeName) {
    if (!animeName) return false;
    const cleanTarget = animeName.toLowerCase().trim();
    const list = getFavorites();
    return list.some(f => f.animeName && f.animeName.toLowerCase().trim() === cleanTarget);
}

function toggleCurrentAnimeFavorite() {
    if (!currentAnimeItem) return;
    const parsed = getAnimeDetails(currentAnimeItem);
    const animeName = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle || 'Anime';
    const poster = currentAnimeItem.poster || 
                   (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.coverImage?.large) || 
                   (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.coverImage?.medium) || '';

    let list = getFavorites();
    const cleanTarget = animeName.toLowerCase().trim();
    const existingIndex = list.findIndex(f => f.animeName && f.animeName.toLowerCase().trim() === cleanTarget);

    if (existingIndex >= 0) {
        // Retirer des favoris
        list.splice(existingIndex, 1);
        saveFavoritesList(list);
        updateFavoriteButtonState(false);
        showToast(`🤍 "${animeName}" retiré de vos favoris`);
    } else {
        // Ajouter aux favoris
        const favEntry = {
            id: cleanTarget,
            animeName: animeName,
            season: parsed.season || 'Saison 1',
            poster: poster,
            rating: currentAnimeItem.rating || null,
            rawTitle: currentAnimeItem.titre || animeName,
            lienMagnet: currentAnimeItem.lienMagnet || null,
            searchTitle: animeName,
            addedAt: Date.now()
        };
        list.unshift(favEntry);
        saveFavoritesList(list);
        updateFavoriteButtonState(true);
        showToast(`❤️ "${animeName}" ajouté à vos favoris !`);
    }
}

function updateFavoriteButtonState(isFav) {
    const btn = document.getElementById('detailFavoriteBtn');
    const icon = document.getElementById('detailFavoriteIcon');
    const text = document.getElementById('detailFavoriteText');
    if (!btn) return;

    if (isFav) {
        btn.classList.add('active');
        if (icon) icon.textContent = '❤️';
        if (text) text.textContent = 'Dans mes favoris';
    } else {
        btn.classList.remove('active');
        if (icon) icon.textContent = '🤍';
        if (text) text.textContent = 'Ajouter aux favoris';
    }
}

function deleteFavoriteItem(id, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    let list = getFavorites();
    list = list.filter(f => f.id !== id && f.animeName?.toLowerCase().trim() !== id);
    saveFavoritesList(list);
    showToast("🗑️ Favori retiré");
    renderHomeScreen();
}

function searchFavoriteAnime(searchTitle) {
    if (!searchTitle) return;
    const input = document.getElementById('searchInput');
    if (input) input.value = searchTitle;
    if (typeof handleSearchClick === 'function') {
        handleSearchClick();
    }
}

// --- GESTION DES ONGLETS SUR L'ÉCRAN D'ACCUEIL ---

function getActiveHomeTab() {
    const saved = localStorage.getItem(STORAGE_KEY_HOME_TAB);
    const token = localStorage.getItem('anilist_token');
    const hasAnilist = !!(token && typeof currentAnilistUser !== 'undefined' && currentAnilistUser);

    if (saved && (saved === 'anilist' || saved === 'history' || saved === 'favorites')) {
        // Si l'utilisateur est déconnecté d'AniList mais avait sauvé l'onglet anilist, basculer intelligemment
        if (saved === 'anilist' && !hasAnilist) {
            const hist = getPlaybackHistory();
            return hist.length > 0 ? 'history' : 'anilist';
        }
        return saved;
    }

    if (hasAnilist) return 'anilist';
    const hist = getPlaybackHistory();
    if (hist.length > 0) return 'history';
    const favs = getFavorites();
    if (favs.length > 0) return 'favorites';
    return 'anilist';
}

function switchHomeTab(tabName) {
    localStorage.setItem(STORAGE_KEY_HOME_TAB, tabName);
    renderHomeScreen();
}

// Utilitaire de formatage temporel relatif ("Il y a 5 min", "Hier", etc.)
function formatTimeAgo(timestamp) {
    if (!timestamp) return '';
    const diffMs = Date.now() - timestamp;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMin < 2) return 'À l\'instant';
    if (diffMin < 60) return `Il y a ${diffMin} min`;
    if (diffHours < 24) return `Il y a ${diffHours}h`;
    if (diffDays === 1) return 'Hier';
    if (diffDays < 7) return `Il y a ${diffDays}j`;
    return new Date(timestamp).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// --- RENDU HTML DE L'HISTORIQUE ---

function renderHistoryTabHtml(container) {
    const history = getPlaybackHistory();

    if (history.length === 0) {
        container.innerHTML = `
            <div class="home-watching-section">
                <div class="home-watching-header">
                    <div class="home-watching-title-group">
                        <h2 class="home-watching-title">
                            <span style="font-size: 24px;">🕒</span>
                            Historique de visionnage
                        </h2>
                        <span class="home-watching-badge">0 anime</span>
                    </div>
                </div>
                <div class="empty-state" style="padding: 60px 20px;">
                    <div style="font-size: 42px; margin-bottom: 14px;">⏱️</div>
                    <div style="font-size: 17px; font-weight: bold; color: #fff; margin-bottom: 8px;">
                        Votre historique de lecture est vide
                    </div>
                    <div style="font-size: 13.5px; color: #aaa; max-width: 480px; margin: 0 auto 20px; line-height: 1.5;">
                        Lancez un anime avec le lecteur intégré pour que votre progression et vos épisodes s'enregistrent ici automatiquement !
                    </div>
                </div>
            </div>
        `;
        return;
    }

    let cardsHtml = '';
    history.forEach(item => {
        const displayTitle = item.animeName || 'Anime';
        const poster = item.poster || 'https://via.placeholder.com/300x450/191919/666666?text=' + encodeURIComponent(displayTitle);
        const timeFormatted = formatTimestamp(item.currentTime);
        const durFormatted = formatTimestamp(item.duration);
        const ago = formatTimeAgo(item.updatedAt);
        const isFinished = item.completed || item.progressPct >= 94;

        cardsHtml += `
            <div class="card card-history" onclick="resumeAnimeFromHistory('${escapeHtml(item.key)}')" title="Reprendre la lecture de ${escapeHtml(displayTitle)}">
                <div class="card-img-wrap">
                    <img src="${escapeHtml(poster)}" loading="lazy" alt="${escapeHtml(displayTitle)}" onerror="this.src='https://via.placeholder.com/300x450/191919/666666?text=Anime'">
                    
                    <button class="card-btn-delete-history" onclick="deleteHistoryItem('${escapeHtml(item.key)}', event)" title="Supprimer de l'historique">
                        ✕
                    </button>

                    <div class="card-overlay-hover">
                        <span class="btn-play-hover">
                            ${isFinished ? '↺ Revoir l\'épisode' : `▶ Reprendre à ${timeFormatted}`}
                        </span>
                    </div>

                    <div class="card-badges-top">
                        ${item.rating ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.2);color:#ffc107;border-color:rgba(255,193,7,0.4);">⭐ ${item.rating}</span>` : ''}
                        <span class="badge-tag-mini badge-tag-ep" style="background:rgba(2,169,255,0.25);border-color:rgba(2,169,255,0.4);color:#02a9ff;">
                            ${escapeHtml(item.episode)}
                        </span>
                    </div>

                    <div class="card-history-progress-wrap">
                        <div class="card-history-progress-bar" style="width: ${item.progressPct}%;"></div>
                    </div>
                </div>

                <div class="card-info">
                    <span class="card-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</span>
                    <div style="font-size: 11.5px; color: #888; margin-top: 2px;">
                        ${escapeHtml(item.season)} • ${escapeHtml(item.episode)}
                    </div>
                    <div class="card-watching-meta" style="margin-top: 4px;">
                        <span class="card-ep-progress-text" style="color: ${isFinished ? '#46d369' : '#ff525d'}; font-weight: 600;">
                            ${isFinished ? '✅ Visionné en entier' : `⏱️ Arrêté à ${timeFormatted} / ${durFormatted}`}
                        </span>
                    </div>
                    <div style="font-size: 11px; color: #666; margin-top: 2px;">
                        ${ago}
                    </div>
                    <div class="card-next-ep-btn-pill" style="margin-top: 6px;">
                        <span>${isFinished ? '↺ Relancer la lecture' : `▶ Reprendre (${item.progressPct}%)`}</span>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="home-watching-section">
            <div class="home-watching-header">
                <div class="home-watching-title-group">
                    <h2 class="home-watching-title">
                        <span style="font-size: 24px;">🕒</span>
                        Continuer à regarder
                    </h2>
                    <span class="home-watching-badge">${history.length} anime${history.length > 1 ? 's' : ''}</span>
                </div>
                <div class="home-watching-actions">
                    <button class="btn-clear-history" onclick="clearAllPlaybackHistory()" title="Effacer tout l'historique">
                        🗑️ Tout effacer
                    </button>
                </div>
            </div>
            <div class="grid home-watching-grid">
                ${cardsHtml}
            </div>
        </div>
    `;
}

// --- RENDU HTML DES FAVORIS ---

function renderFavoritesTabHtml(container) {
    const favorites = getFavorites();

    if (favorites.length === 0) {
        container.innerHTML = `
            <div class="home-watching-section">
                <div class="home-watching-header">
                    <div class="home-watching-title-group">
                        <h2 class="home-watching-title">
                            <span style="font-size: 24px;">❤️</span>
                            Mes Favoris
                        </h2>
                        <span class="home-watching-badge">0 favori</span>
                    </div>
                </div>
                <div class="empty-state" style="padding: 60px 20px;">
                    <div style="font-size: 42px; margin-bottom: 14px;">🤍</div>
                    <div style="font-size: 17px; font-weight: bold; color: #fff; margin-bottom: 8px;">
                        Vous n'avez aucun anime favori
                    </div>
                    <div style="font-size: 13.5px; color: #aaa; max-width: 480px; margin: 0 auto 20px; line-height: 1.5;">
                        Ouvrez la page de détail d'un anime et cliquez sur <b>"🤍 Ajouter aux favoris"</b> pour le retrouver ici facilement !
                    </div>
                </div>
            </div>
        `;
        return;
    }

    let cardsHtml = '';
    favorites.forEach(item => {
        const displayTitle = item.animeName || 'Anime';
        const poster = item.poster || 'https://via.placeholder.com/300x450/191919/666666?text=' + encodeURIComponent(displayTitle);
        const ago = formatTimeAgo(item.addedAt);

        cardsHtml += `
            <div class="card card-favorite" onclick="searchFavoriteAnime('${escapeHtml(item.searchTitle || displayTitle)}')" title="Rechercher tous les épisodes de ${escapeHtml(displayTitle)}">
                <div class="card-img-wrap">
                    <img src="${escapeHtml(poster)}" loading="lazy" alt="${escapeHtml(displayTitle)}" onerror="this.src='https://via.placeholder.com/300x450/191919/666666?text=Anime'">
                    
                    <button class="card-btn-delete-history" onclick="deleteFavoriteItem('${escapeHtml(item.id)}', event)" title="Retirer des favoris">
                        ❤️
                    </button>

                    <div class="card-overlay-hover">
                        <span class="btn-play-hover" style="background: #e50914;">
                            🔍 Rechercher les épisodes
                        </span>
                    </div>

                    <div class="card-badges-top">
                        ${item.rating ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.2);color:#ffc107;border-color:rgba(255,193,7,0.4);">⭐ ${item.rating}</span>` : ''}
                        <span class="badge-tag-mini" style="background:rgba(229,9,20,0.25);border-color:rgba(229,9,20,0.4);color:#ff525d;">
                            ${escapeHtml(item.season || 'Anime')}
                        </span>
                    </div>
                </div>

                <div class="card-info">
                    <span class="card-title" title="${escapeHtml(displayTitle)}">${escapeHtml(displayTitle)}</span>
                    <div style="font-size: 11.5px; color: #888; margin-top: 2px;">
                        Ajouté ${ago}
                    </div>
                    <div class="card-next-ep-btn-pill" style="margin-top: 8px;">
                        <span>🔍 Voir les torrents & épisodes</span>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = `
        <div class="home-watching-section">
            <div class="home-watching-header">
                <div class="home-watching-title-group">
                    <h2 class="home-watching-title">
                        <span style="font-size: 24px;">❤️</span>
                        Mes Animes Favoris
                    </h2>
                    <span class="home-watching-badge">${favorites.length} anime${favorites.length > 1 ? 's' : ''}</span>
                </div>
            </div>
            <div class="grid home-watching-grid">
                ${cardsHtml}
            </div>
        </div>
    `;
}

// Export global pour interaction depuis le DOM HTML
window.switchHomeTab = switchHomeTab;
window.getActiveHomeTab = getActiveHomeTab;
window.resumePlaybackFromBanner = resumePlaybackFromBanner;
window.resumePlaybackFromSaved = resumePlaybackFromSaved;
window.dismissResumeBanner = dismissResumeBanner;
window.resumeAnimeFromHistory = resumeAnimeFromHistory;
window.deleteHistoryItem = deleteHistoryItem;
window.clearAllPlaybackHistory = clearAllPlaybackHistory;
window.toggleCurrentAnimeFavorite = toggleCurrentAnimeFavorite;
window.deleteFavoriteItem = deleteFavoriteItem;
window.searchFavoriteAnime = searchFavoriteAnime;
window.checkAndShowResumeBanner = checkAndShowResumeBanner;
window.savePlaybackProgress = savePlaybackProgress;
window.markCurrentPlaybackCompleted = markCurrentPlaybackCompleted;
window.updateFavoriteButtonState = updateFavoriteButtonState;
