// =========================================================================
// --- ANIMFLIX SEARCH & CATALOG (NYAA SEARCH, DETAIL VIEW, PACKS, VLC) ---
// =========================================================================

    function updateVlcLinks(vlcUrl) {
        const detailVlcBtn = document.getElementById('detailVlcBtn');
        if (detailVlcBtn) {
            detailVlcBtn.href = vlcUrl;
            detailVlcBtn.onclick = () => openInVlc(vlcUrl);
        }
        const detailCopyVlcBtn = document.getElementById('detailCopyVlcBtn');
        if (detailCopyVlcBtn) {
            detailCopyVlcBtn.onclick = (e) => {
                if (e) e.preventDefault();
                copyVlcLink(vlcUrl);
            };
        }
        const vlcLink = document.getElementById('vlcLink');
        if (vlcLink) {
            vlcLink.href = vlcUrl;
            vlcLink.onclick = () => openInVlc(vlcUrl);
        }
        const playerCopyVlcBtn = document.getElementById('playerCopyVlcBtn');
        if (playerCopyVlcBtn) {
            playerCopyVlcBtn.onclick = (e) => {
                if (e) e.preventDefault();
                copyVlcLink(vlcUrl);
            };
        }
    }

    // Chargement de la liste des épisodes si le torrent contient plusieurs vidéos (Packs / Batches)
    async function loadPackEpisodes(anime) {
        const packSection = document.getElementById('detailPackEpisodesSection');
        const packCount = document.getElementById('packEpisodesCount');
        const packList = document.getElementById('packEpisodesList');
        if (!packSection || !packList) return;

        packSection.style.display = 'none';
        packList.innerHTML = '';

        try {
            const res = await fetch('/api/torrent/files?magnet=' + encodeURIComponent(anime.lienMagnet));
            const data = await res.json();
            const files = data.files || [];

            if (data.isMultiFile && files.length > 1) {
                packCount.innerText = files.length;
                packSection.style.display = 'block';

                // Trouver l'épisode correspondant le mieux à la cible actuelle
                const parsed = getAnimeDetails(anime);
                const targetEp = currentDetectedEpisode || extractEpisodeNumber(anime.episode || parsed.episode, anime.titre);
                let selectedFile = files.find(f => f.episode === targetEp) || files[0];
                currentActiveFileIndex = selectedFile.id;

                files.forEach(f => {
                    const btn = document.createElement('button');
                    btn.className = 'btn-pack-ep' + (f.id === currentActiveFileIndex ? ' active' : '');
                    btn.innerHTML = `<span>▶</span> <span>${escapeHtml(f.label)}</span>`;
                    btn.title = f.name;
                    btn.onclick = () => {
                        document.querySelectorAll('.btn-pack-ep').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        currentActiveFileIndex = f.id;
                        currentStreamOffset = 0;
                        if (f.episode) {
                            currentDetectedEpisode = f.episode;
                            document.getElementById('detailEpisodeBadge').innerText = '🎬 Épisode ' + f.episode;
                            updatePlayerTrackButton();
                        }
                        const newVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(anime.lienMagnet) + "&index=" + f.id + "&play";
                        updateVlcLinks(newVlcUrl);
                        showToast(`🎬 Lecture : ${f.label}`);
                        startStreamingInPlayer(anime.lienMagnet, anime.titre, newVlcUrl, f.id, 0);
                    };
                    packList.appendChild(btn);
                });

                // Si le fichier cible trouvé n'était pas l'index 1, basculer immédiatement le lecteur dessus
                if (selectedFile.id !== 1) {
                    const matchedVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(anime.lienMagnet) + "&index=" + selectedFile.id + "&play";
                    updateVlcLinks(matchedVlcUrl);
                    if (selectedFile.episode) {
                        currentDetectedEpisode = selectedFile.episode;
                        document.getElementById('detailEpisodeBadge').innerText = '🎬 Épisode ' + selectedFile.episode;
                        updatePlayerTrackButton();
                    }
                    startStreamingInPlayer(anime.lienMagnet, anime.titre, matchedVlcUrl, selectedFile.id, 0);
                }
            }
        } catch (e) {
            console.warn("Erreur chargement des épisodes du pack:", e);
        }
    }

    // --- NAVIGATION ET REDIRECTION VERS LA PAGE DE DÉTAIL ---
    function openAnimeDetail(anime) {
        if (typeof resetSubtitlesState === 'function') {
            resetSubtitlesState();
        }
        currentAnimeItem = anime;
        currentActiveFileIndex = 1;
        currentActiveAudioIndex = null;
        currentStreamOffset = 0;

        // Bascule des vues
        document.getElementById('catalogView').style.display = 'none';
        const detailView = document.getElementById('detailView');
        detailView.style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });

        // Mise à jour de l'historique d'URL
        window.location.hash = 'detail';

        // Extraction et assignation des métadonnées
        const parsed = getAnimeDetails(anime);
        const animeName = anime.animeName || parsed.animeName || anime.cleanTitle || 'Anime';
        const season = anime.season || parsed.season || 'Saison 1';
        const episode = anime.episode || parsed.episode || 'Épisode 1';
        const resolution = anime.resolution || parsed.resolution || '1080p Full HD';
        const audioLang = anime.audioLang || parsed.audioLang || 'VOSTFR';
        const posterSrc = anime.poster || 'https://via.placeholder.com/300x450/191919/666666?text=' + encodeURIComponent(animeName);

        // Mise à jour du fil d'Ariane
        document.getElementById('detailBreadcrumb').innerText = `Animflix > ${animeName} > ${season} > ${episode}`;

        // Remplissage des éléments de la page de détail
        document.getElementById('detailAnimeName').innerText = animeName;
        document.getElementById('detailSeasonBadge').innerText = '🏷️ ' + season;
        document.getElementById('detailEpisodeBadge').innerText = '🎬 ' + episode;
        document.getElementById('detailAudioBadge').innerText = '🎧 ' + audioLang;
        document.getElementById('detailQualityBadge').innerText = '📺 ' + resolution;
        document.getElementById('detailRatingBadge').innerText = '⭐ ' + (anime.rating || 'N/A') + ' / 10';
        document.getElementById('detailSize').innerText = anime.taille || 'N/A';
        document.getElementById('detailSeeders').innerText = (anime.seeders || 0) + ' seeders actifs';
        document.getElementById('detailRawTitle').innerText = anime.titre;

        const posterImg = document.getElementById('detailPosterImg');
        posterImg.src = posterSrc;
        posterImg.onerror = function() {
            this.src = 'https://via.placeholder.com/300x450/191919/666666?text=' + encodeURIComponent(animeName);
        };

        // Configuration initiale des liens VLC et Magnet
        const vlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(anime.lienMagnet) + "&index=1&play";
        updateVlcLinks(vlcUrl);

        const detailMagnetBtn = document.getElementById('detailMagnetBtn');
        if (detailMagnetBtn) {
            detailMagnetBtn.href = anime.lienMagnet;
            detailMagnetBtn.onclick = () => {
                copyToClipboard(anime.lienMagnet);
                showToast("🧲 Ouverture du torrent & lien copié !");
            };
        }
        const detailCopyMagnetBtn = document.getElementById('detailCopyMagnetBtn');
        if (detailCopyMagnetBtn) {
            detailCopyMagnetBtn.onclick = (e) => {
                if (e) e.preventDefault();
                copyToClipboard(anime.lienMagnet);
                showToast("📋 Lien Magnet copié dans le presse-papier !");
            };
        }

        // Synchronisation du mode de lecture de la fiche
        const streamModeSelect = document.getElementById('detailStreamMode');
        if (streamModeSelect) {
            streamModeSelect.value = document.getElementById('streamMode').value || 'direct';
        }

        // Synchronisation du suivi de progression AniList
        syncAnilistForDetail(anime);

        // Lancement immédiat de la vidéo (fichier 1 par défaut)
        startStreamingInPlayer(anime.lienMagnet, anime.titre, vlcUrl, 1, 0);

        // Analyse des fichiers du pack en arrière-plan pour afficher les épisodes disponibles
        loadPackEpisodes(anime);
    }

    function closeDetailView() {
        if (streamTimeout) clearTimeout(streamTimeout);
        if (currentSubAbort) currentSubAbort.abort();
        
        const menu = document.getElementById('subStyleMenu');
        if (menu) menu.style.display = 'none';

        const video = document.getElementById('videoPlayer');
        video.pause();
        video.src = "";
        for (let i = 0; i < video.textTracks.length; i++) {
            video.textTracks[i].mode = 'disabled';
        }
        currentTextTrack = null;
        if (typeof resetSubtitlesState === 'function') {
            resetSubtitlesState();
        }

        // Purge automatique du torrent quitté dans TorrServer
        if (currentActiveMagnet) {
            fetch('/api/torrserver/drop?magnet=' + encodeURIComponent(currentActiveMagnet), { method: 'POST' }).catch(() => {});
        }

        currentActiveMagnet = null;
        currentActiveFileIndex = 1;
        currentActiveAudioIndex = null;
        currentStreamOffset = 0;
        currentTotalDuration = 1440;
        const curLabel = document.getElementById('playerDisplayCurrent');
        const totalLabel = document.getElementById('playerDisplayTotal');
        const prog = document.getElementById('playerScrubberProgress');
        const buf = document.getElementById('playerScrubberBuffered');
        if (curLabel) curLabel.textContent = "00:00";
        if (totalLabel) totalLabel.textContent = "--:--";
        if (prog) prog.style.width = "0%";
        if (buf) buf.style.width = "0%";
        currentAnimeItem = null;
        currentAnilistMedia = null;
        hasAutoTrackedCurrentEpisode = false;

        const packSection = document.getElementById('detailPackEpisodesSection');
        if (packSection) packSection.style.display = 'none';

        document.getElementById('detailView').style.display = 'none';
        document.getElementById('catalogView').style.display = 'block';

        if (window.location.hash === '#detail') {
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }

        const query = document.getElementById('searchInput')?.value.trim();
        if (!query) {
            showHomeScreen();
        }
    }

    function scrollToPlayer() {
        const playerArea = document.getElementById('detailPlayerArea');
        if (playerArea) {
            playerArea.scrollIntoView({ behavior: 'smooth' });
        }
    }

    function onDetailStreamModeChange() {
        if (!currentAnimeItem) return;
        const newMode = document.getElementById('detailStreamMode').value;
        document.getElementById('streamMode').value = newMode;
        const vlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(currentAnimeItem.lienMagnet) + "&index=" + currentActiveFileIndex + "&play";
        startStreamingInPlayer(currentAnimeItem.lienMagnet, currentAnimeItem.titre, vlcUrl, currentActiveFileIndex, currentStreamOffset);
        showToast("Mode de lecture mis à jour : " + (newMode === 'direct' ? '⚡ Direct' : '🔄 Transcodage'));
    }

    function handleSearchClick() {
        // Si l'utilisateur est sur la page de détail, revenir au catalogue pour afficher les nouveaux résultats
        const detailView = document.getElementById('detailView');
        if (detailView && detailView.style.display === 'block') {
            closeDetailView();
        }
        const query = document.getElementById('searchInput').value.trim();
        if (!query) {
            showHomeScreen();
            return;
        }
        if (currentTargetNextEpisode && currentTargetNextEpisode.animeName.toLowerCase().includes(query.toLowerCase())) {
            executeSearchForAnime(query, currentTargetNextEpisode);
        } else {
            currentTargetNextEpisode = null;
            executeSearchForAnime(query, null);
        }
    }

    // Gestion du bouton précédent du navigateur
    window.addEventListener('popstate', () => {
        if (window.location.hash !== '#detail') {
            const detailView = document.getElementById('detailView');
            if (detailView && detailView.style.display === 'block') {
                closeDetailView();
            }
        }
    });

    // --- RECHERCHE SUR NYAA & CIBLAGE D'ÉPISODE ---
    async function searchNyaa() {
        const query = document.getElementById('searchInput').value.trim();
        if (!query) {
            showHomeScreen();
            return;
        }
        executeSearchForAnime(query, currentTargetNextEpisode);
    }

    function playTargetEpisodeDirectly() {
        if (window._currentExactMatchTorrent) {
            openAnimeDetail(window._currentExactMatchTorrent);
        }
    }

    async function executeSearchForAnime(searchTitle, targetInfo = null) {
        const homeView = document.getElementById('homeView');
        const searchView = document.getElementById('searchView');
        const targetBanner = document.getElementById('searchTargetBanner');
        const resultsDiv = document.getElementById('results');

        if (homeView) homeView.style.display = 'none';
        if (searchView) searchView.style.display = 'block';

        const type = document.getElementById('searchType')?.value || 'vostfr';
        const nextEp = targetInfo ? targetInfo.nextEp : null;
        const animeDisplayName = targetInfo ? targetInfo.animeName : searchTitle;

        // Mise à jour de la bannière de ciblage
        if (targetInfo && targetBanner) {
            targetBanner.style.display = 'block';
            if (targetInfo.isNextEpUnreleased) {
                targetBanner.innerHTML = `
                    <div class="next-ep-target-banner" style="border-left-color: #f59e0b;">
                        <div class="next-ep-banner-left">
                            <button class="btn-back-watching" onclick="showHomeScreen()" title="Revenir aux animes en cours">
                                ← Mes animes en cours
                            </button>
                            <div class="next-ep-banner-info">
                                <div class="next-ep-banner-anime">🍿 ${escapeHtml(animeDisplayName)}</div>
                                <div class="next-ep-banner-subtitle">
                                    ⏳ Épisode <b>${nextEp}</b> pas encore sorti (diffusion dans : 
                                    <span class="next-ep-badge-highlight" style="background:rgba(245,158,11,0.2);border-color:rgba(245,158,11,0.5);color:#fbbf24;" data-airing-at="${targetInfo.airingTimestamp}">
                                        ${targetInfo.airingCountdownStr}
                                    </span>)
                                    <span style="font-size:12.5px;color:#888;">— Épisodes précédents ci-dessous :</span>
                                </div>
                            </div>
                        </div>
                        <div class="next-ep-banner-right" id="targetEpDirectAction"></div>
                    </div>
                `;
                startAiringCountdownTicker();
            } else {
                targetBanner.innerHTML = `
                    <div class="next-ep-target-banner">
                        <div class="next-ep-banner-left">
                            <button class="btn-back-watching" onclick="showHomeScreen()" title="Revenir aux animes en cours">
                                ← Mes animes en cours
                            </button>
                            <div class="next-ep-banner-info">
                                <div class="next-ep-banner-anime">🍿 ${escapeHtml(animeDisplayName)}</div>
                                <div class="next-ep-banner-subtitle">
                                    Prochain épisode à visionner : 
                                    <span class="next-ep-badge-highlight">Épisode ${nextEp}</span>
                                    ${targetInfo.totalEpisodes ? `<span style="color:#888;">(sur ${targetInfo.totalEpisodes})</span>` : ''}
                                </div>
                            </div>
                        </div>
                        <div class="next-ep-banner-right" id="targetEpDirectAction"></div>
                    </div>
                `;
            }
        } else if (targetBanner) {
            targetBanner.style.display = 'none';
        }

        resultsDiv.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1;">
                <div class="spinner" style="margin: 0 auto 20px;"></div>
                Recherche des vidéos pour "<b>${escapeHtml(animeDisplayName)}</b>"${nextEp ? ` (Épisode ${nextEp})` : ''}... ⏳
            </div>
        `;

        try {
            let response = await fetch('/api/search?q=' + encodeURIComponent(searchTitle) + '&type=' + type);
            let torrents = await response.json();

            // Fallback éventuel sur le titre anglais si aucun résultat avec le romaji
            if ((!torrents || torrents.length === 0) && targetInfo?.english && targetInfo.english !== searchTitle) {
                const fallbackQuery = targetInfo.english.replace(/[:]/g, ' ').replace(/\s+/g, ' ').trim();
                const fallbackRes = await fetch('/api/search?q=' + encodeURIComponent(fallbackQuery) + '&type=' + type);
                const fallbackTorrents = await fallbackRes.json();
                if (fallbackTorrents && fallbackTorrents.length > 0) {
                    torrents = fallbackTorrents;
                }
            }

            if (!torrents || torrents.length === 0) {
                resultsDiv.innerHTML = `
                    <div class="empty-state" style="grid-column: 1 / -1;">
                        Aucun torrent trouvé pour "${escapeHtml(searchTitle)}".<br>
                        <span style="font-size: 13.5px; color: #888; margin-top: 8px; display: inline-block;">
                            Essayez de changer de langue (ex: VF ou Multi-Sub) ci-dessus.
                        </span>
                        <div style="margin-top: 18px;">
                            <button class="btn-secondary" onclick="showHomeScreen()">← Revenir à mes animes en cours</button>
                        </div>
                    </div>
                `;
                return;
            }

            // Traitement et classification des torrents pour l'épisode ciblé
            let exactMatchTorrent = null;
            const mappedTorrents = torrents.map(t => {
                let matchType = null;
                if (nextEp) {
                    const epNum = extractEpisodeNumber(t.episode, t.titre);
                    if (epNum === nextEp) {
                        matchType = 'exact';
                    } else {
                        const isPack = /integrale|intégrale|pack|batch|saison complète|complete/i.test(t.episode || '') ||
                                       /integrale|intégrale|pack|batch|complete|s\d+[-+]s\d+/i.test(t.titre || '');
                        const rangeMatch = (t.episode || '').match(/Épisodes?\s*0*(\d+)\s*[-~]\s*0*(\d+)/i) ||
                                           (t.titre || '').match(/\b(?:E|EP|Épisode|Episode)\s*0*(\d+)\s*[-~]\s*0*(\d+)\b/i);
                        if (rangeMatch) {
                            const start = parseInt(rangeMatch[1], 10);
                            const end = parseInt(rangeMatch[2], 10);
                            if (nextEp >= start && nextEp <= end) matchType = 'pack';
                        } else if (isPack) {
                            matchType = 'batch';
                        }
                    }
                }
                return { torrent: t, matchType };
            });

            // Tri : exacts en tête, puis packs/batchs, puis les autres (par seeders)
            if (nextEp) {
                mappedTorrents.sort((a, b) => {
                    const rank = (m) => (m === 'exact' ? 3 : (m === 'pack' || m === 'batch' ? 2 : 1));
                    const rankDiff = rank(b.matchType) - rank(a.matchType);
                    if (rankDiff !== 0) return rankDiff;
                    return (b.torrent.seeders || 0) - (a.torrent.seeders || 0);
                });
                const firstExact = mappedTorrents.find(m => m.matchType === 'exact');
                if (firstExact) exactMatchTorrent = firstExact.torrent;
            }

            // Bouton d'action directe dans la bannière supérieure
            const directActionContainer = document.getElementById('targetEpDirectAction');
            if (directActionContainer) {
                if (exactMatchTorrent) {
                    window._currentExactMatchTorrent = exactMatchTorrent;
                    directActionContainer.innerHTML = `
                        <button class="btn-play-target-direct" onclick="playTargetEpisodeDirectly()">
                            ▶ Lancer l'Épisode ${nextEp} direct
                        </button>
                    `;
                } else {
                    directActionContainer.innerHTML = '';
                }
            }

            // Rendu des cartes de torrents
            resultsDiv.innerHTML = '';
            mappedTorrents.forEach(({ torrent: t, matchType }) => {
                const parsed = getAnimeDetails(t);
                const animeName = t.animeName || parsed.animeName || t.cleanTitle || 'Anime';
                const season = t.season || parsed.season || 'Saison 1';
                const episode = t.episode || parsed.episode || 'Épisode 1';
                const resolution = (t.resolution || parsed.resolution || '1080p').split(' ')[0];
                const audioLang = t.audioLang || parsed.audioLang || 'VOSTFR';
                const posterSrc = t.poster || (targetInfo?.coverImage) || ('https://via.placeholder.com/300x450/191919/666666?text=' + encodeURIComponent(animeName));

                const isTargetMatch = matchType === 'exact';
                const isPackMatch = matchType === 'pack' || matchType === 'batch';

                const card = document.createElement('div');
                card.className = 'card' + (isTargetMatch ? ' card-target-highlight' : '');
                
                let highlightBadgeHtml = '';
                if (isTargetMatch) {
                    highlightBadgeHtml = `<span class="badge-tag-mini badge-target-direct-match">⭐ ÉPISODE ${nextEp}</span>`;
                } else if (isPackMatch) {
                    highlightBadgeHtml = `<span class="badge-tag-mini badge-target-pack-match">📦 PACK (ÉP. ${nextEp})</span>`;
                }

                card.innerHTML = `
                    <div class="card-img-wrap">
                        <img src="${escapeHtml(posterSrc)}" loading="lazy" alt="${escapeHtml(animeName)}" onerror="this.src='https://via.placeholder.com/300x450/191919/666666?text=Anime'">
                        <div class="card-overlay-hover">
                            <span class="btn-play-hover" style="${isTargetMatch ? 'background:var(--accent-green);color:#000;font-weight:800;' : ''}">
                                ▶ ${isTargetMatch ? `Regarder l'Épisode ${nextEp}` : 'Voir la fiche & Regarder'}
                            </span>
                        </div>
                        <div class="card-badges-top">
                            <div style="display:flex; gap:4px; flex-wrap:wrap;">
                                <span class="badge-tag-mini">${resolution}</span>
                                <span class="badge-tag-mini badge-tag-audio">${audioLang.includes('MULTI') ? 'MULTI' : (audioLang.includes('VF') ? 'VF' : 'VOSTFR')}</span>
                            </div>
                            ${highlightBadgeHtml}
                        </div>
                    </div>
                    <div class="card-info">
                        <span class="card-title" title="${escapeHtml(t.titre)}">${escapeHtml(animeName)}</span>
                        <div class="card-ep-season">
                            <span class="card-season-pill">${escapeHtml(season)}</span>
                            <span class="card-episode-pill" style="${isTargetMatch ? 'background:rgba(70,211,105,0.2);color:#5eff88;border-color:rgba(70,211,105,0.5);font-weight:bold;' : ''}">
                                ${escapeHtml(episode)}
                            </span>
                        </div>
                        <div class="stats">
                            <span class="badge-rating">⭐ ${t.rating || 'N/A'}</span>
                            <span>${t.taille}</span>
                            <span class="seeders">🌱 ${t.seeders}</span>
                        </div>
                    </div>
                `;

                card.onclick = () => openAnimeDetail(t);
                resultsDiv.appendChild(card);
            });
        } catch (err) { 
            resultsDiv.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; color:#ff4444;">
                    Erreur de connexion au serveur : ${escapeHtml(err.message)}
                    <div style="margin-top: 15px;">
                        <button class="btn-secondary" onclick="showHomeScreen()">← Revenir à mes animes en cours</button>
                    </div>
                </div>
            `; 
        }
    }


    async function cleanTorrServerCache() {
        if (!confirm("Voulez-vous purger tous les torrents et données en mémoire de TorrServer ?\n(Libère immédiatement la RAM et le cache de streaming)")) return;
        showToast("Purge du cache TorrServer en cours... ⏳");
        try {
            const res = await fetch('/api/torrserver/clean', { method: 'POST' });
            const data = await res.json();
            showToast(`✅ ${data.message || 'Cache TorrServer nettoyé !'}`);
        } catch (e) {
            showToast("❌ Erreur lors du nettoyage : " + e.message);
        }
    }


    function openInVlc(vlcUrl) {
        copyToClipboard(vlcUrl);
        showToast("🟠 Lancement de VLC... (Lien copié dans le presse-papier !)");
        try {
            const a = document.createElement('a');
            a.href = "vlc://" + vlcUrl;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => a.remove(), 1000);
        } catch(err) {
            console.warn("Erreur protocole vlc://", err);
        }
    }

    function copyVlcLink(url) {
        copyToClipboard(url);
        showToast("✅ Lien copié ! Ouvrez VLC > Média > Ouvrir un flux réseau (Ctrl+N)");
    }

    // Fermeture des menus lors d'un clic en dehors
    document.addEventListener('click', (e) => {
        const menu = document.getElementById('subStyleMenu');
        const btn = document.getElementById('subStyleBtn');
        if (menu && menu.style.display === 'block') {
            if (!menu.contains(e.target) && (!btn || !btn.contains(e.target))) {
                menu.style.display = 'none';
            }
        }

        const anilistBadge = document.getElementById('anilistUserBadge');
        if (anilistBadge && !anilistBadge.contains(e.target)) {
            anilistBadge.classList.remove('active');
        }
    });
