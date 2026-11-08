    // --- RENDU DU DASHBOARD DE LA PAGE D'ACCUEIL (PAGE PRINCIPALE) ---
    function renderHomeMainDashboardHtml(container) {
        const token = localStorage.getItem('anilist_token');
        const hasAnilist = !!(token && currentAnilistUser);
        const userName = (hasAnilist && currentAnilistUser?.name) ? currentAnilistUser.name : '';
        const userAvatar = (hasAnilist && (currentAnilistUser?.avatar?.medium || currentAnilistUser?.avatar?.large)) || '';
        const anilistCount = (anilistWatchingList && anilistWatchingList.length) ? anilistWatchingList.length : 0;
        const history = (typeof getPlaybackHistory === 'function') ? getPlaybackHistory() : [];
        const histCount = history.length;
        const favCount = (typeof getFavorites === 'function') ? getFavorites().length : 0;

        // Récupération des données en cache Découverte
        let discoverData = null;
        try {
            const rawDiscover = localStorage.getItem(DISCOVER_CACHE_KEY);
            if (rawDiscover) {
                const parsed = JSON.parse(rawDiscover);
                if (parsed && parsed.data) {
                    discoverData = parsed.data;
                }
            }
        } catch(e) {}

        // Si le cache découverte est vide, déclencher un chargement silencieux en arrière-plan
        if (!discoverData) {
            setTimeout(() => {
                const currentTab = (typeof getActiveHomeTab === 'function') ? getActiveHomeTab() : 'home';
                if (currentTab === 'home') {
                    renderDiscoverTabHtml(null).then(() => {
                        const checkTab = (typeof getActiveHomeTab === 'function') ? getActiveHomeTab() : 'home';
                        if (checkTab === 'home') {
                            renderHomeScreen();
                        }
                    }).catch(() => {});
                }
            }, 100);
        }

        // Section "Continuer vos visionnages"
        let continueWatchingSectionHtml = '';
        if (histCount > 0) {
            const previewItems = history.slice(0, 4);
            const cardsHtml = (typeof renderHistoryCards === 'function') ? renderHistoryCards(previewItems) : '';
            continueWatchingSectionHtml = `
                <div class="home-section" style="margin-top: 36px;">
                    <div class="home-section-header">
                        <div class="home-section-title-wrap">
                            <h2 class="home-section-title"><span>🕒</span> Continuer vos visionnages</h2>
                            <span class="home-section-badge">${histCount} en cours</span>
                        </div>
                        <button class="home-section-link" onclick="switchHomeTab('history')">
                            Voir tout l'historique (${histCount}) →
                        </button>
                    </div>
                    <div class="grid home-watching-grid">
                        ${cardsHtml}
                    </div>
                </div>
            `;
        } else if (hasAnilist && anilistWatchingList && anilistWatchingList.length > 0) {
            const previewItems = anilistWatchingList.slice(0, 4);
            const cardsHtml = renderWatchingCards(previewItems);
            continueWatchingSectionHtml = `
                <div class="home-section" style="margin-top: 36px;">
                    <div class="home-section-header">
                        <div class="home-section-title-wrap">
                            <h2 class="home-section-title"><span>🍿</span> Vos séries AniList en cours ${userName ? '• ' + escapeHtml(userName) : ''}</h2>
                            <span class="home-section-badge">${anilistCount} animes</span>
                        </div>
                        <button class="home-section-link" onclick="switchHomeTab('anilist')">
                            Voir toute ma liste (${anilistCount}) →
                        </button>
                    </div>
                    <div class="grid home-watching-grid">
                        ${cardsHtml}
                    </div>
                </div>
            `;
        }

        // Section "Tendances du moment" (Top 6)
        let trendingSectionHtml = '';
        if (discoverData && discoverData.trending && discoverData.trending.media && discoverData.trending.media.length > 0) {
            const trendingItems = discoverData.trending.media.slice(0, 6);
            trendingSectionHtml = `
                <div class="home-section" style="margin-top: 36px;">
                    <div class="home-section-header">
                        <div class="home-section-title-wrap">
                            <h2 class="home-section-title"><span>🔥</span> Tendances du moment</h2>
                            <span class="home-section-badge">Les plus populaires cette semaine</span>
                        </div>
                        <button class="home-section-link" onclick="switchHomeTab('discover')">
                            Explorer tout le catalogue →
                        </button>
                    </div>
                    <div class="grid">
                        ${renderDiscoverCards(trendingItems)}
                    </div>
                </div>
            `;
        } else {
            trendingSectionHtml = `
                <div class="home-section" style="margin-top: 36px;">
                    <div class="home-section-header">
                        <div class="home-section-title-wrap">
                            <h2 class="home-section-title"><span>🔥</span> Tendances & Découverte</h2>
                        </div>
                        <button class="home-section-link" onclick="switchHomeTab('discover')">
                            Accéder au catalogue →
                        </button>
                    </div>
                    ${renderSkeletonGrid(6, 'Chargement des tendances AniList…')}
                </div>
            `;
        }

        container.innerHTML = `
            <div class="home-dashboard-container">
                <!-- Bannière Hero d'accueil -->
                <div class="home-hero-banner ${hasAnilist ? 'home-hero-banner-user' : ''}">
                    <div class="home-hero-content">
                        ${hasAnilist ? `
                            <span class="home-hero-pill home-hero-pill-user">
                                ${userAvatar ? `<img src="${escapeHtml(userAvatar)}" alt="${escapeHtml(userName)}" class="hero-user-avatar">` : '<span class="home-hero-pulse" style="background:#02a9ff;box-shadow:0 0 10px #02a9ff;"></span>'}
                                <span>Connecté à AniList • <strong>${escapeHtml(userName)}</strong></span>
                            </span>
                            <h1 class="home-hero-title">Bienvenue, <span class="home-hero-highlight-user">${escapeHtml(userName)}</span> ! 👋</h1>
                            <p class="home-hero-desc">
                                Ravi de vous revoir ! Vos <strong>${anilistCount} anime${anilistCount > 1 ? 's' : ''} en cours</strong> sont synchronisés avec votre compte AniList. Reprenez vos épisodes en streaming P2P direct et suivez votre progression d'un simple clic.
                            </p>
                        ` : `
                            <span class="home-hero-pill">
                                <span class="home-hero-pulse"></span>
                                ⚡ Streaming Anime P2P Instantané • TorrServer
                            </span>
                            <h1 class="home-hero-title">Votre univers Anime, <span class="home-hero-highlight">instantané & sans limite</span></h1>
                            <p class="home-hero-desc">
                                Diffusez vos épisodes en streaming direct via TorrServer & Torrentio, synchronisez automatiquement vos progrès avec AniList et profitez d'une reprise de lecture ultra-fluide à la seconde près.
                            </p>
                        `}
                        <div class="home-hero-actions">
                            <button class="btn-hero-primary" onclick="focusSearchInput()">
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                                <span>Rechercher un anime</span>
                            </button>
                            <button class="btn-hero-secondary" onclick="switchHomeTab('${hasAnilist ? 'anilist' : 'history'}')">
                                <span>🍿</span>
                                <span>${hasAnilist ? `Mes animes (${anilistCount})` : 'Mon historique'}</span>
                            </button>
                            <button class="btn-hero-accent" onclick="switchHomeTab('discover')">
                                <span>🔥</span>
                                <span>Tendances & Sorties</span>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Grille des 4 Hubs / Cartes de redirection rapide -->
                <div class="home-hub-grid">
                    <!-- Hub 1 : AniList en cours -->
                    <div class="home-hub-card home-hub-anilist" onclick="switchHomeTab('anilist')" title="Ouvrir la liste AniList en cours">
                        <div class="home-hub-card-header">
                            <div class="home-hub-card-icon">🍿</div>
                            <span class="home-hub-card-badge">${hasAnilist ? `${anilistCount} en cours` : 'Connexion'}</span>
                        </div>
                        <h3 class="home-hub-card-title">${hasAnilist ? `En cours • ${escapeHtml(userName)}` : 'AniList En cours'}</h3>
                        <p class="home-hub-card-desc">
                            ${hasAnilist ? `Vos ${anilistCount} séries synchronisées en temps réel. Reprenez l'épisode suivant d'un simple clic.` : 'Connectez votre compte AniList pour synchroniser votre progression et vos listes de lecture.'}
                        </p>
                        <div class="home-hub-card-footer">
                            <span>${hasAnilist ? 'Ouvrir ma liste' : 'Se connecter à AniList'}</span>
                            <span class="home-hub-card-arrow">→</span>
                        </div>
                    </div>

                    <!-- Hub 2 : Tendances & Découverte -->
                    <div class="home-hub-card home-hub-discover" onclick="switchHomeTab('discover')" title="Découvrir les tendances et sorties de la saison">
                        <div class="home-hub-card-header">
                            <div class="home-hub-card-icon">🔥</div>
                            <span class="home-hub-card-badge">Catalogue</span>
                        </div>
                        <h3 class="home-hub-card-title">Tendances & Découverte</h3>
                        <p class="home-hub-card-desc">
                            Explorez les séries les plus populaires cette semaine, les nouvelles sorties de la saison et les comptes à rebours de sortie.
                        </p>
                        <div class="home-hub-card-footer">
                            <span>Explorer les tendances</span>
                            <span class="home-hub-card-arrow">→</span>
                        </div>
                    </div>

                    <!-- Hub 3 : Planning des sorties -->
                    <div class="home-hub-card home-hub-schedule" onclick="switchHomeTab('schedule')" title="Consulter le calendrier hebdomadaire des sorties simulcast">
                        <div class="home-hub-card-header">
                            <div class="home-hub-card-icon">📅</div>
                            <span class="home-hub-card-badge">Simulcast</span>
                        </div>
                        <h3 class="home-hub-card-title">Planning des Sorties</h3>
                        <p class="home-hub-card-desc">
                            Calendrier jour par jour avec horaires de diffusion en direct, état de sortie et accès direct aux épisodes.
                        </p>
                        <div class="home-hub-card-footer">
                            <span>Voir le planning</span>
                            <span class="home-hub-card-arrow">→</span>
                        </div>
                    </div>

                    <!-- Hub 4 : Historique de lecture -->
                    <div class="home-hub-card home-hub-history" onclick="switchHomeTab('history')" title="Consulter l'historique de lecture">
                        <div class="home-hub-card-header">
                            <div class="home-hub-card-icon">🕒</div>
                            <span class="home-hub-card-badge">${histCount > 0 ? `${histCount} vidéo${histCount > 1 ? 's' : ''}` : 'Lecteur'}</span>
                        </div>
                        <h3 class="home-hub-card-title">Historique de lecture</h3>
                        <p class="home-hub-card-desc">
                            Reprenez chaque vidéo ou épisode exactement à la seconde où vous vous êtes arrêté, sans aucune configuration.
                        </p>
                        <div class="home-hub-card-footer">
                            <span>Accéder à l'historique</span>
                            <span class="home-hub-card-arrow">→</span>
                        </div>
                    </div>

                    <!-- Hub 5 : Favoris -->
                    <div class="home-hub-card home-hub-favorites" onclick="switchHomeTab('favorites')" title="Voir mes animes favoris">
                        <div class="home-hub-card-header">
                            <div class="home-hub-card-icon">❤️</div>
                            <span class="home-hub-card-badge">${favCount > 0 ? `${favCount} favori${favCount > 1 ? 's' : ''}` : 'Collection'}</span>
                        </div>
                        <h3 class="home-hub-card-title">Mes Favoris</h3>
                        <p class="home-hub-card-desc">
                            Retrouvez instantanément vos séries coup de cœur, torrents favoris et contenus sauvegardés pour plus tard.
                        </p>
                        <div class="home-hub-card-footer">
                            <span>Voir mes favoris</span>
                            <span class="home-hub-card-arrow">→</span>
                        </div>
                    </div>
                </div>

                <!-- Aperçu Continuer vos visionnages -->
                ${continueWatchingSectionHtml}

                <!-- Aperçu Tendances du moment -->
                ${trendingSectionHtml}
            </div>
        `;
    }

    // Rendu de l'écran d'accueil avec onglets (Accueil, Découverte, AniList, Historique local, Favoris)
    function renderHomeScreen() {
        const homeView = document.getElementById('homeView');
        if (!homeView) return;

        const token = localStorage.getItem('anilist_token');
        const hasAnilist = !!(token && currentAnilistUser);
        const activeTab = (typeof getActiveHomeTab === 'function') ? getActiveHomeTab() : 'home';

        const histCount = (typeof getPlaybackHistory === 'function') ? getPlaybackHistory().length : 0;
        const favCount = (typeof getFavorites === 'function') ? getFavorites().length : 0;
        const anilistCount = (anilistWatchingList && anilistWatchingList.length) ? anilistWatchingList.length : 0;

        let tabsHtml = `
            <div class="home-tabs-nav">
                <button class="home-tab-btn ${activeTab === 'home' ? 'active' : ''}" onclick="switchHomeTab('home')">
                    <span>🏠 Accueil</span>
                </button>
                <button class="home-tab-btn ${activeTab === 'discover' ? 'active' : ''}" onclick="switchHomeTab('discover')">
                    <span>🔥 Découverte</span>
                </button>
                <button class="home-tab-btn ${activeTab === 'schedule' ? 'active' : ''}" onclick="switchHomeTab('schedule')">
                    <span>📅 Planning</span>
                </button>
                ${hasAnilist ? `
                    <button class="home-tab-btn ${activeTab === 'anilist' ? 'active' : ''}" onclick="switchHomeTab('anilist')">
                        <span>🍿 AniList En cours</span>
                        <span class="home-tab-badge">${anilistCount}</span>
                    </button>
                ` : ''}
                <button class="home-tab-btn ${activeTab === 'history' ? 'active' : ''}" onclick="switchHomeTab('history')">
                    <span>🕒 Historique</span>
                    ${histCount > 0 ? `<span class="home-tab-badge">${histCount}</span>` : ''}
                </button>
                <button class="home-tab-btn ${activeTab === 'favorites' ? 'active' : ''}" onclick="switchHomeTab('favorites')">
                    <span>❤️ Favoris</span>
                    ${favCount > 0 ? `<span class="home-tab-badge">${favCount}</span>` : ''}
                </button>
                ${typeof currentAnimflixUser !== 'undefined' && currentAnimflixUser ? `
                    <button class="home-tab-btn ${activeTab === 'downloads' ? 'active' : ''}" onclick="switchHomeTab('downloads')">
                        <span>💾 Sur le serveur</span>
                        ${typeof serverDownloads !== 'undefined' && serverDownloads.items.length > 0 ? `<span class="home-tab-badge">${serverDownloads.items.length}</span>` : ''}
                    </button>
                ` : ''}
                <button class="home-tab-btn ${activeTab === 'stats' ? 'active' : ''}" onclick="switchHomeTab('stats')">
                    <span>📊 Stats</span>
                </button>
                ${typeof isCurrentUserAdmin === 'function' && isCurrentUserAdmin() ? `
                    <button class="home-tab-btn ${activeTab === 'admin' ? 'active' : ''}" onclick="switchHomeTab('admin')">
                        <span>🛠️ Serveur</span>
                    </button>
                ` : ''}
                ${!hasAnilist ? `
                    <button class="home-tab-btn ${activeTab === 'anilist' ? 'active' : ''}" onclick="switchHomeTab('anilist')" style="margin-left: auto;">
                        <span>☁️ Connexion AniList</span>
                    </button>
                ` : ''}
            </div>
            <div id="homeTabContent"></div>
        `;

        homeView.innerHTML = tabsHtml;
        const tabContent = document.getElementById('homeTabContent');
        if (!tabContent) return;

        if (activeTab === 'home') {
            renderHomeMainDashboardHtml(tabContent);
        } else if (activeTab === 'discover') {
            renderDiscoverTabHtml(tabContent);
        } else if (activeTab === 'schedule') {
            renderScheduleTabHtml(tabContent);
        } else if (activeTab === 'history' && typeof renderHistoryTabHtml === 'function') {
            renderHistoryTabHtml(tabContent);
        } else if (activeTab === 'favorites' && typeof renderFavoritesTabHtml === 'function') {
            renderFavoritesTabHtml(tabContent);
        } else if (activeTab === 'downloads' && typeof renderDownloadsTabHtml === 'function') {
            renderDownloadsTabHtml(tabContent);
        } else if (activeTab === 'stats' && typeof renderStatsTabHtml === 'function') {
            renderStatsTabHtml(tabContent);
        } else if (activeTab === 'admin' && typeof renderAdminTabHtml === 'function') {
            renderAdminTabHtml(tabContent);
        } else {
            // Tab anilist
            if (hasAnilist) {
                if (anilistWatchingList && anilistWatchingList.length > 0) {
                    renderWatchingListHtml(tabContent, anilistWatchingList);
                } else {
                    let cached = null;
                    try {
                        const raw = localStorage.getItem('anilist_watching_cache');
                        if (raw) cached = JSON.parse(raw);
                    } catch(e) {}

                    if (cached && cached.length > 0) {
                        anilistWatchingList = cached;
                        renderWatchingListHtml(tabContent, anilistWatchingList);
                    } else if (isLoadingWatchingList) {
                        renderWatchingEmptyOrLoading(tabContent);
                    } else {
                        renderWatchingEmptyList(tabContent);
                    }
                }
            } else {
                renderLoggedOutHomeHtml(tabContent);
            }
        }
    }


    function renderWatchingCards(displayList) {
        let cardsHtml = '';
        displayList.forEach(entry => {
            const media = entry.media || {};
            // Priorité au titre anglais pour l'affichage et la recherche selon la demande
            const displayTitle = media.title?.english || media.title?.userPreferred || media.title?.romaji || 'Anime';
            const secondaryTitle = (media.title?.romaji && media.title.romaji !== displayTitle) ? media.title.romaji : '';
            const isAdult = media.isAdult === true || (Array.isArray(media.genres) && media.genres.includes('Hentai'));
            const progress = entry.progress || 0;
            const total = media.episodes || null;
            const nextEp = progress + 1;
            const isCompleted = total && progress >= total;
            const progressPct = total ? Math.min(100, Math.round((progress / total) * 100)) : (progress > 0 ? 50 : 0);
            const poster = media.coverImage?.large || media.coverImage?.extraLarge || media.coverImage?.medium || posterFallback(displayTitle);
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

            const nsfwBadge = isAdult ? `<span class="badge-tag-mini badge-nsfw-tag" title="Contenu 18+ / Adulte">🔞 18+</span>` : '';

            if (isNextEpUnreleased) {
                badgesTopHtml = `
                    ${nsfwBadge}
                    ${score ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.2);color:#ffc107;border-color:rgba(255,193,7,0.4);">⭐ ${score}</span>` : `<span class="badge-tag-mini">${escapeHtml(format)}</span>`}
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
                    ${nsfwBadge}
                    ${score ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.2);color:#ffc107;border-color:rgba(255,193,7,0.4);">⭐ ${score}</span>` : `<span class="badge-tag-mini">${escapeHtml(format)}</span>`}
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
                <div class="card card-watching" onclick="openAnimePage(${Number(media.id)})" title="${isNextEpUnreleased ? `Épisode ${nextAiring.episode} pas encore sorti` : `Ouvrir la fiche : épisode ${nextEp} à regarder`}">
                    <div class="card-img-wrap">
                        <img src="${escapeHtml(poster)}" loading="lazy" alt="${escapeHtml(displayTitle)}" ${posterOnErrorAttr('Anime')}>
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
                        <span class="card-title" title="${escapeHtml(displayTitle)}${secondaryTitle ? ' (' + escapeHtml(secondaryTitle) + ')' : ''}">${escapeHtml(displayTitle)}</span>
                        ${secondaryTitle ? `<div style="font-size: 11px; color: #718096; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px;">${escapeHtml(secondaryTitle)}</div>` : ''}
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
        return cardsHtml;
    }

    function renderWatchingListHtml(container, list) {
        const showNsfw = getShowNsfwPreference();
        // Compter les items adultes au total
        const totalNsfw = list.filter(entry => {
            const m = entry.media;
            return m && (m.isAdult === true || (Array.isArray(m.genres) && m.genres.includes('Hentai')));
        }).length;

        // Filtrer la liste à afficher selon la préférence NSFW
        const displayList = list.filter(entry => {
            const m = entry.media;
            const isAdult = m && (m.isAdult === true || (Array.isArray(m.genres) && m.genres.includes('Hentai')));
            return showNsfw || !isAdult;
        });

        const nsfwToggleHtml = `
            <div class="nsfw-filter-container" onclick="onNsfwContainerClick(event)" title="${showNsfw ? 'Désactiver le contenu adulte (18+)' : 'Afficher le contenu adulte (18+)'}">
                <label class="switch-nsfw" onclick="event.stopPropagation()">
                    <input type="checkbox" id="nsfwToggleInput" ${showNsfw ? 'checked' : ''} onchange="toggleNsfwFilter(this.checked)">
                    <span class="slider-nsfw"></span>
                </label>
                <span class="nsfw-filter-label">
                    🔞 18+ ${totalNsfw > 0 ? `<span class="badge-nsfw-count">(${totalNsfw})</span>` : ''}
                </span>
            </div>
        `;

        if (displayList.length === 0) {
            container.innerHTML = `
                <div class="home-watching-section">
                    <div class="home-watching-header">
                        <div class="home-watching-title-group">
                            <h2 class="home-watching-title">
                                <span style="font-size: 24px;">🍿</span>
                                En cours de visionnage
                            </h2>
                            <span class="home-watching-badge">0 anime</span>
                        </div>
                        <div class="home-watching-actions">
                            ${nsfwToggleHtml}
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
                    <div class="empty-state" style="padding: 50px 20px;">
                        <div style="font-size: 38px; margin-bottom: 12px;">🛡️</div>
                        <div style="font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;">
                            ${totalNsfw} anime${totalNsfw > 1 ? 's masqués' : ' masqué'} par le filtre 18+
                        </div>
                        <div style="font-size: 13.5px; color: #aaa; margin-bottom: 20px;">
                            Activez l'interrupteur "🔞 18+" en haut à droite pour afficher vos animes adultes en cours.
                        </div>
                        <button class="btn-secondary" onclick="toggleNsfwFilter(true)">
                            🔞 Activer le contenu 18+
                        </button>
                    </div>
                </div>
            `;
            return;
        }

        const cardsHtml = renderWatchingCards(displayList);

        container.innerHTML = `
            <div class="home-watching-section">
                <div class="home-watching-header">
                    <div class="home-watching-title-group">
                        <h2 class="home-watching-title">
                            <span style="font-size: 24px;">🍿</span>
                            ${currentAnilistUser?.name ? `Bienvenue ${escapeHtml(currentAnilistUser.name)} • Séries en cours` : 'En cours de visionnage'}
                        </h2>
                        <span class="home-watching-badge">${displayList.length} anime${displayList.length > 1 ? 's' : ''}</span>
                    </div>
                    <div class="home-watching-actions">
                        ${nsfwToggleHtml}
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
                ${renderSkeletonGrid(8, 'Chargement de vos animes en cours…')}
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
        const targetContainer = document.getElementById('homeTabContent') || homeView;
        targetContainer.innerHTML = `
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

