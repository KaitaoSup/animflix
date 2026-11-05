    function loadDemoWatchingList() {
        anilistWatchingList = [
            {
                id: 154587,
                status: "CURRENT",
                progress: 5,
                updatedAt: Math.floor(Date.now() / 1000),
                media: {
                    id: 154587,
                    isAdult: false,
                    genres: ["Action", "Adventure", "Fantasy"],
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
                    isAdult: false,
                    genres: ["Action", "Comedy", "Supernatural"],
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
                    isAdult: false,
                    genres: ["Action", "Fantasy"],
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
            },
            {
                id: 999999,
                status: "CURRENT",
                progress: 1,
                updatedAt: Math.floor(Date.now() / 1000) - 10800,
                media: {
                    id: 999999,
                    isAdult: true,
                    genres: ["Ecchi", "Hentai"],
                    title: {
                        romaji: "Kanojo x Kanojo x Kanojo",
                        english: "Girl x Girl x Girl",
                        userPreferred: "Kanojo x Kanojo x Kanojo"
                    },
                    episodes: 3,
                    format: "OVA",
                    status: "FINISHED",
                    averageScore: 78,
                    coverImage: {
                        large: posterFallback("18+ Demo")
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
    function watchAnimeNextEpisode(target) {
        let entry = null;
        if (typeof target === 'object' && target !== null) {
            entry = target;
        } else if (typeof target === 'number') {
            // Recherche prioritaire par ID AniList du média
            entry = anilistWatchingList.find(e => e.media && e.media.id === target);
            if (!entry && target >= 0 && target < anilistWatchingList.length) {
                entry = anilistWatchingList[target];
            }
        }
        if (!entry || !entry.media) return;

        const media = entry.media;
        const progress = entry.progress || 0;
        const nextEp = progress + 1;
        const total = media.episodes || null;
        
        // Priorité absolue au titre anglais selon la demande utilisateur
        let searchTitle = media.title?.english || media.title?.romaji || media.title?.userPreferred || 'Anime';
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

        // Enregistrer l'association d'ID AniList pour tous les alias du titre
        try {
            localStorage.setItem('anilist_map_' + searchTitle.toLowerCase(), media.id);
            if (media.title?.english) {
                localStorage.setItem('anilist_map_' + media.title.english.toLowerCase(), media.id);
            }
            if (media.title?.romaji) {
                localStorage.setItem('anilist_map_' + media.title.romaji.toLowerCase(), media.id);
            }
            if (media.title?.userPreferred) {
                localStorage.setItem('anilist_map_' + media.title.userPreferred.toLowerCase(), media.id);
            }
        } catch(e) {}

        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = searchTitle;

        currentTargetNextEpisode = {
            mediaId: media.id,
            animeName: media.title?.english || media.title?.userPreferred || media.title?.romaji || searchTitle,
            searchTitle: searchTitle,
            romaji: media.title?.romaji,
            english: media.title?.english,
            userPreferred: media.title?.userPreferred,
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
                                    isAdult
                                    genres
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

