    // =========================================================================
    // --- SECTION PLANNING HEBDOMADAIRE (SIMULCAST AIRING SCHEDULE) ---
    // =========================================================================

    function getWeekScheduleTimestamps() {
        const now = new Date();
        const day = now.getDay();
        const diffToMonday = (day + 6) % 7;
        const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday, 0, 0, 0, 0);
        const start = Math.floor(monday.getTime() / 1000);
        const end = start + (7 * 86400);
        return { start, end, monday };
    }

    async function fetchWeekAiringSchedules(forceRefresh = false) {
        if (!forceRefresh) {
            try {
                const raw = localStorage.getItem(SCHEDULE_CACHE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.timestamp && (Date.now() - parsed.timestamp < SCHEDULE_CACHE_TTL) && parsed.dayBuckets) {
                        return parsed.dayBuckets;
                    }
                }
            } catch (e) {}
        }

        const { start, end } = getWeekScheduleTimestamps();
        const query = `
            query ($start: Int, $end: Int, $page: Int) {
                Page(page: $page, perPage: 50) {
                    pageInfo { hasNextPage }
                    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
                        id
                        airingAt
                        timeUntilAiring
                        episode
                        media {
                            id
                            title {
                                romaji
                                english
                                userPreferred
                            }
                            coverImage {
                                large
                            }
                            format
                            averageScore
                            genres
                            isAdult
                            popularity
                        }
                    }
                }
            }
        `;

        const [p1Res, p2Res] = await Promise.all([
            callAnilistGraphQL(query, { start, end, page: 1 }).catch(() => null),
            callAnilistGraphQL(query, { start, end, page: 2 }).catch(() => null)
        ]);

        const s1 = p1Res?.Page?.airingSchedules || [];
        const s2 = p2Res?.Page?.airingSchedules || [];
        const all = [...s1, ...s2];

        const seen = new Set();
        const unique = [];
        all.forEach(item => {
            if (item && item.id && !seen.has(item.id)) {
                seen.add(item.id);
                unique.push(item);
            }
        });

        const showNsfw = getShowNsfwPreference();
        const dayBuckets = [[], [], [], [], [], [], []];

        unique.forEach(item => {
            if (!item.media) return;
            if (!showNsfw && (item.media.isAdult || (item.media.genres && item.media.genres.includes('Hentai')))) return;
            const airDate = new Date(item.airingAt * 1000);
            const dayIdx = (airDate.getDay() + 6) % 7;
            dayBuckets[dayIdx].push(item);
        });

        dayBuckets.forEach(b => b.sort((a, b) => a.airingAt - b.airingAt));

        try {
            localStorage.setItem(SCHEDULE_CACHE_KEY, JSON.stringify({
                timestamp: Date.now(),
                dayBuckets
            }));
        } catch (e) {}

        return dayBuckets;
    }

    function watchScheduleEpisode(mediaId, title, epNumber, coverImage, airingAt) {
        const isReleased = (airingAt * 1000) <= Date.now();
        const diffMs = (airingAt * 1000) - Date.now();
        const targetInfo = {
            nextEp: epNumber,
            animeName: title,
            coverImage: coverImage,
            anilistMediaId: mediaId,
            isNextEpUnreleased: !isReleased,
            airingTimestamp: airingAt,
            airingCountdownStr: !isReleased ? formatAiringCountdown(diffMs) : ''
        };
        const input = document.getElementById('searchInput');
        if (input) input.value = title;
        if (typeof executeSearchForAnime === 'function') {
            executeSearchForAnime(title, targetInfo);
        }
    }

    function renderScheduleCards(items) {
        if (!items || items.length === 0) {
            return `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 50px 20px;">
                    <div style="font-size: 32px; margin-bottom: 10px;">☕</div>
                    <div style="font-size: 15px; color: #fff; font-weight: 600;">Aucune diffusion répertoriée ce jour-là.</div>
                    <div style="font-size: 13px; color: #888; margin-top: 4px;">Profitez-en pour rattraper vos animes en cours !</div>
                </div>
            `;
        }

        const now = Date.now();
        return items.map(item => {
            const m = item.media;
            const title = m.title?.userPreferred || m.title?.english || m.title?.romaji || 'Anime';
            const subTitle = (m.title?.english && m.title?.english !== title) ? m.title.english : (m.title?.romaji || '');
            const poster = m.coverImage?.large || '';
            const format = m.format || 'TV';
            const score = m.averageScore ? `${(m.averageScore / 10).toFixed(1)}` : null;
            const genres = Array.isArray(m.genres) ? m.genres.slice(0, 2) : [];
            const airingDate = new Date(item.airingAt * 1000);
            const timeStr = airingDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
            const isReleased = item.airingAt * 1000 <= now;
            const diffMs = (item.airingAt * 1000) - now;
            const countdownStr = !isReleased ? formatAiringCountdown(diffMs) : '';

            const safeTitle = escapeHtml(title);
            const safePoster = escapeHtml(poster);

            let statusBadge = '';
            if (isReleased) {
                statusBadge = `<span class="badge-tag-mini badge-schedule-released" title="Diffusé au Japon">✅ Disponible</span>`;
            } else {
                statusBadge = `
                    <span class="badge-tag-mini badge-tag-airing-timer badge-schedule-countdown" data-airing-at="${item.airingAt}" data-ep="${item.episode}" title="Diffusion à ${timeStr}">
                        ⏳ dans ${countdownStr}
                    </span>
                `;
            }

            return `
                <div class="card schedule-card ${isReleased ? 'schedule-card-released' : ''}" onclick="watchScheduleEpisode(${Number(m.id)}, ${jsArg(title)}, ${Number(item.episode)}, ${jsArg(poster)}, ${Number(item.airingAt)})" title="${safeTitle} - Épisode ${item.episode}">
                    <div class="card-img-wrap">
                        <img src="${safePoster}" loading="lazy" alt="${safeTitle}" onerror="this.src='https://via.placeholder.com/300x450/191919/666666?text=Anime'">
                        <div class="card-overlay-hover">
                            <span class="btn-play-hover" style="background: ${isReleased ? '#02a9ff' : '#d97706'};">
                                ${isReleased ? `▶ Voir Épisode ${item.episode}` : `⏳ Ép. ${item.episode} (Rechercher)`}
                            </span>
                        </div>
                        <div class="card-badges-top">
                            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                                <span class="badge-tag-mini badge-schedule-time">🕒 ${timeStr}</span>
                                ${score ? `<span class="badge-tag-mini" style="background:rgba(255,193,7,0.25);color:#ffc107;border-color:rgba(255,193,7,0.45);font-weight:800;">⭐ ${score}</span>` : ''}
                            </div>
                            ${statusBadge}
                        </div>
                    </div>
                    <div class="card-info">
                        <span class="card-title" title="${safeTitle}">${safeTitle}</span>
                        ${subTitle && subTitle !== title ? `<span style="font-size: 11px; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(subTitle)}">${escapeHtml(subTitle)}</span>` : ''}
                        <div class="schedule-ep-pill">
                            <span class="schedule-ep-num">🎬 Épisode <b>${item.episode}</b></span>
                            <span class="badge-tag-mini" style="margin: 0;">${escapeHtml(format)}</span>
                        </div>
                        <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px;">
                            ${genres.map(g => `<span class="badge-discover-genre">${escapeHtml(g)}</span>`).join('')}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    async function renderScheduleTabHtml(container, forceRefresh = false) {
        const targetContainer = container || document.getElementById('homeTabContent');
        if (!targetContainer) return;

        const { monday } = getWeekScheduleTimestamps();
        const todayIdx = (new Date().getDay() + 6) % 7;
        if (currentSelectedScheduleDay === null) {
            currentSelectedScheduleDay = todayIdx;
        }

        targetContainer.innerHTML = `
            <div class="schedule-container">
                <div class="discover-top-banner">
                    <div class="discover-top-title-group">
                        <h2>📅 Planning des Sorties Hebdomadaires</h2>
                        <p>Calendrier simulcast en direct — Horaires de diffusion des épisodes au Japon et heure locale</p>
                    </div>
                    <button class="btn-refresh-watching" onclick="renderScheduleTabHtml(null, true)" title="Actualiser le calendrier">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="23 4 23 10 17 10"></polyline>
                            <polyline points="1 20 1 14 7 14"></polyline>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                        </svg>
                        <span>Actualiser</span>
                    </button>
                </div>
                <div class="empty-state" style="padding: 60px 20px;">
                    <div class="spinner" style="margin: 0 auto 20px;"></div>
                    Chargement du calendrier des sorties de la semaine... ⏳
                </div>
            </div>
        `;

        try {
            const dayBuckets = await fetchWeekAiringSchedules(forceRefresh);
            cachedWeekDayBuckets = dayBuckets;

            let pillsHtml = '';
            SCHEDULE_DAYS.forEach((name, idx) => {
                const dayDate = new Date(monday.getTime() + idx * 86400000);
                const dateStr = dayDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
                const isToday = (idx === todayIdx);
                const isActive = (idx === currentSelectedScheduleDay);
                const count = (dayBuckets[idx] || []).length;

                pillsHtml += `
                    <button type="button" class="schedule-day-pill ${isActive ? 'active' : ''} ${isToday ? 'is-today' : ''}" onclick="selectScheduleDay(${idx})">
                        <span class="schedule-day-name">${name}</span>
                        <span class="schedule-day-date">${dateStr}</span>
                        <span class="schedule-day-badge">${count}</span>
                        ${isToday ? '<span class="schedule-today-tag">Aujourd\'hui</span>' : ''}
                    </button>
                `;
            });

            const activeDayEpisodes = dayBuckets[currentSelectedScheduleDay] || [];
            const activeDayDate = new Date(monday.getTime() + currentSelectedScheduleDay * 86400000);
            const activeDateFormatted = activeDayDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

            targetContainer.innerHTML = `
                <div class="schedule-container">
                    <div class="discover-top-banner">
                        <div class="discover-top-title-group">
                            <h2>📅 Planning des Sorties Hebdomadaires</h2>
                            <p>Calendrier simulcast en direct — Horaires de diffusion des épisodes au Japon et heure locale</p>
                        </div>
                        <button class="btn-refresh-watching" onclick="renderScheduleTabHtml(null, true)" title="Actualiser le calendrier">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                            <span>Actualiser</span>
                        </button>
                    </div>

                    <!-- Barre des 7 jours de la semaine -->
                    <div class="schedule-days-bar-wrapper">
                        <div class="schedule-days-bar" id="scheduleDaysBar">
                            ${pillsHtml}
                        </div>
                    </div>

                    <!-- En-tête du jour sélectionné -->
                    <div class="schedule-day-header">
                        <div class="schedule-day-title-wrap">
                            <h3 class="schedule-day-title">
                                <span>✨ Sorties du ${activeDateFormatted}</span>
                            </h3>
                            <span class="schedule-count-pill">${activeDayEpisodes.length} épisode${activeDayEpisodes.length > 1 ? 's' : ''}</span>
                        </div>
                    </div>

                    <!-- Grille des épisodes du jour sélectionné -->
                    <div class="grid" id="scheduleGridContainer">
                        ${renderScheduleCards(activeDayEpisodes)}
                    </div>
                </div>
            `;

            if (typeof startAiringCountdownTicker === 'function') {
                startAiringCountdownTicker();
            }
        } catch (err) {
            console.error('[Schedule] Erreur chargement planning:', err);
            targetContainer.innerHTML = `
                <div class="schedule-container">
                    <div class="empty-state" style="padding: 50px 20px; color: #ff525d;">
                        <div style="font-size: 38px; margin-bottom: 12px;">⚠️</div>
                        <div style="font-size: 16px; font-weight: bold; color: #fff; margin-bottom: 8px;">
                            Impossible de charger le planning des sorties
                        </div>
                        <div style="font-size: 13.5px; color: #aaa; margin-bottom: 20px;">
                            ${escapeHtml(err.message || 'Erreur réseau temporaire')}
                        </div>
                        <button class="btn-refresh-watching" onclick="renderScheduleTabHtml(null, true)">
                            🔄 Réessayer
                        </button>
                    </div>
                </div>
            `;
        }
    }

    function selectScheduleDay(dayIdx) {
        currentSelectedScheduleDay = dayIdx;
        if (!cachedWeekDayBuckets) {
            renderScheduleTabHtml();
            return;
        }

        const { monday } = getWeekScheduleTimestamps();
        const pills = document.querySelectorAll('.schedule-day-pill');
        pills.forEach((p, idx) => {
            if (idx === dayIdx) p.classList.add('active');
            else p.classList.remove('active');
        });

        const activeDayEpisodes = cachedWeekDayBuckets[dayIdx] || [];
        const activeDayDate = new Date(monday.getTime() + dayIdx * 86400000);
        const activeDateFormatted = activeDayDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

        const headerEl = document.querySelector('.schedule-day-title');
        if (headerEl) headerEl.innerHTML = `<span>✨ Sorties du ${activeDateFormatted}</span>`;

        const countEl = document.querySelector('.schedule-count-pill');
        if (countEl) countEl.innerText = `${activeDayEpisodes.length} épisode${activeDayEpisodes.length > 1 ? 's' : ''}`;

        const gridEl = document.getElementById('scheduleGridContainer');
        if (gridEl) {
            gridEl.innerHTML = renderScheduleCards(activeDayEpisodes);
        }
        if (typeof startAiringCountdownTicker === 'function') {
            startAiringCountdownTicker();
        }
    }

