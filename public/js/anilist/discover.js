    // --- SECTION DÉCOUVERTE & PLANNING (TENDANCES, FILTRES & SORTIES SIMULCAST) ---
    const DISCOVER_CACHE_KEY = 'animflix_discover_cache_v2';
    const DISCOVER_CACHE_TTL = 30 * 60 * 1000; // 30 minutes de validité
    const SCHEDULE_CACHE_KEY = 'animflix_schedule_cache_v2';
    const SCHEDULE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes de validité
    const SCHEDULE_DAYS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

    const DISCOVER_GENRES = [
        { id: 'all', label: 'Tous genres' },
        { id: 'Action', label: 'Action' },
        { id: 'Adventure', label: 'Aventure' },
        { id: 'Comedy', label: 'Comédie' },
        { id: 'Drama', label: 'Drame' },
        { id: 'Fantasy', label: 'Fantasy' },
        { id: 'Romance', label: 'Romance' },
        { id: 'Sci-Fi', label: 'Sci-Fi' },
        { id: 'Slice of Life', label: 'Slice of Life' },
        { id: 'Supernatural', label: 'Surnaturel' },
        { id: 'Mystery', label: 'Mystère' },
        { id: 'Psychological', label: 'Psychologique' },
        { id: 'Sports', label: 'Sports' },
        { id: 'Thriller', label: 'Thriller' }
    ];

    const DISCOVER_SORTS = [
        { id: 'trending', label: '🔥 Tendances', desc: 'Les plus discutés cette semaine' },
        { id: 'season', label: '🌸 Saison en cours', desc: 'Sorties populaires de la saison' },
        { id: 'score', label: '⭐ Les mieux notés', desc: 'Classés par note moyenne' },
        { id: 'popular', label: '👑 Plus populaires', desc: 'Tous les temps' }
    ];

    const DISCOVER_FORMATS = [
        { id: 'all', label: 'Tous formats' },
        { id: 'TV', label: '📺 Séries TV' },
        { id: 'MOVIE', label: '🎬 Films' },
        { id: 'OVA', label: '📀 OVA / ONA' }
    ];

    let currentDiscoverGenre = 'all';
    let currentDiscoverFormat = 'all';
    let currentDiscoverSort = 'trending';
    let currentDiscoverSearch = '';

    let currentSelectedScheduleDay = null; // 0 (Lundi) à 6 (Dimanche)
    let cachedWeekDayBuckets = null; // 7 tableaux pour chaque jour

    function getCurrentAnimeSeasonInfo() {
        const now = new Date();
        const month = now.getMonth(); // 0 à 11
        const year = now.getFullYear();

        if (month === 11) {
            return { season: 'WINTER', seasonYear: year + 1, labelFr: `Hiver ${year + 1}` };
        } else if (month <= 1) {
            return { season: 'WINTER', seasonYear: year, labelFr: `Hiver ${year}` };
        } else if (month >= 2 && month <= 4) {
            return { season: 'SPRING', seasonYear: year, labelFr: `Printemps ${year}` };
        } else if (month >= 5 && month <= 7) {
            return { season: 'SUMMER', seasonYear: year, labelFr: `Été ${year}` };
        } else {
            return { season: 'FALL', seasonYear: year, labelFr: `Automne ${year}` };
        }
    }

    function formatTimeUntilAiring(seconds) {
        if (!seconds || seconds <= 0) return '';
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);

        if (days > 0) return `${days}j ${hours}h`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    }

    function searchFromDiscover(animeTitle, coverImage, anilistId) {
        // Fiche anime (épisodes + lecture en un clic) dès que l'ID AniList est connu
        if (anilistId && typeof openAnimePage === 'function') {
            openAnimePage(anilistId);
            return;
        }
        if (!animeTitle) return;
        const input = document.getElementById('searchInput');
        if (input) input.value = animeTitle;
        if (typeof executeSearchForAnime === 'function') {
            executeSearchForAnime(animeTitle, {
                animeName: animeTitle,
                coverImage: coverImage,
                anilistMediaId: anilistId
            });
        }
    }

    function renderDiscoverFilterBarHtml() {
        return `
            <div class="discover-filters-container">
                <!-- Ligne 1 : Sélection du Tri, Format et Recherche -->
                <div class="discover-filters-main-row">
                    <div class="discover-sort-pills">
                        ${DISCOVER_SORTS.map(s => `
                            <button type="button" class="discover-sort-pill ${currentDiscoverSort === s.id ? 'active' : ''}" onclick="onDiscoverFilterChange('sort', '${s.id}')" title="${s.desc}">
                                ${s.label}
                            </button>
                        `).join('')}
                    </div>
                    <div class="discover-filters-right">
                        <select class="discover-format-select" onchange="onDiscoverFilterChange('format', this.value)" title="Filtrer par format vidéo">
                            ${DISCOVER_FORMATS.map(f => `
                                <option value="${f.id}" ${currentDiscoverFormat === f.id ? 'selected' : ''}>${f.label}</option>
                            `).join('')}
                        </select>
                        <div class="discover-search-box">
                            <input type="text" id="discoverSearchInput" placeholder="Rechercher par titre..." value="${escapeHtml(currentDiscoverSearch)}" onkeypress="if(event.key === 'Enter') onDiscoverFilterChange('search', this.value)">
                            <button type="button" onclick="onDiscoverFilterChange('search', document.getElementById('discoverSearchInput')?.value || '')" title="Lancer la recherche">🔍</button>
                        </div>
                    </div>
                </div>

                <!-- Ligne 2 : Chips des genres -->
                <div class="discover-genres-bar">
                    <span class="discover-genres-label">Genres :</span>
                    <div class="discover-genres-scroll">
                        ${DISCOVER_GENRES.map(g => `
                            <button type="button" class="discover-genre-chip ${currentDiscoverGenre === g.id ? 'active' : ''}" onclick="onDiscoverFilterChange('genre', '${g.id}')">
                                ${g.label}
                            </button>
                        `).join('')}
                    </div>
                </div>
            </div>
        `;
    }

    async function fetchFilteredDiscover(page = 1) {
        const seasonInfo = getCurrentAnimeSeasonInfo();
        const sortMap = {
            trending: ['TRENDING_DESC'],
            season: ['POPULARITY_DESC'],
            score: ['SCORE_DESC'],
            popular: ['POPULARITY_DESC']
        };

        const variables = {
            page: page,
            perPage: 24,
            genre: currentDiscoverGenre !== 'all' ? currentDiscoverGenre : undefined,
            format: currentDiscoverFormat !== 'all' ? currentDiscoverFormat : undefined,
            sort: sortMap[currentDiscoverSort] || ['TRENDING_DESC'],
            season: currentDiscoverSort === 'season' ? seasonInfo.season : undefined,
            seasonYear: currentDiscoverSort === 'season' ? seasonInfo.seasonYear : undefined,
            search: currentDiscoverSearch.trim() ? currentDiscoverSearch.trim() : undefined
        };

        const query = `
            query ($page: Int, $perPage: Int, $genre: String, $format: MediaFormat, $sort: [MediaSort], $season: MediaSeason, $seasonYear: Int, $search: String) {
                Page(page: $page, perPage: $perPage) {
                    media(type: ANIME, genre: $genre, format: $format, sort: $sort, season: $season, seasonYear: $seasonYear, search: $search, isAdult: false) {
                        id
                        title {
                            romaji
                            english
                            userPreferred
                        }
                        coverImage {
                            large
                        }
                        bannerImage
                        format
                        episodes
                        status
                        averageScore
                        genres
                        nextAiringEpisode {
                            episode
                            timeUntilAiring
                        }
                    }
                }
            }
        `;

        const data = await callAnilistGraphQL(query, variables);
        return data?.Page?.media || [];
    }

    async function onDiscoverFilterChange(type, value) {
        if (type === 'sort') currentDiscoverSort = value;
        if (type === 'genre') currentDiscoverGenre = value;
        if (type === 'format') currentDiscoverFormat = value;
        if (type === 'search') currentDiscoverSearch = value || '';

        const isDefault = (currentDiscoverGenre === 'all' && currentDiscoverFormat === 'all' && currentDiscoverSort === 'trending' && !currentDiscoverSearch);

        if (isDefault) {
            renderDiscoverTabHtml();
            return;
        }

        const resultsArea = document.getElementById('discoverResultsSection');
        const filtersArea = document.querySelector('.discover-filters-container');
        if (filtersArea) {
            filtersArea.outerHTML = renderDiscoverFilterBarHtml();
        }

        if (resultsArea) {
            resultsArea.innerHTML = `
                ${renderSkeletonGrid(12, 'Recherche des animes filtrés…')}
            `;
        }

        try {
            const list = await fetchFilteredDiscover();
            if (resultsArea) {
                resultsArea.innerHTML = `
                    <div class="discover-section">
                        <div class="discover-section-header">
                            <h3 class="discover-section-title">
                                <span>✨ Sélection personnalisée</span>
                                <span class="discover-section-subtitle">${list.length} anime(s) trouvé(s)</span>
                            </h3>
                            <button type="button" class="btn-reset-filters" onclick="resetDiscoverFilters()" title="Réinitialiser les filtres">
                                ✕ Réinitialiser
                            </button>
                        </div>
                        <div class="grid">
                            ${renderDiscoverCards(list)}
                        </div>
                    </div>
                `;
            }
        } catch (e) {
            if (resultsArea) {
                resultsArea.innerHTML = `
                    <div class="empty-state" style="padding: 50px 20px; color: #ff525d;">
                        Erreur chargement des résultats : ${escapeHtml(e.message)}
                        <br><br>
                        <button class="btn-refresh-watching" onclick="resetDiscoverFilters()">Réinitialiser</button>
                    </div>
                `;
            }
        }
    }

    function resetDiscoverFilters() {
        currentDiscoverGenre = 'all';
        currentDiscoverFormat = 'all';
        currentDiscoverSort = 'trending';
        currentDiscoverSearch = '';
        renderDiscoverTabHtml();
    }

    function renderDiscoverCards(mediaList) {
        if (!mediaList || mediaList.length === 0) {
            return '<div class="empty-state" style="grid-column: 1 / -1;">Aucun anime trouvé pour cette sélection.</div>';
        }
        return mediaList.map(m => {
            const title = m.title?.userPreferred || m.title?.english || m.title?.romaji || 'Anime';
            const subTitle = (m.title?.english && m.title?.english !== title) ? m.title.english : (m.title?.romaji || '');
            const poster = m.coverImage?.large || '';
            const format = m.format || 'TV';
            const score = m.averageScore ? `${(m.averageScore / 10).toFixed(1)}` : null;
            const genres = Array.isArray(m.genres) ? m.genres.slice(0, 3) : [];
            
            let airingBadge = '';
            if (m.nextAiringEpisode) {
                const timeStr = formatTimeUntilAiring(m.nextAiringEpisode.timeUntilAiring);
                airingBadge = `<span class="badge-tag-mini badge-airing-countdown">⏳ Ép. ${m.nextAiringEpisode.episode} ${timeStr ? `dans ${timeStr}` : ''}</span>`;
            } else if (m.episodes) {
                airingBadge = `<span class="badge-tag-mini">${m.episodes} épisodes</span>`;
            } else if (m.status === 'RELEASING') {
                airingBadge = `<span class="badge-tag-mini" style="background:rgba(70,211,105,0.25);color:#5eff88;border-color:rgba(70,211,105,0.4);">En cours</span>`;
            }

            const safeTitle = escapeHtml(title);
            const safePoster = escapeHtml(poster);

            return `
                <div class="card discover-card" onclick="searchFromDiscover(${jsArg(title)}, ${jsArg(poster)}, ${Number(m.id)})" title="Ouvrir la fiche de ${safeTitle}">
                    <div class="card-img-wrap">
                        <img src="${safePoster}" loading="lazy" alt="${safeTitle}" ${posterOnErrorAttr('Anime')}>
                        <div class="card-overlay-hover">
                            <span class="btn-play-hover" style="background: #02a9ff; box-shadow: 0 4px 12px rgba(2,169,255,0.5);">
                                🔍 Voir les torrents & épisodes
                            </span>
                        </div>
                        <div class="card-badges-top">
                            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                                ${score ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.25);color:#ffc107;border-color:rgba(255,193,7,0.45);font-weight:800;">⭐ ${score}</span>` : ''}
                                <span class="badge-tag-mini">${escapeHtml(format)}</span>
                            </div>
                            ${airingBadge}
                        </div>
                    </div>
                    <div class="card-info">
                        <span class="card-title" title="${safeTitle}">${safeTitle}</span>
                        ${subTitle && subTitle !== title ? `<span style="font-size: 11px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(subTitle)}">${escapeHtml(subTitle)}</span>` : ''}
                        <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px;">
                            ${genres.map(g => `<span class="badge-discover-genre">${escapeHtml(g)}</span>`).join('')}
                        </div>
                        <div class="card-next-ep-btn-pill" style="margin-top: 8px;">
                            <span>🔍 Voir les torrents disponibles</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    function renderDiscoverDom(container, data, seasonInfo) {
        const trendingList = data?.trending?.media || [];
        const seasonList = data?.season?.media || [];

        container.innerHTML = `
            <div class="discover-container">
                <div class="discover-top-banner">
                    <div class="discover-top-title-group">
                        <h2>🔥 Découverte & Nouveautés</h2>
                        <p>Explorez les tendances et sorties de la saison ${seasonInfo.labelFr} — Cliquez sur une carte pour lancer la recherche et regarder !</p>
                    </div>
                    <button class="btn-refresh-watching" onclick="renderDiscoverTabHtml(null, true)" title="Rafraîchir les tendances AniList">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"></polyline>
                            <polyline points="1 20 1 14 7 14"></polyline>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                        </svg>
                        <span>Actualiser</span>
                    </button>
                </div>

                <!-- Barre d'outils et de filtres avancés -->
                ${renderDiscoverFilterBarHtml()}

                <!-- Section des résultats (dynamique ou par défaut) -->
                <div id="discoverResultsSection">
                    <div class="discover-section">
                        <div class="discover-section-header">
                            <h3 class="discover-section-title">
                                <span>🔥 Tendances du moment</span>
                                <span class="discover-section-subtitle">Les séries les plus populaires cette semaine</span>
                            </h3>
                        </div>
                        <div class="grid">
                            ${renderDiscoverCards(trendingList)}
                        </div>
                    </div>

                    <div class="discover-section" style="margin-top: 14px;">
                        <div class="discover-section-header">
                            <h3 class="discover-section-title">
                                <span>🌸 Saison en cours (${seasonInfo.labelFr})</span>
                                <span class="discover-section-subtitle">Les sorties populaires de la saison</span>
                            </h3>
                        </div>
                        <div class="grid">
                            ${renderDiscoverCards(seasonList)}
                        </div>
                    </div>
                </div>
            </div>
        `;
    }

    async function renderDiscoverTabHtml(container, forceRefresh = false) {
        const targetContainer = container || document.getElementById('homeTabContent');
        if (!targetContainer) return;

        const isDefault = (currentDiscoverGenre === 'all' && currentDiscoverFormat === 'all' && currentDiscoverSort === 'trending' && !currentDiscoverSearch);

        // Si des filtres personnalisés sont actifs, charger la vue filtrée
        if (!isDefault) {
            targetContainer.innerHTML = `
                <div class="discover-container">
                    <div class="discover-top-banner">
                        <div class="discover-top-title-group">
                            <h2>🔥 Découverte & Nouveautés</h2>
                            <p>Recherche personnalisée par genres, formats et classements</p>
                        </div>
                    </div>
                    ${renderDiscoverFilterBarHtml()}
                    <div id="discoverResultsSection"></div>
                </div>
            `;
            renderFilteredDiscoverView();
            return;
        }

        const seasonInfo = getCurrentAnimeSeasonInfo();

        // 1. Vérification du cache local
        let cached = null;
        if (!forceRefresh) {
            try {
                const raw = localStorage.getItem(DISCOVER_CACHE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.timestamp && (Date.now() - parsed.timestamp < DISCOVER_CACHE_TTL) && parsed.data) {
                        cached = parsed;
                    }
                }
            } catch (e) {
                console.warn('[Discover] Erreur lecture cache:', e);
            }
        }

        if (cached && cached.data) {
            renderDiscoverDom(targetContainer, cached.data, seasonInfo);
            return;
        }

        // Loader
        targetContainer.innerHTML = `
            <div class="discover-container">
                <div class="discover-top-banner">
                    <div class="discover-top-title-group">
                        <h2>🔥 Découverte & Nouveautés</h2>
                        <p>Explorez les tendances et sorties de la saison ${seasonInfo.labelFr}</p>
                    </div>
                </div>
                ${renderDiscoverFilterBarHtml()}
                ${renderSkeletonGrid(12, 'Chargement des tendances…')}
            </div>
        `;

        try {
            const query = `
                query ($season: MediaSeason, $seasonYear: Int) {
                    trending: Page(page: 1, perPage: 12) {
                        media(type: ANIME, sort: TRENDING_DESC, isAdult: false) {
                            id
                            title {
                                romaji
                                english
                                userPreferred
                            }
                            coverImage {
                                large
                            }
                            bannerImage
                            format
                            episodes
                            status
                            averageScore
                            genres
                            nextAiringEpisode {
                                episode
                                timeUntilAiring
                            }
                        }
                    }
                    season: Page(page: 1, perPage: 12) {
                        media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC, isAdult: false) {
                            id
                            title {
                                romaji
                                english
                                userPreferred
                            }
                            coverImage {
                                large
                            }
                            bannerImage
                            format
                            episodes
                            status
                            averageScore
                            genres
                            nextAiringEpisode {
                                episode
                                timeUntilAiring
                            }
                        }
                    }
                }
            `;

            const variables = {
                season: seasonInfo.season,
                seasonYear: seasonInfo.seasonYear
            };

            const data = await callAnilistGraphQL(query, variables);

            try {
                localStorage.setItem(DISCOVER_CACHE_KEY, JSON.stringify({
                    timestamp: Date.now(),
                    seasonInfo,
                    data
                }));
            } catch (e) {}

            renderDiscoverDom(targetContainer, data, seasonInfo);
        } catch (err) {
            console.error('[Discover] Erreur chargement découverte:', err);
            targetContainer.innerHTML = `
                <div class="discover-container">
                    <div class="discover-top-banner">
                        <div class="discover-top-title-group">
                            <h2>🔥 Découverte & Nouveautés</h2>
                            <p>Explorez les tendances et sorties de la saison ${seasonInfo.labelFr}</p>
                        </div>
                    </div>
                    <div class="empty-state" style="padding: 50px 20px; color: #ff525d;">
                        <div style="font-size: 38px; margin-bottom: 12px;">⚠️</div>
                        <div style="font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;">
                            Impossible de contacter AniList pour récupérer les tendances
                        </div>
                        <div style="font-size: 13.5px; color: #aaa; margin-bottom: 20px;">
                            ${escapeHtml(err.message || 'Erreur réseau temporaire')}
                        </div>
                        <button class="btn-refresh-watching" onclick="renderDiscoverTabHtml(null, true)">
                            🔄 Réessayer
                        </button>
                    </div>
                </div>
            `;
        }
    }

