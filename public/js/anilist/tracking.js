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
                            genres
                            siteUrl
                            coverImage { large medium }
                            ${token ? 'mediaListEntry { id status progress score(format: POINT_100) }' : ''}
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
                            genres
                            siteUrl
                            coverImage { large medium }
                            ${token ? 'mediaListEntry { id status progress score(format: POINT_100) }' : ''}
                        }
                    }
                `;
                variables = { search: animeName };
            }

            const data = await callAnilistGraphQL(query, variables);
            currentAnilistMedia = data?.Media || null;
            renderAnilistDetailCard();
            updatePlayerTrackButton();

            // Relancer AniSkip si rien n'est chargé ou si les intervalles concernent un autre anime / épisode
            if (typeof checkAniSkipForCurrentEpisode === 'function'
                && (typeof window.aniSkipNeedsRefresh !== 'function' || window.aniSkipNeedsRefresh())) {
                checkAniSkipForCurrentEpisode();
            }
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
                    <span style="color: #fff; font-weight: 600;">${escapeHtml(mediaTitle)}</span>
                    <span class="anilist-badge-status status-${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>
                </div>
                <div class="anilist-track-actions-top">
                    <a href="${escapeHtml(currentAnilistMedia.siteUrl)}" target="_blank" rel="noopener" class="btn-anilist-link">
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
                    <img class="anilist-candidate-thumb" src="${escapeHtml(it.coverImage?.medium || '')}" alt="${escapeHtml(title)}">
                    <div style="flex: 1; min-width: 0;">
                        <div style="font-weight: 700; font-size: 14px; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(title)}</div>
                        <div style="font-size: 12px; color: #888; margin-top: 3px;">
                            ${escapeHtml(it.format || 'TV')} • ${it.episodes ? Number(it.episodes) + ' épisodes' : 'Épisodes en cours'} • ${escapeHtml(it.status)}
                        </div>
                    </div>
                    <button class="btn-anilist-quick-ep" style="padding: 6px 12px; font-size: 12px;">Associer</button>
                `;
                itemEl.onclick = () => selectAnilistCandidate(it);
                list.appendChild(itemEl);
            });
        } catch(err) {
            list.innerHTML = `<div style="color: #ff4444; font-size: 13px; text-align: center; padding: 20px;">Erreur : ${escapeHtml(err.message)}</div>`;
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

    // Export global pour interaction depuis le DOM HTML
    window.watchAnimeNextEpisode = watchAnimeNextEpisode;
    window.toggleNsfwFilter = toggleNsfwFilter;
    window.onNsfwContainerClick = onNsfwContainerClick;
    window.getShowNsfwPreference = getShowNsfwPreference;
    window.loadAnilistWatchingList = loadAnilistWatchingList;
    window.loadDemoWatchingList = loadDemoWatchingList;
    window.renderDiscoverTabHtml = renderDiscoverTabHtml;
    window.searchFromDiscover = searchFromDiscover;
    window.renderHomeScreen = renderHomeScreen;
    window.renderHomeMainDashboardHtml = renderHomeMainDashboardHtml;
    window.renderScheduleTabHtml = renderScheduleTabHtml;
    window.selectScheduleDay = selectScheduleDay;
    window.watchScheduleEpisode = watchScheduleEpisode;
    window.onDiscoverFilterChange = onDiscoverFilterChange;
    window.resetDiscoverFilters = resetDiscoverFilters;


