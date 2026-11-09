// =========================================================================
// --- FICHE ANIME (ANILIST) : ÉPISODES, PROGRESSION & LECTURE EN UN CLIC ---
// =========================================================================
//
// Une fiche = un média AniList. Les torrents Nyaa sont cherchés en arrière-plan,
// chaque épisode indique s'il a une source, et un clic lance le meilleur torrent
// (préférences de release > résolution > seeders). La liste brute reste accessible
// via « Choisir la source ».

    const ANIME_MEDIA_CACHE_TTL = 10 * 60 * 1000;
    const ANIME_EP_RANGE_SIZE = 100;
    const animeMediaCache = new Map(); // id -> { media, fetchedAt }

    const animePageState = {
        id: null,
        media: null,
        highlightEp: null,
        rangeStart: 1,
        torrents: null,          // résultats Nyaa (titre principal), null = pas encore cherché
        torrentsKey: null,       // `${id}|${type}` des résultats ci-dessus
        torrentsQuery: null,     // titre qui a donné des résultats
        torrentsPromise: null,
        availability: new Map(), // ep -> 'single' | 'pack'
        playingEp: null,
        synopsisOpen: false
    };
    window._currentAnimePageId = null;

    // --- DONNÉES ANILIST ---

    async function fetchAnimeMedia(id, force = false) {
        const cached = animeMediaCache.get(id);
        if (!force && cached && (Date.now() - cached.fetchedAt) < ANIME_MEDIA_CACHE_TTL) return cached.media;

        const token = localStorage.getItem('anilist_token');
        const query = `
            query ($id: Int) {
                Media(id: $id, type: ANIME) {
                    id
                    idMal
                    title { romaji english native userPreferred }
                    synonyms
                    description(asHtml: false)
                    format
                    status
                    episodes
                    duration
                    season
                    seasonYear
                    averageScore
                    genres
                    isAdult
                    bannerImage
                    coverImage { extraLarge large medium color }
                    nextAiringEpisode { episode airingAt timeUntilAiring }
                    streamingEpisodes { title thumbnail }
                    relations {
                        edges {
                            relationType
                            node { id type format status title { userPreferred english romaji } coverImage { medium large } }
                        }
                    }
                    recommendations(sort: [RATING_DESC], perPage: 16) {
                        nodes {
                            rating
                            mediaRecommendation {
                                id type format status isAdult genres averageScore
                                title { userPreferred english romaji }
                                coverImage { medium large }
                                ${token ? 'mediaListEntry { status }' : ''}
                            }
                        }
                    }
                    ${token ? 'mediaListEntry { id status progress score(format: POINT_100) }' : ''}
                }
            }
        `;
        const data = await callAnilistGraphQL(query, { id });
        const media = data?.Media || null;
        if (media) animeMediaCache.set(id, { media, fetchedAt: Date.now() });
        return media;
    }

    function animeDisplayTitle(media) {
        return media?.title?.english || media?.title?.userPreferred || media?.title?.romaji || 'Anime';
    }

    function animeSearchTitles(media) {
        const seen = new Set();
        return [media?.title?.english, media?.title?.romaji, media?.title?.userPreferred]
            .filter(Boolean)
            // Nyaa ne connaît pas l'apostrophe typographique (« Journey’s ») ni les deux-points
            .map(t => t.replace(/[’‘`´]/g, "'").replace(/[:]/g, ' ').replace(/\s+/g, ' ').trim())
            .filter(t => {
                const k = t.toLowerCase();
                if (!k || seen.has(k)) return false;
                seen.add(k);
                return true;
            });
    }

    // Saison déduite du titre AniList (« Season 2 », « 2nd Season ») ; 1 par défaut
    function animeMediaSeasonNumber(media) {
        const titles = [media?.title?.english, media?.title?.romaji, media?.title?.userPreferred].filter(Boolean);
        for (const t of titles) {
            const m = t.match(/\bseason\s*(\d{1,2})\b/i) || t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i) || t.match(/\bS(\d{1,2})\b/);
            if (m) return parseInt(m[1], 10);
        }
        return 1;
    }

    // --- ANALYSE DES TORRENTS ---

    // Numéro d'épisode explicite dans le titre (null si absent : pas de « Épisode 1 » par défaut)
    function torrentStrictEpisode(t) {
        const title = t?.titre || '';
        if (!title || (typeof isTorrentPack === 'function' && isTorrentPack(t))) return null;
        const m = title.match(/S\d{1,2}\s*E0*(\d{1,4})\b/i) ||
                  title.match(/\b(?:E|EP|Episode|Épisode)\s*0*(\d{1,4})\b/i) ||
                  title.match(/\s-\s0*(\d{1,4})(?:v\d+)?(?:\s|$|\[|\()/);
        return m ? parseInt(m[1], 10) : null;
    }

    function torrentExplicitSeason(t) {
        const title = t?.titre || '';
        const m = title.match(/\bS0*(\d{1,2})E\d+/i) ||
                  title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i) ||
                  title.match(/\b(?:Season|Saison)\s*0*(\d{1,2})\b/i) ||
                  title.match(/\bS0*(\d{1,2})(?=[^\w]|$)/i);
        return m ? parseInt(m[1], 10) : null;
    }

    // Saisons couvertes : « S01 + S02 », « S01-02 », « S1 - S3 » -> [début, fin] ; une seule saison -> [n, n]
    // (« S2 - 05 » est un épisode, pas une plage : sans « S » des deux côtés, le tiret doit être collé)
    function torrentSeasonSpan(t) {
        const title = t?.titre || '';
        const m = title.match(/\bS0*(\d{1,2})\s*[+&]\s*S?0*(\d{1,2})\b/i) ||
                  title.match(/\bS0*(\d{1,2})-S?0*(\d{1,2})\b/i) ||
                  title.match(/\bS0*(\d{1,2})\s*[-~]\s*S0*(\d{1,2})\b/i) ||
                  title.match(/\bSaisons?\s*0*(\d{1,2})\s*(?:[-&~+]|à)\s*0*(\d{1,2})\b/i);
        if (m) {
            const a = parseInt(m[1], 10);
            const b = parseInt(m[2], 10);
            if (b >= a && b - a < 30) return [a, b];
        }
        const s = torrentExplicitSeason(t);
        return s === null ? null : [s, s];
    }

    // 3 = saison exacte, 2 = pack multi-saisons qui la contient, 1 = inconnue, 0 = autre saison (exclu)
    function torrentSeasonScore(t, mediaSeason) {
        const span = torrentSeasonSpan(t);
        if (!span) return 1;
        if (mediaSeason < span[0] || mediaSeason > span[1]) return 0;
        return span[0] === span[1] ? 3 : 2;
    }

    // Pack de saison complet : saison explicite, aucun numéro ni plage d'épisodes
    function isSeasonPack(t) {
        return torrentStrictEpisode(t) === null && !torrentEpisodeRange(t) && torrentSeasonSpan(t) !== null;
    }

    // Saison d'un fichier à l'intérieur d'un pack (« …S01E05… », « Season 1/… »)
    function fileSeasonNumber(name) {
        const m = String(name || '').match(/\bS0*(\d{1,2})E\d+/i) || String(name || '').match(/\b(?:Season|Saison)\s*0*(\d{1,2})\b/i);
        return m ? parseInt(m[1], 10) : null;
    }

    function torrentEpisodeRange(t) {
        const m = (t.episode || '').match(/Épisodes?\s*0*(\d+)\s*[-~]\s*0*(\d+)/i) ||
                  (t.titre || '').match(/\b(?:E|EP|Épisode|Episode)\s*0*(\d+)\s*[-~]\s*0*(\d+)\b/i);
        return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
    }

    function isAlive(t) {
        return (Number(t?.seeders) || 0) > 0;
    }

    function sortTorrentCandidates(list, mediaSeason) {
        const prefs = getReleasePrefs();
        return list.sort((a, b) => {
            const sa = torrentSeasonScore(a, mediaSeason);
            const sb = torrentSeasonScore(b, mediaSeason);
            if (sa !== sb) return sb - sa;
            return compareByReleasePrefs(a, b, prefs);
        });
    }

    /** Meilleur torrent pour l'épisode : { kind: 'single'|'pack', torrent } ou null. */
    function pickTorrentForEpisode(torrents, ep, media) {
        const mediaSeason = animeMediaSeasonNumber(media);
        const usable = (torrents || []).filter(t => isAlive(t) && torrentSeasonScore(t, mediaSeason) > 0);

        const singles = usable.filter(t => torrentStrictEpisode(t) === ep);
        if (singles.length) return { kind: 'single', torrent: sortTorrentCandidates(singles, mediaSeason)[0] };

        const packs = usable.filter(t => {
            const r = torrentEpisodeRange(t);
            return r && ep >= r[0] && ep <= r[1];
        });
        if (packs.length) return { kind: 'pack', torrent: sortTorrentCandidates(packs, mediaSeason)[0] };

        // Dernier recours : pack de la saison entière (les packs mono-saison passent devant)
        const seasonPacks = usable.filter(isSeasonPack);
        if (seasonPacks.length) return { kind: 'pack', torrent: sortTorrentCandidates(seasonPacks, mediaSeason)[0] };
        return null;
    }

    function computeAvailability(torrents, media, airedCount) {
        const map = new Map();
        const mediaSeason = animeMediaSeasonNumber(media);
        const alive = (torrents || []).filter(t => isAlive(t) && torrentSeasonScore(t, mediaSeason) > 0);
        if (alive.some(isSeasonPack)) {
            // Toute la saison est disponible dans un pack ; les épisodes seuls l'emportent ci-dessous
            const count = airedCount || media.episodes || 0;
            for (let e = 1; e <= Math.min(count, 2000); e++) map.set(e, 'pack');
        }
        alive.forEach(t => {
            const ep = torrentStrictEpisode(t);
            if (ep) {
                map.set(ep, 'single');
                return;
            }
            const r = torrentEpisodeRange(t);
            if (r && r[1] - r[0] < 400) {
                for (let e = r[0]; e <= r[1]; e++) if (map.get(e) !== 'single') map.set(e, 'pack');
            }
        });
        return map;
    }

    async function fetchNyaa(query) {
        const type = document.getElementById('searchType')?.value || 'vostfr';
        const res = await fetch('/api/search?q=' + encodeURIComponent(query) + '&type=' + encodeURIComponent(type));
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    }

    function currentTorrentsKey() {
        return `${animePageState.id}|${document.getElementById('searchType')?.value || 'vostfr'}`;
    }

    // Fusion sans doublon (même magnet) de plusieurs pages de résultats Nyaa
    function mergeTorrentLists(lists) {
        const seen = new Set();
        const merged = [];
        lists.flat().forEach(t => {
            const k = t && (t.lienMagnet || t.titre);
            if (!k || seen.has(k)) return;
            seen.add(k);
            merged.push(t);
        });
        return merged;
    }

    // Recherche Nyaa sur tous les titres AniList en parallèle (anglais, romaji…) puis fusion :
    // les groupes FR nomment souvent leurs releases en romaji, les groupes anglais en anglais
    function ensureAnimeTorrents() {
        const key = currentTorrentsKey();
        if (animePageState.torrentsKey === key && animePageState.torrents) return Promise.resolve(animePageState.torrents);
        if (animePageState.torrentsKey === key && animePageState.torrentsPromise) return animePageState.torrentsPromise;

        const media = animePageState.media;
        animePageState.torrentsKey = key;
        animePageState.torrents = null;
        animePageState.availability = new Map();
        renderAnimeSourceStatus('loading');

        const promise = (async () => {
            const titles = animeSearchTitles(media);
            const results = await Promise.all(titles.map(title => fetchNyaa(title).catch(() => [])));
            const found = mergeTorrentLists(results);
            // Titre le plus productif : sert pour « Choisir la source » et les recherches ciblées
            let usedQuery = null;
            let best = 0;
            results.forEach((list, i) => {
                if (list.length > best) {
                    best = list.length;
                    usedQuery = titles[i];
                }
            });
            // La fiche a pu changer pendant la requête
            if (animePageState.torrentsKey !== key) return found;
            animePageState.torrents = found;
            animePageState.torrentsQuery = usedQuery || animeSearchTitles(media)[0] || animeDisplayTitle(media);
            const nextAiring = media.nextAiringEpisode;
            const airedCount = nextAiring?.episode ? nextAiring.episode - 1 : media.episodes;
            animePageState.availability = computeAvailability(found, media, airedCount);
            animePageState.torrentsPromise = null;
            renderAnimeSourceStatus();
            refreshAnimeEpisodeTiles();
            return found;
        })();
        animePageState.torrentsPromise = promise;
        return promise;
    }

    // --- PROGRESSION (ANILIST + HISTORIQUE LOCAL) ---

    function normalizeTitleKey(s) {
        return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
    }

    function historyBelongsToMedia(item, media) {
        if (!item?.animeName) return false;
        try {
            const mapped = localStorage.getItem('anilist_map_' + item.animeName.toLowerCase());
            if (mapped && parseInt(mapped, 10) === media.id) return true;
            if (mapped && parseInt(mapped, 10) !== media.id) return false;
        } catch (e) {}
        const name = normalizeTitleKey(item.animeName);
        if (name.length < 4) return false;
        const titles = [media.title?.romaji, media.title?.english, media.title?.userPreferred, ...(media.synonyms || [])]
            .map(normalizeTitleKey).filter(t => t.length >= 4);
        return titles.some(t => t === name || t.startsWith(name) || name.startsWith(t));
    }

    function historyEpisodeNumber(item) {
        const m = String(item?.episode || '').match(/(\d{1,4})\s*$/) || String(item?.episode || '').match(/(\d{1,4})/);
        return m ? parseInt(m[1], 10) : null;
    }

    /** ep -> entrée d'historique la plus récente pour ce média */
    function localEpisodeHistory(media) {
        const map = new Map();
        const list = (typeof getPlaybackHistory === 'function') ? getPlaybackHistory() : [];
        list.forEach(item => {
            if (!historyBelongsToMedia(item, media)) return;
            const ep = historyEpisodeNumber(item);
            if (!ep) return;
            const prev = map.get(ep);
            if (!prev || (item.updatedAt || 0) > (prev.updatedAt || 0)) map.set(ep, item);
        });
        return map;
    }

    function anilistProgress(media) {
        let progress = media?.mediaListEntry?.progress || 0;
        const entry = (typeof anilistWatchingList !== 'undefined' && Array.isArray(anilistWatchingList))
            ? anilistWatchingList.find(e => e.media && e.media.id === media.id) : null;
        if (entry && entry.progress > progress) progress = entry.progress;
        return progress;
    }

    function computeEpisodeModel(media) {
        const next = media.nextAiringEpisode;
        const isMovie = media.format === 'MOVIE';
        let aired;
        if (media.status === 'NOT_YET_RELEASED') aired = 0;
        else if (next && next.episode) aired = next.episode - 1;
        else aired = media.episodes || null;

        if (!aired && media.status !== 'NOT_YET_RELEASED') {
            // Nombre inconnu : on déduit des torrents trouvés (au moins 1)
            let maxEp = isMovie ? 1 : 0;
            (animePageState.torrents || []).forEach(t => {
                const ep = torrentStrictEpisode(t);
                if (ep && ep < 2000 && ep > maxEp) maxEp = ep;
            });
            aired = Math.max(maxEp, 1);
        }

        const progress = anilistProgress(media);
        const history = localEpisodeHistory(media);
        const titles = new Map();
        (media.streamingEpisodes || []).forEach(se => {
            const m = (se.title || '').match(/^Episode\s+(\d+)\s*[-:–]\s*(.*)$/i);
            if (m) titles.set(parseInt(m[1], 10), { title: m[2].trim(), thumbnail: se.thumbnail });
        });

        // Épisode proposé : reprise locale en cours > suite de la progression > épisode 1
        let target = null;
        let resumeItem = null;
        const partials = Array.from(history.entries())
            .filter(([ep, item]) => !item.completed && item.currentTime >= 15 && ep <= aired)
            .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
        if (partials.length && partials[0][0] > progress) {
            target = partials[0][0];
            resumeItem = partials[0][1];
        } else if (aired > 0) {
            let localDone = 0;
            history.forEach((item, ep) => { if (item.completed && ep > localDone) localDone = ep; });
            const done = Math.max(progress, localDone);
            target = done < aired ? done + 1 : null;
        }

        return { aired, total: media.episodes || null, next, progress, history, titles, target, resumeItem, isMovie };
    }

    // --- RENDU ---

    function stripDescription(desc) {
        return String(desc || '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    const FORMAT_LABELS = { TV: 'Série TV', TV_SHORT: 'Format court', MOVIE: 'Film', SPECIAL: 'Spécial', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Clip' };
    const STATUS_LABELS = { FINISHED: 'Terminé', RELEASING: 'En cours de diffusion', NOT_YET_RELEASED: 'À venir', CANCELLED: 'Annulé', HIATUS: 'En pause' };
    const SEASON_LABELS = { WINTER: 'Hiver', SPRING: 'Printemps', SUMMER: 'Été', FALL: 'Automne' };
    const RELATION_LABELS = { PREQUEL: 'Préquelle', SEQUEL: 'Suite', PARENT: 'Série principale', SIDE_STORY: 'Histoire parallèle' };
    const LIST_STATUS_LABELS = { COMPLETED: '✓ Vu', CURRENT: '▶ En cours', REPEATING: '▶ En cours', PAUSED: '⏸ En pause', PLANNING: '🔖 Prévu', DROPPED: 'Abandonné' };
    const RECOMMENDATIONS_SHOWN = 10;

    function renderAnimePageSkeleton(container) {
        container.innerHTML = `
            <div class="anime-page" role="status" aria-label="Chargement de la fiche">
                <div class="anime-hero">
                    <div class="anime-hero-inner">
                        <div class="skeleton-block anime-cover anime-cover-skeleton"></div>
                        <div class="anime-hero-info">
                            <div class="skeleton-block skeleton-line" style="height: 34px; width: 60%;"></div>
                            <div class="skeleton-block skeleton-line" style="width: 40%;"></div>
                            <div class="skeleton-block skeleton-line" style="width: 90%; height: 60px;"></div>
                            <div class="skeleton-block skeleton-line" style="width: 220px; height: 46px;"></div>
                        </div>
                    </div>
                </div>
                <div class="anime-ep-grid">
                    ${Array.from({ length: 8 }, () => '<div class="skeleton-block anime-ep-skeleton"></div>').join('')}
                </div>
            </div>`;
    }

    function ctaInfo(model) {
        if (model.target) {
            if (model.resumeItem) {
                return { ep: model.target, label: `▶ Reprendre l'épisode ${model.target}`, sub: `à ${formatTimestamp(model.resumeItem.currentTime)}` };
            }
            if (model.isMovie) return { ep: 1, label: '▶ Regarder le film', sub: '' };
            if (model.target === 1) return { ep: 1, label: "▶ Commencer l'épisode 1", sub: '' };
            return { ep: model.target, label: `▶ Regarder l'épisode ${model.target}`, sub: '' };
        }
        if (model.next && model.next.airingAt) {
            return { ep: null, label: `⏳ Épisode ${model.next.episode}`, sub: '', airingAt: model.next.airingAt };
        }
        if (model.aired > 0) return { ep: 1, label: model.isMovie ? '▶ Revoir le film' : "↺ Revoir depuis l'épisode 1", sub: '' };
        return { ep: null, label: 'Pas encore diffusé', sub: '' };
    }

    function renderEpisodeTile(ep, model) {
        const info = model.titles.get(ep);
        const hist = model.history.get(ep);
        const watched = ep <= model.progress || (hist && hist.completed);
        const partial = !watched && hist && hist.currentTime >= 15;
        const pct = watched ? 100 : (partial ? Math.max(3, Math.min(97, hist.progressPct || 0)) : 0);
        const avail = animePageState.availability.get(ep);
        const searched = !!animePageState.torrents;
        const isTarget = ep === (animePageState.highlightEp || model.target);
        const isPlaying = animePageState.playingEp === ep;
        const kept = typeof getKeptEpisodeDownload === 'function' ? getKeptEpisodeDownload(animePageState.media?.id, ep) : null;

        const classes = ['anime-ep-tile'];
        if (watched) classes.push('is-watched');
        if (partial) classes.push('is-partial');
        if (isTarget) classes.push('is-target');
        if (isPlaying) classes.push('is-loading');
        if (kept) classes.push('is-kept');
        else if (searched && !avail) classes.push('no-source');

        const sourceLabel = kept ? 'Gardé sur le serveur'
            : !searched ? '' : (avail === 'single' ? 'Source trouvée' : (avail === 'pack' ? 'Dans un pack' : 'Recherche à la demande'));
        const stateLabel = watched ? 'vu' : (partial ? `en cours, ${pct} %` : 'non vu');
        const thumbStyle = info?.thumbnail ? ` style="background-image:url('${escapeHtml(info.thumbnail)}')"` : '';

        return `
            <button type="button" class="${classes.join(' ')}" data-ep="${ep}" onclick="playAnimeEpisode(${ep})"
                aria-label="Épisode ${ep}${info?.title ? ' : ' + escapeHtml(info.title) : ''} (${stateLabel}${sourceLabel ? ', ' + sourceLabel.toLowerCase() : ''})">
                <div class="anime-ep-thumb"${thumbStyle}>
                    <span class="anime-ep-num">${model.isMovie ? '🎬' : ep}</span>
                    ${watched ? '<span class="anime-ep-state" title="Vu">✓</span>' : ''}
                    ${kept ? '<span class="anime-ep-kept" title="Gardé sur le serveur : regardable sans seeders">💾</span>' : ''}
                    ${isPlaying ? '<span class="anime-ep-spinner"></span>' : '<span class="anime-ep-play" aria-hidden="true">▶</span>'}
                </div>
                <div class="anime-ep-body">
                    <span class="anime-ep-label">${model.isMovie ? 'Film' : 'Épisode ' + ep}${partial ? ` · <span class="anime-ep-resume">${formatTimestamp(hist.currentTime)}</span>` : ''}</span>
                    ${info?.title ? `<span class="anime-ep-title">${escapeHtml(info.title)}</span>` : ''}
                </div>
                ${sourceLabel ? `<span class="anime-ep-source anime-ep-source-${kept ? 'kept' : (avail || 'none')}" title="${sourceLabel}"></span>` : ''}
                ${pct > 0 ? `<div class="anime-ep-progress"><span style="width:${pct}%"></span></div>` : ''}
            </button>`;
    }

    function renderUpcomingTile(next) {
        return `
            <div class="anime-ep-tile is-upcoming" aria-label="Épisode ${next.episode} : diffusion à venir">
                <div class="anime-ep-thumb">
                    <span class="anime-ep-num">${next.episode}</span>
                </div>
                <div class="anime-ep-body">
                    <span class="anime-ep-label">Épisode ${next.episode}</span>
                    <span class="anime-ep-title">⏳ <span class="airing-countdown-text" data-airing-at="${Number(next.airingAt)}">${formatAiringCountdown(next.airingAt * 1000 - Date.now())}</span></span>
                </div>
            </div>`;
    }

    function renderEpisodesSection(model) {
        if (model.aired <= 0) {
            return `<div class="empty-state">Aucun épisode diffusé pour le moment.${model.next ? ` Premier épisode dans <span class="airing-countdown-text" data-airing-at="${Number(model.next.airingAt)}">${formatAiringCountdown(model.next.airingAt * 1000 - Date.now())}</span>.` : ''}</div>`;
        }
        const start = animePageState.rangeStart;
        const end = Math.min(model.aired, start + ANIME_EP_RANGE_SIZE - 1);
        let tiles = '';
        for (let ep = start; ep <= end; ep++) tiles += renderEpisodeTile(ep, model);
        if (end === model.aired && model.next && model.next.episode === model.aired + 1) tiles += renderUpcomingTile(model.next);

        let ranges = '';
        if (model.aired > ANIME_EP_RANGE_SIZE) {
            const chips = [];
            for (let s = 1; s <= model.aired; s += ANIME_EP_RANGE_SIZE) {
                const e = Math.min(model.aired, s + ANIME_EP_RANGE_SIZE - 1);
                chips.push(`<button type="button" class="filter-chip ${s === start ? 'active' : ''}" onclick="setAnimeEpisodeRange(${s})">${s}–${e}</button>`);
            }
            ranges = `<div class="anime-ep-ranges">${chips.join('')}</div>`;
        }
        return `${ranges}<div class="anime-ep-grid" id="animeEpGrid">${tiles}</div>`;
    }

    function renderRelations(media) {
        const edges = (media.relations?.edges || []).filter(e => e.node?.type === 'ANIME' && RELATION_LABELS[e.relationType]);
        if (!edges.length) return '';
        const order = ['PREQUEL', 'PARENT', 'SEQUEL', 'SIDE_STORY'];
        edges.sort((a, b) => order.indexOf(a.relationType) - order.indexOf(b.relationType));
        return `
            <section class="anime-section">
                <h2 class="anime-section-title">Dans la même série</h2>
                <div class="anime-relations">
                    ${edges.slice(0, 8).map(e => {
                        const n = e.node;
                        const t = n.title?.english || n.title?.userPreferred || n.title?.romaji || 'Anime';
                        const cover = n.coverImage?.large || n.coverImage?.medium || posterFallback(t);
                        return `
                            <button type="button" class="anime-relation-card" onclick="openAnimePage(${Number(n.id)})">
                                <img src="${escapeHtml(cover)}" alt="" loading="lazy" ${posterOnErrorAttr(t)}>
                                <span class="anime-relation-type">${RELATION_LABELS[e.relationType]}${n.format ? ' · ' + (FORMAT_LABELS[n.format] || n.format) : ''}</span>
                                <span class="anime-relation-title">${escapeHtml(t)}</span>
                            </button>`;
                    }).join('')}
                </div>
            </section>`;
    }

    /**
     * Recommandations AniList (« Si vous avez aimé… ») : les mieux notées par la communauté.
     * Exclues : l'anime lui-même, ses saisons (déjà dans « Dans la même série »), le 18+ sauf
     * préférence contraire, les animes pas encore sortis et les recommandations sans vote positif.
     */
    function pickRecommendations(media, showAdult) {
        const related = new Set([media.id, ...(media.relations?.edges || []).map(e => e.node?.id)]);
        const seen = new Set();
        return (media.recommendations?.nodes || [])
            .filter(n => {
                const m = n?.mediaRecommendation;
                if (!m || m.type !== 'ANIME' || !(n.rating > 0)) return false;
                if (related.has(m.id) || seen.has(m.id)) return false;
                if (m.status === 'NOT_YET_RELEASED') return false;
                const adult = m.isAdult === true || (Array.isArray(m.genres) && m.genres.includes('Hentai'));
                if (adult && !showAdult) return false;
                seen.add(m.id);
                return true;
            })
            .slice(0, RECOMMENDATIONS_SHOWN)
            .map(n => n.mediaRecommendation);
    }

    function renderRecommendations(media) {
        const showAdult = typeof getShowNsfwPreference === 'function' && getShowNsfwPreference();
        const recs = pickRecommendations(media, showAdult);
        if (!recs.length) return '';
        return `
            <section class="anime-section">
                <h2 class="anime-section-title">Si vous avez aimé ${escapeHtml(animeDisplayTitle(media))}…</h2>
                <div class="anime-relations">
                    ${recs.map(m => {
                        const t = m.title?.english || m.title?.userPreferred || m.title?.romaji || 'Anime';
                        const cover = m.coverImage?.large || m.coverImage?.medium || posterFallback(t);
                        const listStatus = LIST_STATUS_LABELS[m.mediaListEntry?.status];
                        const meta = [m.averageScore ? `⭐ ${(m.averageScore / 10).toFixed(1)}` : '', m.format ? (FORMAT_LABELS[m.format] || m.format) : '']
                            .filter(Boolean).join(' · ');
                        return `
                            <button type="button" class="anime-relation-card" onclick="openAnimePage(${Number(m.id)})">
                                <span class="anime-relation-cover">
                                    <img src="${escapeHtml(cover)}" alt="" loading="lazy" ${posterOnErrorAttr(t)}>
                                    ${listStatus ? `<span class="anime-rec-list-status">${escapeHtml(listStatus)}</span>` : ''}
                                </span>
                                ${meta ? `<span class="anime-relation-type anime-rec-meta">${escapeHtml(meta)}</span>` : ''}
                                <span class="anime-relation-title">${escapeHtml(t)}</span>
                            </button>`;
                    }).join('')}
                </div>
            </section>`;
    }

    function renderAnimeSourceStatus(forceState) {
        const el = document.getElementById('animeSourceStatus');
        if (!el) return;
        const typeLabel = document.getElementById('searchType')?.selectedOptions?.[0]?.textContent || 'VOSTFR';
        if (forceState === 'loading' || (!animePageState.torrents && animePageState.torrentsPromise)) {
            el.className = 'anime-source-status is-loading';
            el.innerHTML = `<span class="anime-source-dot"></span> Recherche des sources ${escapeHtml(typeLabel)} sur Nyaa…`;
            return;
        }
        if (!animePageState.torrents) {
            el.innerHTML = '';
            return;
        }
        const count = animePageState.availability.size;
        if (animePageState.torrents.length === 0) {
            el.className = 'anime-source-status is-empty';
            el.innerHTML = `<span class="anime-source-dot"></span> Aucun torrent ${escapeHtml(typeLabel)} trouvé. Essayez une autre langue.`;
        } else {
            el.className = 'anime-source-status is-ok';
            el.innerHTML = `<span class="anime-source-dot"></span> ${animePageState.torrents.length} torrents ${escapeHtml(typeLabel)} · ${count} épisode${count > 1 ? 's' : ''} identifié${count > 1 ? 's' : ''}`;
        }
    }

    function renderAnimePage() {
        const container = document.getElementById('animeView');
        const media = animePageState.media;
        if (!container || !media) return;

        const model = computeEpisodeModel(media);
        if (!animePageState.rangeStartLocked) {
            const focusEp = animePageState.highlightEp || model.target || 1;
            animePageState.rangeStart = Math.floor((Math.max(1, focusEp) - 1) / ANIME_EP_RANGE_SIZE) * ANIME_EP_RANGE_SIZE + 1;
        }

        const title = animeDisplayTitle(media);
        const altTitle = [media.title?.romaji, media.title?.native].filter(t => t && t !== title).join(' · ');
        const cover = media.coverImage?.extraLarge || media.coverImage?.large || posterFallback(title);
        const banner = media.bannerImage || media.coverImage?.extraLarge || '';
        const synopsis = stripDescription(media.description);
        const cta = ctaInfo(model);
        const isFav = isAnimePageFavorite(media);
        const seasonLabel = media.season && media.seasonYear ? `${SEASON_LABELS[media.season] || ''} ${media.seasonYear}` : (media.seasonYear || '');
        const epCountLabel = model.total ? `${model.total} ép.` : (media.status === 'RELEASING' ? `${model.aired} ép. diffusés` : '');
        const typeSel = document.getElementById('searchType');
        const typeOptions = typeSel ? Array.from(typeSel.options).map(o =>
            `<option value="${escapeHtml(o.value)}" ${o.value === typeSel.value ? 'selected' : ''}>${escapeHtml(o.textContent)}</option>`).join('') : '';
        const progressLabel = model.progress > 0 ? `<span class="anime-progress-pill">AniList : ${model.progress}${model.total ? ' / ' + model.total : ''}</span>` : '';

        // Couleur de l'affiche (AniList) pour toute la fiche : boutons, halo, tuiles (réglable dans Paramètres)
        const accentStyle = typeof animeAccentStyle === 'function' ? animeAccentStyle(media.coverImage?.color) : '';

        container.innerHTML = `
            <div class="anime-page" style="${escapeHtml(accentStyle)}">
                <div class="anime-hero" style="${banner ? `--anime-banner: url('${escapeHtml(banner)}');` : ''}">
                    <div class="anime-hero-top">
                        <button type="button" class="btn-back" onclick="AppRouter.back('/')">← Retour</button>
                    </div>
                    <div class="anime-hero-inner">
                        <img class="anime-cover" src="${escapeHtml(cover)}" alt="Affiche de ${escapeHtml(title)}" ${posterOnErrorAttr(title)}>
                        <div class="anime-hero-info">
                            <h1 class="anime-title">${escapeHtml(title)}</h1>
                            ${altTitle ? `<div class="anime-alt-title">${escapeHtml(altTitle)}</div>` : ''}
                            <div class="anime-meta-row">
                                ${media.format ? `<span class="detail-badge">${escapeHtml(FORMAT_LABELS[media.format] || media.format)}</span>` : ''}
                                ${seasonLabel ? `<span class="detail-badge">${escapeHtml(String(seasonLabel))}</span>` : ''}
                                ${epCountLabel ? `<span class="detail-badge">${escapeHtml(epCountLabel)}</span>` : ''}
                                ${media.averageScore ? `<span class="detail-badge badge-rating-detail">⭐ ${(media.averageScore / 10).toFixed(1)}</span>` : ''}
                                ${media.status ? `<span class="detail-badge anime-status-${String(media.status).toLowerCase()}">${escapeHtml(STATUS_LABELS[media.status] || media.status)}</span>` : ''}
                                ${progressLabel}
                            </div>
                            ${(media.genres || []).length ? `<div class="anime-genres">${media.genres.slice(0, 6).map(g => `<span>${escapeHtml(g)}</span>`).join('')}</div>` : ''}
                            ${synopsis ? `
                                <p class="anime-synopsis ${animePageState.synopsisOpen ? 'is-open' : ''}" id="animeSynopsis">${escapeHtml(synopsis).replace(/\n/g, '<br>')}</p>
                                ${synopsis.length > 260 ? `<button type="button" class="anime-synopsis-toggle" onclick="toggleAnimeSynopsis()" aria-controls="animeSynopsis" aria-expanded="${animePageState.synopsisOpen}">${animePageState.synopsisOpen ? 'Réduire' : 'Lire la suite'}</button>` : ''}
                            ` : ''}
                            <div class="anime-actions">
                                <button type="button" class="btn-anime-play" id="animePlayCta" ${cta.ep ? `onclick="playAnimeEpisode(${cta.ep})"` : 'disabled'}>
                                    <span>${escapeHtml(cta.label)}</span>
                                    ${cta.sub ? `<small>${escapeHtml(cta.sub)}</small>` : ''}
                                    ${cta.airingAt ? `<small>dans <span class="airing-countdown-text" data-airing-at="${Number(cta.airingAt)}">${formatAiringCountdown(cta.airingAt * 1000 - Date.now())}</span></small>` : ''}
                                </button>
                                <button type="button" class="btn-secondary" onclick="openAnimeSourcePicker(${cta.ep || model.target || 1})" title="Voir tous les torrents et choisir manuellement">
                                    📋 Choisir la source
                                </button>
                                <button type="button" class="btn-favorite-toggle ${isFav ? 'active' : ''}" onclick="toggleAnimePageFavorite()" aria-pressed="${isFav}">
                                    ${isFav ? '❤️ Dans mes favoris' : '🤍 Favori'}
                                </button>
                                ${typeof renderAutoDownloadToggle === 'function' ? renderAutoDownloadToggle(media) : ''}
                                <label class="anime-lang-select">
                                    <span class="visually-hidden">Langue des sources</span>
                                    <select onchange="onAnimePageLanguageChange(this.value)" title="Langue des sources Nyaa">${typeOptions}</select>
                                </label>
                            </div>
                            ${renderAnimeListPanel(media)}
                            <div id="animeSourceStatus" class="anime-source-status" role="status" aria-live="polite"></div>
                        </div>
                    </div>
                </div>

                <section class="anime-section">
                    <div class="anime-section-header">
                        <h2 class="anime-section-title">${model.isMovie ? 'Film' : 'Épisodes'}</h2>
                        <span class="anime-section-hint">
                            Un clic lance la meilleure source selon vos préférences de release ·
                            <span class="anime-legend"><i class="anime-ep-source-single"></i> épisode seul</span>
                            <span class="anime-legend"><i class="anime-ep-source-pack"></i> dans un pack</span>
                        </span>
                    </div>
                    ${renderEpisodesSection(model)}
                </section>

                ${renderRelations(media)}

                ${renderRecommendations(media)}
            </div>`;

        renderAnimeSourceStatus();
        if (typeof startAiringCountdownTicker === 'function') startAiringCountdownTicker();
    }

    // Met à jour uniquement les tuiles (après la recherche Nyaa) pour ne pas perdre le focus clavier
    function refreshAnimeEpisodeTiles() {
        const grid = document.getElementById('animeEpGrid');
        const media = animePageState.media;
        if (!grid || !media) {
            if (media) renderAnimePage();
            return;
        }
        const model = computeEpisodeModel(media);
        const activeEp = document.activeElement?.closest?.('.anime-ep-tile')?.dataset?.ep;
        const section = grid.parentElement;
        const tmp = document.createElement('div');
        tmp.innerHTML = renderEpisodesSection(model);
        section.querySelectorAll('.anime-ep-ranges, .anime-ep-grid, .empty-state').forEach(n => n.remove());
        Array.from(tmp.childNodes).forEach(n => section.appendChild(n));
        if (activeEp) section.querySelector(`.anime-ep-tile[data-ep="${activeEp}"]`)?.focus({ preventScroll: true });
    }

    // --- TRANSITION ANIMÉE CARTE <-> FICHE (View Transitions API) ---
    // L'affiche de la carte cliquée « vole » jusqu'à la couverture de la fiche, et revient à sa place au
    // retour. Navigateurs sans l'API, mouvements réduits (préférence système) ou mode TV : affichage direct.

    const COVER_TRANSITION_NAME = 'anime-cover';
    const COVER_CLICK_MAX_AGE_MS = 1500;
    let coverSource = null; // { el: <img> de la carte cliquée, at, id }

    // Mémorise l'affiche de l'élément cliqué (carte, tuile de relation, résultat…) avant son onclick
    if (typeof document.addEventListener === 'function') {
        document.addEventListener('click', (e) => {
            const host = e.target?.closest?.('[onclick]');
            const img = host?.querySelector('img');
            if (img) coverSource = { el: img, at: Date.now(), id: null };
        }, true);
    }

    function canAnimateViews() {
        return typeof document.startViewTransition === 'function'
            && !document.hidden
            && !document.body.classList.contains('tv-mode')
            && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    }

    function isInViewport(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
    }

    function setCoverName(el, on) {
        if (el) el.style.viewTransitionName = on ? COVER_TRANSITION_NAME : '';
    }

    // Lance `update` dans une transition où `fromEl` devient l'élément trouvé par `findTarget` après la mise à jour
    function runCoverTransition(fromEl, update, findTarget) {
        let target = null;
        setCoverName(fromEl, true);
        const transition = document.startViewTransition(() => {
            setCoverName(fromEl, false);
            update();
            target = findTarget();
            if (isInViewport(target)) setCoverName(target, true);
            else target = null; // pas de vol vers un élément hors écran : simple fondu
        });
        transition.finished.catch(() => {}).finally(() => {
            setCoverName(fromEl, false);
            setCoverName(target, false);
        });
        return transition;
    }

    // Affiche d'une carte de cet anime dans l'accueil ou la recherche (la grille a pu être redessinée)
    function findCardCover(id) {
        // openAnimePage(ID…) ou ID en dernier argument (searchFromDiscover(titre, affiche, ID))
        const n = Number(id);
        const re = new RegExp(`openAnimePage\\(${n}\\s*[,)]|,\\s*${n}\\s*\\)\\s*;?\\s*$`);
        for (const host of document.querySelectorAll('#homeView [onclick], #searchView [onclick]')) {
            if (re.test(host.getAttribute('onclick') || '')) {
                const img = host.querySelector('img');
                if (isInViewport(img)) return img;
            }
        }
        return null;
    }

    /** Retour de la fiche vers la grille d'où on venait : l'affiche revient se poser sur sa carte. */
    function animeCoverBackTransition(update) {
        const id = animePageState.id;
        const cover = document.querySelector('#animeView .anime-cover:not(.anime-cover-skeleton)');
        if (!id || !canAnimateViews() || !isInViewport(cover)) return false;
        const card = coverSource && coverSource.id === id ? coverSource.el : null;
        runCoverTransition(cover, update, () => (card && card.isConnected && isInViewport(card) ? card : findCardCover(id)));
        return true;
    }

    // --- ACTIONS ---

    async function openAnimePage(id, opts = {}) {
        id = Number(id);
        if (!id) return;
        const { ep = null, syncUrl = true } = opts;

        const samePage = animePageState.id === id && animePageState.media;
        const container = document.getElementById('animeView');

        // Affichage immédiat de la fiche (en cache) ou de son squelette
        const showPage = () => {
            if (typeof AppRouter !== 'undefined' && AppRouter.isDetailOpen() && typeof closeDetailView === 'function') {
                closeDetailView({ navigate: false });
            }
            if (typeof showCatalogSubView === 'function') showCatalogSubView('anime');
            if (syncUrl && typeof AppRouter !== 'undefined') AppRouter.sync(AppRouter.animePath(id, ep));

            if (!samePage) {
                animePageState.id = id;
                animePageState.media = null;
                animePageState.torrents = null;
                animePageState.torrentsKey = null;
                animePageState.torrentsPromise = null;
                animePageState.availability = new Map();
                animePageState.synopsisOpen = false;
                window.scrollTo({ top: 0, behavior: 'auto' });
            }
            animePageState.highlightEp = ep;
            animePageState.rangeStartLocked = false;
            animePageState.playingEp = null;
            window._currentAnimePageId = id;

            if (!container) return;
            if (samePage) {
                renderAnimePage(); // retour du lecteur : progression locale à jour
            } else {
                const cached = animeMediaCache.get(id);
                if (cached) {
                    animePageState.media = cached.media;
                    renderAnimePage();
                } else {
                    renderAnimePageSkeleton(container);
                }
            }
        };

        // Carte cliquée à l'instant, visible et page différente : l'affiche vole jusqu'à la couverture
        const source = coverSource && Date.now() - coverSource.at < COVER_CLICK_MAX_AGE_MS ? coverSource.el : null;
        let transition = null;
        if (!samePage && container && canAnimateViews() && isInViewport(source)) {
            coverSource.id = id; // pour le vol retour
            transition = runCoverTransition(source, showPage, () => container.querySelector('.anime-cover'));
        } else {
            if (coverSource && !samePage) coverSource = null;
            showPage();
        }
        if (!container) return;

        try {
            const freshPromise = fetchAnimeMedia(id, samePage);
            // La fiche n'est redessinée qu'une fois l'animation finie (sinon la couverture animée disparaît)
            if (transition) await transition.finished.catch(() => {});
            const fresh = await freshPromise;
            if (window._currentAnimePageId !== id) return;
            if (!fresh) throw new Error('Anime introuvable sur AniList');
            animePageState.media = fresh;
            renderAnimePage();
            ensureAnimeTorrents().catch(() => {});
            if (typeof loadAutoDownloadState === 'function') loadAutoDownloadState(fresh);
        } catch (err) {
            if (window._currentAnimePageId !== id || animePageState.media) return;
            container.innerHTML = `
                <div class="empty-state">
                    ⚠️ Impossible de charger la fiche : ${escapeHtml(err.message)}
                    <div style="margin-top: 15px; display: flex; gap: 10px; justify-content: center;">
                        <button class="btn-secondary" onclick="openAnimePage(${id}, { syncUrl: false })">Réessayer</button>
                        <button class="btn-secondary" onclick="AppRouter.back('/')">← Retour</button>
                    </div>
                </div>`;
        }
    }

    function buildAnimeTargetInfo(media, ep) {
        const searchTitle = animePageState.torrentsQuery || animeSearchTitles(media)[0] || animeDisplayTitle(media);
        return {
            mediaId: media.id,
            anilistMediaId: media.id,
            animeName: animeDisplayTitle(media),
            searchTitle,
            romaji: media.title?.romaji,
            english: media.title?.english,
            userPreferred: media.title?.userPreferred,
            nextEp: ep,
            progress: anilistProgress(media),
            totalEpisodes: media.episodes || null,
            coverImage: media.coverImage?.large || media.coverImage?.medium,
            media,
            isNextEpUnreleased: false,
            airingTimestamp: null,
            airingCountdownStr: ''
        };
    }

    // Associe le nom extrait du torrent au média AniList (suivi, AniSkip, historique)
    function rememberAnilistMapping(media, torrent) {
        try {
            const names = [media.title?.english, media.title?.romaji, media.title?.userPreferred];
            if (torrent) {
                const parsed = getAnimeDetails(torrent);
                names.push(torrent.animeName || parsed.animeName);
            }
            names.filter(Boolean).forEach(n => localStorage.setItem('anilist_map_' + n.toLowerCase(), media.id));
        } catch (e) {}
    }

    function setPlayingEp(ep) {
        animePageState.playingEp = ep;
        document.querySelectorAll('.anime-ep-tile.is-loading').forEach(el => el.classList.remove('is-loading'));
        const cta = document.getElementById('animePlayCta');
        if (cta) cta.classList.toggle('is-loading', ep !== null);
        if (ep !== null) document.querySelector(`.anime-ep-tile[data-ep="${ep}"]`)?.classList.add('is-loading');
    }

    async function playAnimeEpisode(ep) {
        const media = animePageState.media;
        if (!media || !ep || animePageState.playingEp !== null) return;
        const pageId = media.id;
        setPlayingEp(ep);

        try {
            const target = buildAnimeTargetInfo(media, ep);
            currentTargetNextEpisode = target;
            rememberAnilistMapping(media);

            // 1. Reprise exacte d'un épisode commencé : même torrent, même position
            const model = computeEpisodeModel(media);
            const hist = model.history.get(ep);
            if (hist && !hist.completed && hist.currentTime >= 15 && hist.magnet && typeof resumeAnimeFromHistory === 'function') {
                resumeAnimeFromHistory(hist.key);
                return;
            }

            // 2. Épisode gardé sur le serveur : lecture depuis le disque, sans dépendre des seeders
            const kept = typeof getKeptEpisodeDownload === 'function' ? getKeptEpisodeDownload(media.id, ep) : null;
            if (kept) {
                showToast(`💾 Épisode ${ep} lu depuis le serveur`);
                openAnimeDetail({
                    titre: kept.fileName || kept.title,
                    animeName: animeDisplayTitle(media),
                    episode: ep,
                    lienMagnet: kept.magnet,
                    poster: kept.poster || media.coverImage?.large || null,
                    seeders: 0
                }, kept.fileIndex || 1, 0);
                return;
            }

            // 3. Meilleur torrent parmi les résultats déjà chargés, sinon recherche ciblée sur l'épisode
            let torrents = await ensureAnimeTorrents();
            let pick = pickTorrentForEpisode(torrents, ep, media);
            if (!pick || pick.kind === 'pack') {
                // Recherche ciblée « Titre 05 » puis « Titre S01E05 », jusqu'à trouver l'épisode seul
                showToast(`🔍 Recherche de l'épisode ${ep}…`);
                const pad = (n) => String(n).padStart(2, '0');
                const season = animeMediaSeasonNumber(media);
                const titles = [animePageState.torrentsQuery, ...animeSearchTitles(media)]
                    .filter((t, i, arr) => t && arr.indexOf(t) === i)
                    .slice(0, 2);
                const queries = titles.flatMap(title => [`${title} ${pad(ep)}`, `${title} S${pad(season)}E${pad(ep)}`]);
                for (const q of queries) {
                    const extra = await fetchNyaa(q).catch(() => []);
                    absorbExtraTorrents(extra);
                    const extraPick = pickTorrentForEpisode(extra, ep, media);
                    if (extraPick && extraPick.kind === 'single') {
                        pick = extraPick;
                        break;
                    }
                    if (!pick && extraPick) pick = extraPick;
                }
            }
            if (window._currentAnimePageId !== pageId) return;

            if (!pick) {
                showToast(`😕 Aucune source automatique pour l'épisode ${ep} : choisissez-en une`);
                openAnimeSourcePicker(ep);
                return;
            }

            rememberAnilistMapping(media, pick.torrent);
            const torrent = { ...pick.torrent, poster: pick.torrent.poster || media.coverImage?.large || null };

            if (pick.kind === 'pack') {
                // Fichier de l'épisode dans le pack, pour démarrer directement dessus
                let fileIndex = 1;
                try {
                    const res = await fetch('/api/torrent/files?magnet=' + encodeURIComponent(torrent.lienMagnet));
                    const data = await res.json();
                    // Pack multi-saisons : l'épisode de la bonne saison (S01E05 et S02E05 portent le même numéro)
                    const season = animeMediaSeasonNumber(media);
                    const sameEp = (data.files || []).filter(f => f.episode === ep);
                    const file = sameEp.find(f => fileSeasonNumber(f.name) === season)
                        || sameEp.find(f => fileSeasonNumber(f.name) === null)
                        || sameEp[0];
                    if (file) fileIndex = file.id;
                } catch (e) {}
                if (window._currentAnimePageId !== pageId) return;
                showToast(`📦 Épisode ${ep} lu depuis un pack`);
                openAnimeDetail({ ...torrent, targetEpisode: ep }, fileIndex, 0);
            } else {
                openAnimeDetail(torrent, 1, 0);
            }
        } catch (err) {
            showToast('❌ ' + (err.message || 'Erreur de lecture'));
        } finally {
            setPlayingEp(null);
        }
    }

    // Les résultats d'une recherche ciblée enrichissent la fiche (pastilles de disponibilité à jour)
    function absorbExtraTorrents(extra) {
        if (!extra || !extra.length || !animePageState.torrents) return;
        const media = animePageState.media;
        animePageState.torrents = mergeTorrentLists([animePageState.torrents, extra]);
        const nextAiring = media.nextAiringEpisode;
        const airedCount = nextAiring?.episode ? nextAiring.episode - 1 : media.episodes;
        animePageState.availability = computeAvailability(animePageState.torrents, media, airedCount);
    }

    function openAnimeSourcePicker(ep) {
        const media = animePageState.media;
        if (!media) return;
        const target = buildAnimeTargetInfo(media, ep || 1);
        currentTargetNextEpisode = target;
        rememberAnilistMapping(media);
        const input = document.getElementById('searchInput');
        if (input) input.value = target.searchTitle;
        if (typeof executeSearchForAnime === 'function') executeSearchForAnime(target.searchTitle, target);
    }

    function setAnimeEpisodeRange(start) {
        animePageState.rangeStart = start;
        animePageState.rangeStartLocked = true;
        refreshAnimeEpisodeTiles();
    }

    function toggleAnimeSynopsis() {
        animePageState.synopsisOpen = !animePageState.synopsisOpen;
        const p = document.getElementById('animeSynopsis');
        const btn = document.querySelector('.anime-synopsis-toggle');
        if (p) p.classList.toggle('is-open', animePageState.synopsisOpen);
        if (btn) {
            btn.textContent = animePageState.synopsisOpen ? 'Réduire' : 'Lire la suite';
            btn.setAttribute('aria-expanded', String(animePageState.synopsisOpen));
        }
    }

    function onAnimePageLanguageChange(value) {
        const sel = document.getElementById('searchType');
        if (sel) sel.value = value;
        animePageState.torrents = null;
        animePageState.torrentsPromise = null;
        animePageState.torrentsKey = null;
        animePageState.availability = new Map();
        refreshAnimeEpisodeTiles();
        ensureAnimeTorrents().catch(() => {});
    }

    // Changement de langue depuis la barre du haut pendant qu'une fiche est affichée
    function refreshAnimePageSources() {
        if (!animePageState.media) return;
        onAnimePageLanguageChange(document.getElementById('searchType')?.value || 'vostfr');
        renderAnimePage();
    }

    // --- MA LISTE ANILIST (STATUT & NOTE) ---

    function renderAnimeListPanel(media) {
        if (!localStorage.getItem('anilist_token') || typeof renderAnilistRatingStars !== 'function') return '';
        const entry = media.mediaListEntry;
        const status = entry?.status || '';
        const options = [
            status ? '' : '<option value="" selected>➕ Ajouter à ma liste</option>',
            ...ANILIST_LIST_STATUSES.map(([value, label]) =>
                `<option value="${value}" ${value === status ? 'selected' : ''}>${escapeHtml(label)}</option>`),
            status ? '<option value="__remove">🗑️ Retirer de ma liste</option>' : ''
        ].join('');
        const askRating = status === 'COMPLETED' && !entry?.score;
        return `
            <div class="anime-list-panel ${askRating ? 'is-asking' : ''}" id="animeListPanel">
                <label class="anime-list-status">
                    <span>Ma liste</span>
                    <select onchange="setAnimeListStatus(this.value)" aria-label="Statut dans ma liste AniList">${options}</select>
                </label>
                <div class="anime-list-rating">
                    <span>${askRating ? 'Terminé : votre note ?' : 'Ma note'}</span>
                    ${renderAnilistRatingStars(entry?.score || 0, 'rateAnimePage')}
                </div>
            </div>`;
    }

    // Redessine seulement le panneau (garde le focus clavier / télécommande sur l'étoile choisie)
    function refreshAnimeListPanel() {
        const panel = document.getElementById('animeListPanel');
        const media = animePageState.media;
        if (!panel || !media) return renderAnimePage();
        const focusedIdx = [...panel.querySelectorAll('button, select')].indexOf(document.activeElement);
        const tmp = document.createElement('div');
        tmp.innerHTML = renderAnimeListPanel(media);
        const fresh = tmp.firstElementChild;
        if (!fresh) return panel.remove();
        panel.replaceWith(fresh);
        if (focusedIdx >= 0) fresh.querySelectorAll('button, select')[focusedIdx]?.focus({ preventScroll: true });
    }

    async function setAnimeListStatus(value) {
        const media = animePageState.media;
        if (!media || !value) return;
        const title = animeDisplayTitle(media);
        try {
            if (value === '__remove') {
                const ok = typeof openUiDialog === 'function'
                    ? await openUiDialog({
                        title: 'Retirer de ma liste ?',
                        message: `« ${title} » sera retiré de votre liste AniList, avec sa progression et sa note.`,
                        okLabel: 'Retirer', cancelLabel: 'Annuler', danger: true
                    })
                    : confirm(`Retirer « ${title} » de votre liste AniList ?`);
                if (!ok || !media.mediaListEntry?.id) return refreshAnimeListPanel();
                await deleteAnilistListEntry(media.id, media.mediaListEntry.id);
                showToast(`🗑️ « ${title} » retiré de votre liste`);
            } else {
                const fields = { status: value };
                // « Terminé » : progression au dernier épisode, comme sur le site AniList
                if (value === 'COMPLETED' && media.episodes) fields.progress = media.episodes;
                await saveAnilistListEntry(media.id, fields);
                const label = (ANILIST_LIST_STATUSES.find(([v]) => v === value) || [])[1] || value;
                showToast(`✅ Ma liste : ${label}`);
            }
            renderAnimePage(); // la progression (tuiles vues, bouton principal) peut avoir changé
        } catch (err) {
            showToast('⚠️ Échec de la mise à jour AniList : ' + err.message);
            refreshAnimeListPanel();
        }
    }

    async function rateAnimePage(scoreRaw) {
        const media = animePageState.media;
        if (!media) return;
        try {
            const fields = { scoreRaw };
            // Pas encore dans la liste : un anime noté a été vu (Terminé s'il est fini, sinon En cours)
            if (!media.mediaListEntry?.status) fields.status = media.status === 'FINISHED' ? 'COMPLETED' : 'CURRENT';
            await saveAnilistListEntry(media.id, fields);
            showToast(scoreRaw ? `⭐ Note enregistrée : ${anilistScoreLabel(scoreRaw)}` : '⭐ Note retirée');
            if (fields.status) renderAnimePage();
            else refreshAnimeListPanel();
        } catch (err) {
            showToast('⚠️ Note non enregistrée : ' + err.message);
            refreshAnimeListPanel();
        }
    }

    // --- FAVORIS ---

    function isAnimePageFavorite(media) {
        if (typeof getFavorites !== 'function') return false;
        const key = animeDisplayTitle(media).toLowerCase().trim();
        return getFavorites().some(f => f.anilistId === media.id || (f.animeName && f.animeName.toLowerCase().trim() === key));
    }

    function toggleAnimePageFavorite() {
        const media = animePageState.media;
        if (!media || typeof getFavorites !== 'function') return;
        const title = animeDisplayTitle(media);
        const key = title.toLowerCase().trim();
        let list = getFavorites();
        const idx = list.findIndex(f => f.anilistId === media.id || (f.animeName && f.animeName.toLowerCase().trim() === key));
        if (idx >= 0) {
            list.splice(idx, 1);
            showToast(`🤍 "${title}" retiré de vos favoris`);
        } else {
            list.unshift({
                id: key,
                anilistId: media.id,
                animeName: title,
                season: `Saison ${animeMediaSeasonNumber(media)}`,
                poster: media.coverImage?.large || '',
                rating: media.averageScore ? (media.averageScore / 10).toFixed(1) : null,
                rawTitle: title,
                lienMagnet: null,
                searchTitle: animeSearchTitles(media)[0] || title,
                addedAt: Date.now()
            });
            showToast(`❤️ "${title}" ajouté à vos favoris !`);
        }
        saveFavoritesList(list);
        renderAnimePage();
    }

    // --- PASSERELLE RECHERCHE TEXTE -> FICHES ANIME ---

    let animeMatchesRequestId = 0;
    async function renderSearchAnimeMatches(searchTitle) {
        const box = document.getElementById('searchAnimeMatches');
        if (!box) return;
        const requestId = ++animeMatchesRequestId;
        box.innerHTML = '';
        box.style.display = 'none';
        if (!searchTitle || searchTitle.length < 2) return;
        try {
            const showAdult = (typeof getShowNsfwPreference === 'function') && getShowNsfwPreference();
            const query = `
                query ($search: String) {
                    Page(page: 1, perPage: 6) {
                        media(type: ANIME, search: $search, sort: [SEARCH_MATCH, POPULARITY_DESC]${showAdult ? '' : ', isAdult: false'}) {
                            id format seasonYear episodes
                            title { english romaji userPreferred }
                            coverImage { medium large }
                        }
                    }
                }`;
            const data = await callAnilistGraphQL(query, { search: searchTitle });
            if (requestId !== animeMatchesRequestId) return;
            const list = data?.Page?.media || [];
            if (!list.length) return;
            box.innerHTML = `
                <div class="search-anime-matches-label">Fiches anime</div>
                <div class="search-anime-matches-row">
                    ${list.map(m => {
                        const t = m.title?.english || m.title?.userPreferred || m.title?.romaji || 'Anime';
                        const meta = [FORMAT_LABELS[m.format] || m.format, m.seasonYear, m.episodes ? m.episodes + ' ép.' : null].filter(Boolean).join(' · ');
                        return `
                            <button type="button" class="search-anime-match" onclick="openAnimePage(${Number(m.id)})">
                                <img src="${escapeHtml(m.coverImage?.medium || posterFallback(t))}" alt="" loading="lazy" ${posterOnErrorAttr(t)}>
                                <span>
                                    <span class="search-anime-match-title">${escapeHtml(t)}</span>
                                    <span class="search-anime-match-meta">${escapeHtml(meta)}</span>
                                </span>
                            </button>`;
                    }).join('')}
                </div>`;
            box.style.display = 'block';
        } catch (e) {
            // AniList indisponible : la recherche Nyaa reste utilisable
        }
    }

    window.openAnimePage = openAnimePage;
    window.playAnimeEpisode = playAnimeEpisode;
    window.openAnimeSourcePicker = openAnimeSourcePicker;
    window.setAnimeEpisodeRange = setAnimeEpisodeRange;
    window.toggleAnimeSynopsis = toggleAnimeSynopsis;
    window.onAnimePageLanguageChange = onAnimePageLanguageChange;
    window.refreshAnimePageSources = refreshAnimePageSources;
    window.toggleAnimePageFavorite = toggleAnimePageFavorite;
    window.renderSearchAnimeMatches = renderSearchAnimeMatches;
    window.pickTorrentForEpisode = pickTorrentForEpisode;
    window.pickRecommendations = pickRecommendations;
    window.getCurrentAnimePageMedia = () => animePageState.media;
    window.animeCoverBackTransition = animeCoverBackTransition;
    // Option « couleurs de l'affiche » changée dans les Paramètres : la fiche ouverte suit tout de suite
    window.refreshAnimePageAccent = () => {
        const page = document.querySelector('#animeView .anime-page');
        if (!page || !animePageState.media) return;
        page.setAttribute('style', typeof animeAccentStyle === 'function' ? animeAccentStyle(animePageState.media.coverImage?.color) : '');
    };
