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

    // Rendu de l'écran d'accueil
    function renderHomeScreen() {
        const homeView = document.getElementById('homeView');
        if (!homeView) return;

        const token = localStorage.getItem('anilist_token');
        if (token && currentAnilistUser) {
            if (anilistWatchingList && anilistWatchingList.length > 0) {
                renderWatchingListHtml(homeView, anilistWatchingList);
            } else {
                let cached = null;
                try {
                    const raw = localStorage.getItem('anilist_watching_cache');
                    if (raw) cached = JSON.parse(raw);
                } catch(e) {}

                if (cached && cached.length > 0) {
                    anilistWatchingList = cached;
                    renderWatchingListHtml(homeView, anilistWatchingList);
                } else if (isLoadingWatchingList) {
                    renderWatchingEmptyOrLoading(homeView);
                } else {
                    renderWatchingEmptyList(homeView);
                }
            }
        } else {
            renderLoggedOutHomeHtml(homeView);
        }
    }

    function renderWatchingListHtml(container, list) {
        let cardsHtml = '';
        list.forEach((entry, idx) => {
            const media = entry.media || {};
            const title = media.title?.userPreferred || media.title?.romaji || media.title?.english || 'Anime';
            const progress = entry.progress || 0;
            const total = media.episodes || null;
            const nextEp = progress + 1;
            const isCompleted = total && progress >= total;
            const progressPct = total ? Math.min(100, Math.round((progress / total) * 100)) : (progress > 0 ? 50 : 0);
            const poster = media.coverImage?.large || media.coverImage?.extraLarge || media.coverImage?.medium || 'https://via.placeholder.com/300x450/191919/666666?text=' + encodeURIComponent(title);
            const score = media.averageScore ? (media.averageScore / 10).toFixed(1) : null;
            const format = media.format || 'TV';

            // Vérification si le prochain épisode n'est pas encore sorti (AniList airing schedule)
            const nextAiring = media.nextAiringEpisode;
            let isNextEpUnreleased = false;
            let airingCountdownStr = '';
            let airingTimestamp = null;
            if (nextAiring && nextAiring.airingAt && nextEp >= nextAiring.episode) {
                const diffMs = (nextAiring.airingAt * 1000) - Date.now();
                if (diffMs > 0) {
                    isNextEpUnreleased = true;
                    airingTimestamp = nextAiring.airingAt;
                    airingCountdownStr = formatAiringCountdown(diffMs);
                }
            }

            let badgesTopHtml = '';
            let overlayBtnHtml = '';
            let actionPillHtml = '';

            if (isNextEpUnreleased) {
                badgesTopHtml = `
                    ${score ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.2);color:#ffc107;border-color:rgba(255,193,7,0.4);">⭐ ${score}</span>` : `<span class="badge-tag-mini">${format}</span>`}
                    <span class="badge-tag-mini badge-tag-airing-timer" data-airing-at="${airingTimestamp}" data-ep="${nextAiring.episode}" title="Sortie prévue le ${new Date(airingTimestamp * 1000).toLocaleString('fr-FR')}">
                        ⏳ Ép. ${nextAiring.episode} : ${airingCountdownStr}
                    </span>
                `;
                overlayBtnHtml = `<span class="btn-play-hover" style="background:#d97706;">⏳ Ép. ${nextAiring.episode} à venir (Voir vidéos)</span>`;
                actionPillHtml = `
                    <div class="card-next-ep-btn-pill card-next-ep-pill-airing" title="L'épisode ${nextAiring.episode} n'est pas encore sorti. Cliquer pour chercher les vidéos disponibles.">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <circle cx="12" cy="12" r="10"></circle>
                            <polyline points="12 6 12 12 16 14"></polyline>
                        </svg>
                        <span>Ép. <b>${nextAiring.episode}</b> dans <b class="airing-countdown-text" data-airing-at="${airingTimestamp}">${airingCountdownStr}</b></span>
                    </div>
                `;
            } else {
                badgesTopHtml = `
                    ${score ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.2);color:#ffc107;border-color:rgba(255,193,7,0.4);">⭐ ${score}</span>` : `<span class="badge-tag-mini">${format}</span>`}
                    <span class="badge-tag-mini badge-tag-ep" style="background:rgba(2,169,255,0.25);border-color:rgba(2,169,255,0.4);color:#02a9ff;">
                        ${isCompleted ? 'Terminé' : `Ép. ${progress}${total ? '/' + total : ''}`}
                    </span>
                `;
                overlayBtnHtml = `<span class="btn-play-hover">▶ ${isCompleted ? 'Revoir un épisode' : 'Visionner Ép. ' + nextEp}</span>`;
                actionPillHtml = `
                    <div class="card-next-ep-btn-pill">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
                        <span>${isCompleted ? 'Rechercher les vidéos' : `Prochain : <b>Épisode ${nextEp}</b>`}</span>
                    </div>
                `;
            }

            cardsHtml += `
                <div class="card card-watching" onclick="watchAnimeNextEpisode(${idx})" title="${isNextEpUnreleased ? `Épisode ${nextAiring.episode} pas encore sorti. Cliquer pour chercher les vidéos disponibles.` : `Cliquer pour chercher les vidéos de l'épisode ${nextEp}`}">
                    <div class="card-img-wrap">
                        <img src="${escapeHtml(poster)}" loading="lazy" alt="${escapeHtml(title)}" onerror="this.src='https://via.placeholder.com/300x450/191919/666666?text=Anime'">
                        <div class="card-overlay-hover">
                            ${overlayBtnHtml}
                        </div>
                        <div class="card-badges-top">
                            ${badgesTopHtml}
                        </div>
                        <div class="card-watching-progress-bar-wrap">
                            <div class="card-watching-progress-bar" style="width: ${progressPct}%;"></div>
                        </div>
                    </div>
                    <div class="card-info">
                        <span class="card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</span>
                        <div class="card-watching-meta">
                            <span class="card-ep-progress-text">
                                ${isCompleted ? `✅ Tous les ${total} épisodes vus` : `Visionné : <b>Épisode ${progress}</b> ${total ? '<span style="color:#777;">/ ' + total + '</span>' : ''}`}
                            </span>
                        </div>
                        ${actionPillHtml}
                    </div>
                </div>
            `;
        });

        container.innerHTML = `
            <div class="home-watching-section">
                <div class="home-watching-header">
                    <div class="home-watching-title-group">
                        <h2 class="home-watching-title">
                            <span style="font-size: 24px;">🍿</span>
                            En cours de visionnage
                        </h2>
                        <span class="home-watching-badge">${list.length} anime${list.length > 1 ? 's' : ''}</span>
                    </div>
                    <div class="home-watching-actions">
                        <span id="homeWatchingSubtitle" style="font-size: 13px; color: #888;">
                            Synchronisé avec AniList (${escapeHtml(currentAnilistUser.name)})
                        </span>
                        <button class="btn-refresh-watching" onclick="loadAnilistWatchingList(true)" title="Actualiser la liste depuis AniList">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                            <span>Actualiser</span>
                        </button>
                    </div>
                </div>
                
                <div class="grid home-watching-grid">
                    ${cardsHtml}
                </div>
            </div>
        `;

        startAiringCountdownTicker();
    }

    function renderLoggedOutHomeHtml(container) {
        container.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1; margin-bottom: 20px;">
                Tapez le nom d'un anime ci-dessus pour lancer la recherche 🍿
            </div>
            <div class="anilist-home-connect-promo">
                <svg class="anilist-home-connect-icon" viewBox="0 0 24 24" fill="none">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09h-2.82l.83-2.5h1.16l.83 2.5zm1.5-4.5h-4.32l2.16-6.5 2.16 6.5z" fill="#02a9ff"/>
                </svg>
                <h3>Retrouvez vos animes en cours en 1 clic</h3>
                <p>
                    Connectez votre compte <b>AniList</b> pour afficher ici votre liste d'animes en cours de visionnage et lancer directement la recherche du prochain épisode à regarder !
                </p>
                <button class="btn-anilist-nav" onclick="openAnilistAuthModal()" style="font-size: 14px; padding: 11px 22px;">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09h-2.82l.83-2.5h1.16l.83 2.5zm1.5-4.5h-4.32l2.16-6.5 2.16 6.5z"/>
                    </svg>
                    <span>Connexion AniList</span>
                </button>
            </div>
        `;
    }

    function renderWatchingEmptyOrLoading(container) {
        container.innerHTML = `
            <div class="home-watching-section">
                <div class="home-watching-header">
                    <div class="home-watching-title-group">
                        <h2 class="home-watching-title">
                            <span style="font-size: 24px;">🍿</span>
                            En cours de visionnage
                        </h2>
                    </div>
                </div>
                <div class="empty-state" style="padding: 60px 20px;">
                    <div class="spinner" style="margin: 0 auto 20px;"></div>
                    Chargement de vos animes en cours depuis AniList... ⏳
                </div>
            </div>
        `;
    }

    function renderWatchingEmptyList(container) {
        container.innerHTML = `
            <div class="home-watching-section">
                <div class="home-watching-header">
                    <div class="home-watching-title-group">
                        <h2 class="home-watching-title">
                            <span style="font-size: 24px;">🍿</span>
                            En cours de visionnage
                        </h2>
                    </div>
                </div>
                <div class="empty-state" style="padding: 50px 20px;">
                    <div style="font-size: 38px; margin-bottom: 12px;">📺</div>
                    <div style="font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;">
                        Aucun anime marqué comme "En cours" sur AniList
                    </div>
                    <div style="font-size: 13.5px; color: #aaa; margin-bottom: 20px;">
                        Ajoutez des animes à votre liste "Watching" sur AniList ou utilisez la barre de recherche ci-dessus !
                    </div>
                    <button class="btn-refresh-watching" onclick="loadAnilistWatchingList(true)">
                        🔄 Actualiser
                    </button>
                </div>
            </div>
        `;
    }

    function renderHomeScreenError(errorMsg) {
        const homeView = document.getElementById('homeView');
        if (!homeView) return;
        homeView.innerHTML = `
            <div class="home-watching-section">
                <div class="home-watching-header">
                    <div class="home-watching-title-group">
                        <h2 class="home-watching-title">
                            <span style="font-size: 24px;">🍿</span>
                            En cours de visionnage
                        </h2>
                    </div>
                </div>
                <div class="home-watching-error">
                    <div style="font-size: 36px; margin-bottom: 12px;">⚠️</div>
                    <div style="font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;">
                        Impossible de synchroniser vos animes en cours pour l'instant
                    </div>
                    <div style="font-size: 13px; color: #aaa; max-width: 500px; margin: 0 auto 16px; line-height: 1.5;">
                        ${escapeHtml(errorMsg)}<br>
                        (L'API AniList subit parfois de courtes instabilités temporaires).
                    </div>
                    <div style="display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
                        <button class="btn-refresh-watching" onclick="loadAnilistWatchingList(true)">
                            🔄 Réessayer
                        </button>
                        <button class="btn-secondary" onclick="loadDemoWatchingList()">
                            ✨ Charger des animes de démonstration (Mode Test)
                        </button>
                    </div>
                </div>
            </div>
        `;
    }

    function loadDemoWatchingList() {
        anilistWatchingList = [
            {
                id: 154587,
                status: "CURRENT",
                progress: 5,
                updatedAt: Math.floor(Date.now() / 1000),
                media: {
                    id: 154587,
                    title: {
                        romaji: "Sousou no Frieren",
                        english: "Frieren: Beyond Journey's End",
                        userPreferred: "Sousou no Frieren"
                    },
                    episodes: 28,
                    format: "TV",
                    status: "FINISHED",
                    averageScore: 91,
                    coverImage: {
                        large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-n2bOfj42nh9k.jpg"
                    }
                }
            },
            {
                id: 171018,
                status: "CURRENT",
                progress: 2,
                updatedAt: Math.floor(Date.now() / 1000) - 3600,
                media: {
                    id: 171018,
                    title: {
                        romaji: "Dandadan",
                        english: "DAN DA DAN",
                        userPreferred: "Dandadan"
                    },
                    episodes: 12,
                    format: "TV",
                    status: "RELEASING",
                    averageScore: 84,
                    coverImage: {
                        large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx171018-8GfBf44YcZf9.jpg"
                    },
                    nextAiringEpisode: {
                        episode: 3,
                        airingAt: Math.floor(Date.now() / 1000) + (2 * 86400 + 14 * 3600 + 35 * 60 + 20)
                    }
                }
            },
            {
                id: 151807,
                status: "CURRENT",
                progress: 7,
                updatedAt: Math.floor(Date.now() / 1000) - 7200,
                media: {
                    id: 151807,
                    title: {
                        romaji: "Ore dake Level Up na Ken",
                        english: "Solo Leveling",
                        userPreferred: "Solo Leveling"
                    },
                    episodes: 12,
                    format: "TV",
                    status: "FINISHED",
                    averageScore: 83,
                    coverImage: {
                        large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx151807-f1c24e65.jpg"
                    }
                }
            }
        ];
        try {
            localStorage.setItem('anilist_watching_cache', JSON.stringify(anilistWatchingList));
        } catch(e) {}
        renderHomeScreen();
        showToast("✨ Animes de démonstration chargés avec succès !");
    }

    // Clic sur un anime de la liste d'accueil pour chercher l'épisode suivant
    function watchAnimeNextEpisode(entryIndex) {
        const entry = typeof entryIndex === 'number' ? anilistWatchingList[entryIndex] : entryIndex;
        if (!entry || !entry.media) return;

        const media = entry.media;
        const progress = entry.progress || 0;
        const nextEp = progress + 1;
        const total = media.episodes || null;
        
        let searchTitle = media.title?.romaji || media.title?.userPreferred || media.title?.english || 'Anime';
        searchTitle = searchTitle.replace(/[:]/g, ' ').replace(/\s+/g, ' ').trim();

        // Vérification si le prochain épisode n'est pas encore sorti
        const nextAiring = media.nextAiringEpisode;
        let isNextEpUnreleased = false;
        let airingCountdownStr = '';
        let airingTimestamp = null;
        if (nextAiring && nextAiring.airingAt && nextEp >= nextAiring.episode) {
            const diffMs = (nextAiring.airingAt * 1000) - Date.now();
            if (diffMs > 0) {
                isNextEpUnreleased = true;
                airingTimestamp = nextAiring.airingAt;
                airingCountdownStr = formatAiringCountdown(diffMs);
            }
        }

        // Enregistrer l'association d'ID AniList pour que la page de détail s'associe instantanément
        try {
            localStorage.setItem('anilist_map_' + searchTitle.toLowerCase(), media.id);
            if (media.title?.userPreferred) {
                localStorage.setItem('anilist_map_' + media.title.userPreferred.toLowerCase(), media.id);
            }
            if (media.title?.romaji) {
                localStorage.setItem('anilist_map_' + media.title.romaji.toLowerCase(), media.id);
            }
        } catch(e) {}

        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = searchTitle;

        currentTargetNextEpisode = {
            mediaId: media.id,
            animeName: media.title?.userPreferred || media.title?.romaji || searchTitle,
            searchTitle: searchTitle,
            romaji: media.title?.romaji,
            english: media.title?.english,
            nextEp: nextEp,
            progress: progress,
            totalEpisodes: total,
            coverImage: media.coverImage?.large || media.coverImage?.medium,
            media: media,
            isNextEpUnreleased: isNextEpUnreleased,
            airingTimestamp: airingTimestamp,
            airingCountdownStr: airingCountdownStr
        };

        executeSearchForAnime(searchTitle, currentTargetNextEpisode);
    }

    // Déduplication et tri des entrées d'animes en cours
    function extractWatchingEntries(data) {
        if (!data?.MediaListCollection?.lists) return [];
        const entries = [];
        for (const list of data.MediaListCollection.lists) {
            if (!list.entries) continue;
            for (const entry of list.entries) {
                if (entry.status === 'CURRENT' || list.status === 'CURRENT' || !entry.status) {
                    entries.push(entry);
                }
            }
        }
        const map = new Map();
        for (const entry of entries) {
            if (entry.media && !map.has(entry.media.id)) {
                map.set(entry.media.id, entry);
            }
        }
        const result = Array.from(map.values());
        result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        return result;
    }

    // Chargement de la liste des animes en cours depuis AniList
    async function loadAnilistWatchingList(forceFresh = false) {
        const token = localStorage.getItem('anilist_token');
        if (!token) {
            anilistWatchingList = [];
            renderHomeScreen();
            return;
        }

        // Si le cache est présent et qu'on ne force pas le rechargement, afficher immédiatement
        let cached = null;
        try {
            const raw = localStorage.getItem('anilist_watching_cache');
            if (raw) cached = JSON.parse(raw);
        } catch(e) {}

        if (cached && cached.length > 0 && !forceFresh) {
            anilistWatchingList = cached;
            renderHomeScreen();
        }

        if (!anilistWatchingList || anilistWatchingList.length === 0) {
            isLoadingWatchingList = true;
            renderHomeScreen();
        }

        try {
            const query = `
                query ($userId: Int, $userName: String) {
                    MediaListCollection(userId: $userId, userName: $userName, type: ANIME, status: CURRENT, sort: UPDATED_TIME_DESC) {
                        lists {
                            name
                            status
                            isCustomList
                            entries {
                                id
                                mediaId
                                status
                                progress
                                score
                                updatedAt
                                media {
                                    id
                                    idMal
                                    title {
                                        romaji
                                        english
                                        native
                                        userPreferred
                                    }
                                    synonyms
                                    episodes
                                    format
                                    status
                                    averageScore
                                    bannerImage
                                    coverImage {
                                        extraLarge
                                        large
                                        medium
                                    }
                                    nextAiringEpisode {
                                        episode
                                        timeUntilAiring
                                        airingAt
                                    }
                                }
                            }
                        }
                    }
                }
            `;
            const variables = {};
            if (currentAnilistUser?.id) variables.userId = currentAnilistUser.id;
            else if (currentAnilistUser?.name) variables.userName = currentAnilistUser.name;

            const data = await callAnilistGraphQL(query, variables);
            const entries = extractWatchingEntries(data);
            anilistWatchingList = entries;
            isLoadingWatchingList = false;
            try {
                localStorage.setItem('anilist_watching_cache', JSON.stringify(entries));
            } catch(e) {}
            renderHomeScreen();
        } catch(err) {
            console.warn("AniList watching list error:", err.message);
            isLoadingWatchingList = false;
            if (!anilistWatchingList || anilistWatchingList.length === 0) {
                renderHomeScreenError(err.message);
            } else {
                const sub = document.getElementById('homeWatchingSubtitle');
                if (sub) {
                    sub.innerHTML = `⚠️ Données en cache (AniList temporairement indisponible)`;
                }
            }
        }
    }

    // Détection avancée du numéro d'épisode depuis le tag épisode ou le titre
    function extractEpisodeNumber(episodeStr, titleStr) {
        if (episodeStr) {
            const m = episodeStr.match(/Épisode\s*0*(\d+)/i);
            if (m) return parseInt(m[1], 10);
            const mMulti = episodeStr.match(/Épisodes?\s*0*(\d+)\s*[-~]\s*0*(\d+)/i);
            if (mMulti) return parseInt(mMulti[2], 10);
        }
        if (titleStr) {
            const mSe = titleStr.match(/S\d{1,2}\s*E0*(\d{1,4})\b/i);
            if (mSe) return parseInt(mSe[1], 10);
            const mEp = titleStr.match(/\b(?:E|EP|Episode|Épisode)\s*0*(\d{1,4})\b/i) ||
                        titleStr.match(/\s-\s0*(\d{1,4})(?:v\d+)?(?:\s|$|\[|\()/);
            if (mEp) return parseInt(mEp[1], 10);
        }
        return 1;
    }

    // Appel GraphQL via proxy interne
    async function callAnilistGraphQL(query, variables = {}) {
        const token = localStorage.getItem('anilist_token');
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }
        const res = await fetch('/api/anilist/graphql', {
            method: 'POST',
            headers,
            body: JSON.stringify({ query, variables })
        });
        const data = await res.json();
        if (!res.ok || data.errors) {
            const msg = data.errors?.[0]?.message || 'Erreur AniList';
            throw new Error(msg);
        }
        return data.data;
    }

    // Initialisation session AniList
    async function initAnilistSession() {
        checkUrlForAnilistToken();
        const token = localStorage.getItem('anilist_token');
        renderAnilistNav();
        renderHomeScreen();

        // Récupérer éventuel Client ID pré-configuré par le serveur
        fetch('/api/anilist/config')
            .then(r => r.json())
            .then(data => {
                if (data && data.clientId && !localStorage.getItem('anilist_client_id')) {
                    localStorage.setItem('anilist_client_id', data.clientId);
                }
            })
            .catch(() => {});

        if (!token) {
            renderHomeScreen();
            return;
        }

        try {
            const query = `
                query {
                    Viewer {
                        id
                        name
                        avatar { large medium }
                        siteUrl
                    }
                }
            `;
            const data = await callAnilistGraphQL(query);
            if (data && data.Viewer) {
                currentAnilistUser = data.Viewer;
                localStorage.setItem('anilist_user', JSON.stringify(currentAnilistUser));
                renderAnilistNav();
            }
        } catch(err) {
            console.warn("AniList session validation:", err.message);
            if (err.message && (err.message.toLowerCase().includes('token') || err.message.toLowerCase().includes('auth'))) {
                logoutAnilist(false);
                showToast("⚠️ Votre session AniList a expiré.");
                return;
            }
        }

        await loadAnilistWatchingList();
    }

    // Récupération automatique du token OAuth dans le hash de l'URL (#access_token=...)
    function checkUrlForAnilistToken() {
        const hash = window.location.hash;
        if (hash && hash.includes('access_token=')) {
            const params = new URLSearchParams(hash.substring(1));
            const token = params.get('access_token');
            if (token) {
                localStorage.setItem('anilist_token', token);
                history.replaceState(null, '', window.location.pathname + window.location.search);
                showToast("🎉 Connecté avec succès à AniList !");
                return true;
            }
        }
        return false;
    }

    function toggleAnilistDropdown(e) {
        if (e) e.stopPropagation();
        const badge = document.getElementById('anilistUserBadge');
        if (badge) {
            badge.classList.toggle('active');
        }
    }

    // Rendu du composant de profil ou connexion dans la barre de navigation
    function renderAnilistNav() {
        const container = document.getElementById('anilistNavContainer');
        if (!container) return;

        const token = localStorage.getItem('anilist_token');
        if (token && currentAnilistUser) {
            const avatarUrl = currentAnilistUser.avatar?.medium || currentAnilistUser.avatar?.large || 'https://anilist.co/img/icons/icon.svg';
            container.innerHTML = `
                <div id="anilistUserBadge" class="anilist-user-badge" onclick="toggleAnilistDropdown(event)" tabindex="0" title="Connecté à AniList : ${currentAnilistUser.name}">
                    <img class="anilist-avatar" src="${avatarUrl}" alt="${currentAnilistUser.name}" onerror="this.src='https://anilist.co/img/icons/icon.svg'">
                    <span class="anilist-username">${currentAnilistUser.name}</span>
                    <span style="font-size: 10px; color: #888;">▼</span>
                    <div class="anilist-dropdown" onclick="event.stopPropagation()">
                        <div style="padding: 4px 10px 8px; border-bottom: 1px solid #23374d; margin-bottom: 6px;">
                            <div style="font-size: 11px; color: #888;">Connecté en tant que</div>
                            <div style="font-weight: bold; color: #fff;">${currentAnilistUser.name}</div>
                        </div>
                        <a href="${currentAnilistUser.siteUrl || 'https://anilist.co'}" target="_blank" rel="noopener">
                            🔗 Profil AniList
                        </a>
                        <button onclick="logoutAnilist(true)">
                            🚪 Se déconnecter
                        </button>
                    </div>
                </div>
            `;
        } else {
            container.innerHTML = `
                <button class="btn-anilist-nav" onclick="openAnilistAuthModal()" title="Connecter votre compte AniList">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09h-2.82l.83-2.5h1.16l.83 2.5zm1.5-4.5h-4.32l2.16-6.5 2.16 6.5z"/>
                    </svg>
                    <span>Connexion AniList</span>
                </button>
            `;
        }
    }

    // Gestion de la modale d'authentification
    function openAnilistAuthModal() {
        const modal = document.getElementById('anilistAuthModal');
        if (!modal) return;
        const clientIdInput = document.getElementById('anilistClientIdInput');
        const redirectHint = document.getElementById('anilistRedirectUrlHint');
        if (redirectHint) redirectHint.innerText = window.location.origin;
        if (clientIdInput) {
            clientIdInput.value = localStorage.getItem('anilist_client_id') || '';
        }
        modal.style.display = 'flex';
    }

    function closeAnilistAuthModal() {
        const modal = document.getElementById('anilistAuthModal');
        if (modal) modal.style.display = 'none';
    }

    function loginWithAnilistOAuth() {
        const clientId = document.getElementById('anilistClientIdInput').value.trim();
        if (!clientId) {
            showToast("⚠️ Veuillez entrer un Client ID AniList.");
            return;
        }
        localStorage.setItem('anilist_client_id', clientId);
        const oauthUrl = `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId)}&response_type=token`;
        window.location.href = oauthUrl;
    }

    async function saveAnilistTokenManual() {
        const token = document.getElementById('anilistTokenInput').value.trim();
        if (!token) {
            showToast("⚠️ Veuillez renseigner un jeton d'accès.");
            return;
        }
        localStorage.setItem('anilist_token', token);
        showToast("Vérification du compte AniList... ⏳");
        try {
            const query = `query { Viewer { id name avatar { large medium } siteUrl } }`;
            const data = await callAnilistGraphQL(query);
            if (data && data.Viewer) {
                currentAnilistUser = data.Viewer;
                localStorage.setItem('anilist_user', JSON.stringify(currentAnilistUser));
                closeAnilistAuthModal();
                renderAnilistNav();
                renderHomeScreen();
                await loadAnilistWatchingList(true);
                if (currentAnimeItem) syncAnilistForDetail(currentAnimeItem);
                showToast(`🎉 Bienvenue ${currentAnilistUser.name} !`);
            }
        } catch(err) {
            localStorage.removeItem('anilist_token');
            showToast("❌ Jeton invalide : " + err.message);
        }
    }

    function logoutAnilist(notify = true) {
        localStorage.removeItem('anilist_token');
        localStorage.removeItem('anilist_user');
        localStorage.removeItem('anilist_watching_cache');
        currentAnilistUser = null;
        currentAnilistMedia = null;
        anilistWatchingList = [];
        renderAnilistNav();
        renderHomeScreen();
        if (currentAnimeItem) renderAnilistDetailCard();
        updatePlayerTrackButton();
        if (notify) showToast("🚪 Vous êtes déconnecté d'AniList.");
    }

    // Synchronisation AniList pour la fiche détail
    async function syncAnilistForDetail(anime) {
        const container = document.getElementById('detailAnilistSection');
        if (!container) return;

        hasAutoTrackedCurrentEpisode = false;
        currentAnilistMedia = null;

        const parsed = getAnimeDetails(anime);
        const animeName = anime.animeName || parsed.animeName || anime.cleanTitle || 'Anime';
        currentDetectedEpisode = extractEpisodeNumber(anime.episode || parsed.episode, anime.titre);

        renderAnilistDetailCard(true);

        const token = localStorage.getItem('anilist_token');
        if (!token) {
            renderAnilistDetailCard();
            updatePlayerTrackButton();
            return;
        }

        try {
            const customId = localStorage.getItem('anilist_map_' + animeName.toLowerCase());
            let query, variables;
            if (customId) {
                query = `
                    query ($id: Int) {
                        Media(id: $id, type: ANIME) {
                            id
                            idMal
                            title { romaji english native userPreferred }
                            episodes
                            status
                            format
                            siteUrl
                            coverImage { large medium }
                            mediaListEntry { id status progress score }
                        }
                    }
                `;
                variables = { id: parseInt(customId, 10) };
            } else {
                query = `
                    query ($search: String) {
                        Media(search: $search, type: ANIME) {
                            id
                            idMal
                            title { romaji english native userPreferred }
                            episodes
                            status
                            format
                            siteUrl
                            coverImage { large medium }
                            mediaListEntry { id status progress score }
                        }
                    }
                `;
                variables = { search: animeName };
            }

            const data = await callAnilistGraphQL(query, variables);
            currentAnilistMedia = data?.Media || null;
            renderAnilistDetailCard();
            updatePlayerTrackButton();
        } catch (err) {
            console.warn("Recherche AniList:", err.message);
            renderAnilistDetailCard();
            updatePlayerTrackButton();
        }
    }

    // Affichage de la carte de tracking AniList
    function renderAnilistDetailCard(isLoading = false) {
        const container = document.getElementById('detailAnilistSection');
        if (!container) return;

        const token = localStorage.getItem('anilist_token');
        if (!token) {
            container.innerHTML = `
                <div class="anilist-track-header">
                    <div class="anilist-track-title-wrap">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="#02a9ff">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09h-2.82l.83-2.5h1.16l.83 2.5zm1.5-4.5h-4.32l2.16-6.5 2.16 6.5z"/>
                        </svg>
                        <span>Suivi de progression AniList</span>
                    </div>
                </div>
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 15px;">
                    <div style="font-size: 13.5px; color: #bbb;">
                        Connectez votre compte AniList pour synchroniser automatiquement vos épisodes visionnés.
                    </div>
                    <button class="btn-anilist-nav" onclick="openAnilistAuthModal()">
                        🔗 Se connecter à AniList
                    </button>
                </div>
            `;
            return;
        }

        if (isLoading) {
            container.innerHTML = `
                <div style="display: flex; align-items: center; gap: 12px; color: #bbb; font-size: 13.5px;">
                    <div class="spinner" style="width: 20px; height: 20px; border-width: 3px; margin: 0;"></div>
                    <span>Synchronisation avec AniList en cours... ⏳</span>
                </div>
            `;
            return;
        }

        if (!currentAnilistMedia) {
            container.innerHTML = `
                <div class="anilist-track-header">
                    <div class="anilist-track-title-wrap">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="#02a9ff">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09h-2.82l.83-2.5h1.16l.83 2.5zm1.5-4.5h-4.32l2.16-6.5 2.16 6.5z"/>
                        </svg>
                        <span>Suivi AniList</span>
                    </div>
                    <div class="anilist-track-actions-top">
                        <button class="btn-secondary" onclick="openAnilistSearchModal()" style="font-size: 12px; padding: 5px 10px;">
                            🔍 Associer manuellement
                        </button>
                    </div>
                </div>
                <div style="font-size: 13px; color: #888;">
                    Aucune correspondance trouvée automatiquement sur AniList. Cliquez sur <b>Associer manuellement</b> pour rechercher le titre exact.
                </div>
            `;
            return;
        }

        const entry = currentAnilistMedia.mediaListEntry;
        const currentProgress = entry ? (entry.progress || 0) : 0;
        const totalEpisodes = currentAnilistMedia.episodes || null;
        const progressPercent = totalEpisodes ? Math.min(100, Math.round((currentProgress / totalEpisodes) * 100)) : (currentProgress > 0 ? 50 : 0);
        const mediaTitle = currentAnilistMedia.title?.userPreferred || currentAnilistMedia.title?.romaji || currentAnilistMedia.title?.english || 'Anime';
        const status = entry ? entry.status : 'NOT_IN_LIST';

        const statusLabels = {
            'CURRENT': '📺 En cours',
            'COMPLETED': '✅ Terminé',
            'PLANNING': '📋 À voir',
            'PAUSED': '⏸️ En pause',
            'DROPPED': '❌ Abandonné',
            'NOT_IN_LIST': '➕ Non listé'
        };

        const isCurrentEpWatched = currentProgress >= currentDetectedEpisode;

        container.innerHTML = `
            <div class="anilist-track-header">
                <div class="anilist-track-title-wrap">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="#02a9ff">
                        <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09h-2.82l.83-2.5h1.16l.83 2.5zm1.5-4.5h-4.32l2.16-6.5 2.16 6.5z"/>
                    </svg>
                    <span>AniList :</span>
                    <span style="color: #fff; font-weight: 600;">${mediaTitle}</span>
                    <span class="anilist-badge-status status-${status}">${statusLabels[status] || status}</span>
                </div>
                <div class="anilist-track-actions-top">
                    <a href="${currentAnilistMedia.siteUrl}" target="_blank" rel="noopener" class="btn-anilist-link">
                        ↗ Ouvrir sur AniList
                    </a>
                    <button class="btn-secondary" onclick="openAnilistSearchModal()" style="font-size: 12px; padding: 5px 10px;" title="Associer à une autre fiche si besoin">
                        🔍 Changer d'anime
                    </button>
                </div>
            </div>

            <div class="anilist-track-body">
                <!-- BARRE DE PROGRESSION -->
                <div class="anilist-progress-wrap">
                    <div class="anilist-progress-header">
                        <span>
                            Progression : <b style="color: var(--anilist-blue); font-size: 16px;">Épisode ${currentProgress}</b> / ${totalEpisodes ? totalEpisodes : '?'}
                        </span>
                        <span style="color: #888; font-size: 12.5px;">${totalEpisodes ? progressPercent + '%' : ''}</span>
                    </div>
                    <div class="anilist-progress-bar-bg">
                        <div class="anilist-progress-fill" style="width: ${progressPercent}%;"></div>
                    </div>
                </div>

                <!-- ACTIONS RAPIDES DE TRACKING -->
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                    <div class="anilist-stepper">
                        <button class="anilist-btn-step" onclick="changeAnilistProgress(-1)" ${currentProgress <= 0 ? 'disabled' : ''} title="Épisode précédent">-</button>
                        <span style="font-weight: 700; font-size: 14px; min-width: 24px; text-align: center;">${currentProgress}</span>
                        <button class="anilist-btn-step" onclick="changeAnilistProgress(1)" ${(totalEpisodes && currentProgress >= totalEpisodes) ? 'disabled' : ''} title="Épisode suivant">+</button>
                    </div>

                    <button onclick="setAnilistProgress(${currentDetectedEpisode})" class="btn-anilist-quick-ep ${isCurrentEpWatched ? 'synced' : ''}" title="Mettre à jour au numéro de l'épisode en cours">
                        ${isCurrentEpWatched ? '✓ Épisode ' + currentDetectedEpisode + ' vu' : '✅ Marquer Ép. ' + currentDetectedEpisode + ' vu'}
                    </button>

                    <select onchange="changeAnilistStatus(this.value)" style="padding: 7px 10px; font-size: 12px; background: #182330; border: 1px solid #283e58; border-radius: 6px;">
                        <option value="CURRENT" ${status === 'CURRENT' ? 'selected' : ''}>En cours</option>
                        <option value="COMPLETED" ${status === 'COMPLETED' ? 'selected' : ''}>Terminé</option>
                        <option value="PLANNING" ${status === 'PLANNING' ? 'selected' : ''}>À voir</option>
                        <option value="PAUSED" ${status === 'PAUSED' ? 'selected' : ''}>En pause</option>
                        <option value="DROPPED" ${status === 'DROPPED' ? 'selected' : ''}>Abandonné</option>
                    </select>
                </div>
            </div>
        `;
    }

    // Incrément / Décrément manuel
    async function changeAnilistProgress(delta) {
        if (!currentAnilistMedia) return;
        const entry = currentAnilistMedia.mediaListEntry;
        const cur = entry ? (entry.progress || 0) : 0;
        const nextVal = Math.max(0, cur + delta);
        await setAnilistProgress(nextVal);
    }

    // Définir la progression sur AniList
    async function setAnilistProgress(targetProgress) {
        if (!currentAnilistMedia) return;
        const mediaId = currentAnilistMedia.id;
        const total = currentAnilistMedia.episodes;
        let newStatus = currentAnilistMedia.mediaListEntry?.status || 'CURRENT';
        if (total && targetProgress >= total) {
            newStatus = 'COMPLETED';
        }

        try {
            const mutation = `
                mutation ($mediaId: Int, $progress: Int, $status: MediaListStatus) {
                    SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
                        id
                        mediaId
                        status
                        progress
                    }
                }
            `;
            const data = await callAnilistGraphQL(mutation, {
                mediaId,
                progress: targetProgress,
                status: newStatus
            });

            if (data?.SaveMediaListEntry) {
                if (!currentAnilistMedia.mediaListEntry) {
                    currentAnilistMedia.mediaListEntry = {};
                }
                currentAnilistMedia.mediaListEntry.progress = data.SaveMediaListEntry.progress;
                currentAnilistMedia.mediaListEntry.status = data.SaveMediaListEntry.status;

                // Mettre à jour l'entrée correspondante dans la liste des animes en cours
                if (anilistWatchingList && anilistWatchingList.length > 0) {
                    const idx = anilistWatchingList.findIndex(e => e.media?.id === currentAnilistMedia.id);
                    if (idx !== -1) {
                        anilistWatchingList[idx].progress = data.SaveMediaListEntry.progress;
                        anilistWatchingList[idx].status = data.SaveMediaListEntry.status;
                        anilistWatchingList[idx].updatedAt = Math.floor(Date.now() / 1000);
                        try {
                            localStorage.setItem('anilist_watching_cache', JSON.stringify(anilistWatchingList));
                        } catch(e) {}
                    }
                }

                renderAnilistDetailCard();
                updatePlayerTrackButton();
                showToast(`🎉 AniList synchronisé : Épisode ${targetProgress} enregistré !`);
            }
        } catch(err) {
            showToast("⚠️ Échec mise à jour AniList : " + err.message);
        }
    }

    // Changer le statut sur AniList
    async function changeAnilistStatus(newStatus) {
        if (!currentAnilistMedia) return;
        const mediaId = currentAnilistMedia.id;
        try {
            const mutation = `
                mutation ($mediaId: Int, $status: MediaListStatus) {
                    SaveMediaListEntry(mediaId: $mediaId, status: $status) {
                        id
                        mediaId
                        status
                        progress
                    }
                }
            `;
            const data = await callAnilistGraphQL(mutation, { mediaId, status: newStatus });
            if (data?.SaveMediaListEntry) {
                if (!currentAnilistMedia.mediaListEntry) currentAnilistMedia.mediaListEntry = {};
                currentAnilistMedia.mediaListEntry.status = data.SaveMediaListEntry.status;

                // Mettre à jour le statut local
                if (anilistWatchingList && anilistWatchingList.length > 0) {
                    const idx = anilistWatchingList.findIndex(e => e.media?.id === currentAnilistMedia.id);
                    if (idx !== -1) {
                        if (newStatus === 'CURRENT') {
                            anilistWatchingList[idx].status = newStatus;
                        } else {
                            anilistWatchingList.splice(idx, 1);
                        }
                        try {
                            localStorage.setItem('anilist_watching_cache', JSON.stringify(anilistWatchingList));
                        } catch(e) {}
                    }
                }

                renderAnilistDetailCard();
                showToast(`✅ Statut AniList : ${newStatus}`);
            }
        } catch(err) {
            showToast("⚠️ Échec mise à jour statut : " + err.message);
        }
    }

    // Mise à jour du bouton de tracking dans le lecteur vidéo
    function updatePlayerTrackButton() {
        const btn = document.getElementById('playerTrackBtn');
        if (!btn) return;
        if (!currentAnilistMedia || !localStorage.getItem('anilist_token')) {
            btn.style.display = 'none';
            return;
        }
        btn.style.display = 'inline-flex';
        const curWatched = currentAnilistMedia.mediaListEntry?.progress || 0;
        if (curWatched >= currentDetectedEpisode) {
            btn.innerText = `✓ Ép. ${currentDetectedEpisode} suivi sur AniList`;
            btn.classList.add('synced');
        } else {
            btn.innerText = `⚡ Tracker Ép. ${currentDetectedEpisode} sur AniList`;
            btn.classList.remove('synced');
        }
    }

    // Action du bouton Tracker dans le lecteur vidéo
    async function trackCurrentPlayingEpisode(isAuto = false) {
        if (!currentAnilistMedia) {
            showToast("⚠️ Aucun anime AniList associé.");
            return;
        }
        const token = localStorage.getItem('anilist_token');
        if (!token) {
            openAnilistAuthModal();
            return;
        }
        await setAnilistProgress(currentDetectedEpisode);
        if (isAuto) {
            showToast(`🎉 Progression automatique : Épisode ${currentDetectedEpisode} vu sur AniList !`);
        }
    }

    // Écouteur automatique sur le lecteur vidéo (85% de visionnage ou fin de vidéo)
    function setupVideoPlayerTracking() {
        const video = document.getElementById('videoPlayer');
        if (!video) return;

        video.addEventListener('timeupdate', () => {
            if (!hasAutoTrackedCurrentEpisode && currentAnilistMedia && localStorage.getItem('anilist_token')) {
                const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;
                const curTime = (video.currentTime || 0) + currentStreamOffset;
                if (totalDur > 60) {
                    const percent = (curTime / totalDur) * 100;
                    if (percent >= 85) {
                        hasAutoTrackedCurrentEpisode = true;
                        trackCurrentPlayingEpisode(true);
                    }
                }
            }
        });

        video.addEventListener('ended', () => {
            if (!hasAutoTrackedCurrentEpisode && currentAnilistMedia && localStorage.getItem('anilist_token')) {
                hasAutoTrackedCurrentEpisode = true;
                trackCurrentPlayingEpisode(true);
            }
        });
    }

    // Recherche et association manuelle d'un anime AniList
    function openAnilistSearchModal() {
        const modal = document.getElementById('anilistSearchModal');
        if (!modal) return;
        const queryInput = document.getElementById('anilistSearchQueryInput');
        if (currentAnimeItem) {
            const parsed = getAnimeDetails(currentAnimeItem);
            queryInput.value = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle || '';
        }
        modal.style.display = 'flex';
        searchAnilistCandidates();
    }

    function closeAnilistSearchModal() {
        const modal = document.getElementById('anilistSearchModal');
        if (modal) modal.style.display = 'none';
    }

    async function searchAnilistCandidates() {
        const query = document.getElementById('anilistSearchQueryInput').value.trim();
        const list = document.getElementById('anilistCandidatesList');
        if (!query) return;

        list.innerHTML = '<div style="color: #888; font-size: 13px; text-align: center; padding: 20px;">Recherche sur AniList... ⏳</div>';

        try {
            const gql = `
                query ($search: String) {
                    Page(page: 1, perPage: 8) {
                        media(search: $search, type: ANIME) {
                            id
                            title { romaji english native userPreferred }
                            episodes
                            format
                            status
                            coverImage { medium }
                        }
                    }
                }
            `;
            const data = await callAnilistGraphQL(gql, { search: query });
            const items = data?.Page?.media || [];
            if (items.length === 0) {
                list.innerHTML = '<div style="color: #888; font-size: 13px; text-align: center; padding: 20px;">Aucun résultat trouvé sur AniList.</div>';
                return;
            }

            list.innerHTML = '';
            items.forEach(it => {
                const title = it.title?.userPreferred || it.title?.romaji || it.title?.english || 'Anime';
                const itemEl = document.createElement('div');
                itemEl.className = 'anilist-candidate-item';
                itemEl.innerHTML = `
                    <img class="anilist-candidate-thumb" src="${it.coverImage?.medium || ''}" alt="${title}">
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 700; font-size: 14px; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${title}</div>
                        <div style="font-size: 12px; color: #888; margin-top: 3px;">
                            ${it.format || 'TV'} • ${it.episodes ? it.episodes + ' épisodes' : 'Épisodes en cours'} • ${it.status}
                        </div>
                    </div>
                    <button class="btn-anilist-quick-ep" style="padding: 6px 12px; font-size: 12px;">Associer</button>
                `;
                itemEl.onclick = () => selectAnilistCandidate(it);
                list.appendChild(itemEl);
            });
        } catch(err) {
            list.innerHTML = `<div style="color: #ff4444; font-size: 13px; text-align: center; padding: 20px;">Erreur : ${err.message}</div>`;
        }
    }

    async function selectAnilistCandidate(candidate) {
        if (!currentAnimeItem) return;
        const parsed = getAnimeDetails(currentAnimeItem);
        const animeName = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle || 'Anime';

        localStorage.setItem('anilist_map_' + animeName.toLowerCase(), candidate.id);
        closeAnilistSearchModal();
        showToast(`✅ Associé à : ${candidate.title?.userPreferred || candidate.title?.romaji}`);
        await syncAnilistForDetail(currentAnimeItem);
    }
