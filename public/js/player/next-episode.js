    // --- BINGE-WATCHING & ENCHAÎNEMENT AUTOMATIQUE DES ÉPISODES ---
    let hasNextEpisodeTriggered = false;
    let nextEpisodeCountdownTimer = null;
    let pendingNextEpisodeAction = null;

    // Épisode suivant préparé pendant la lecture : { forEpKey, epNum, torrent }
    let preparedNextEpisode = null;
    let nextEpisodePreloadKey = null; // épisode en cours pour lequel le préchargement a déjà été lancé
    const NEXT_EPISODE_PRELOAD_AT = 0.8;
    const SEQUEL_COUNTDOWN_SEC = 10;

    // --- SAISON SUIVANTE (SUITE ANILIST) ---

    // Formats enchaînés après le dernier épisode (pas les OVA / spéciaux, souvent hors de l'histoire principale)
    const SEQUEL_FORMAT_PRIORITY = ['TV', 'TV_SHORT', 'ONA', 'MOVIE'];
    const sequelLookups = new Map(); // id AniList -> Promise<{ id, title } | null>

    function pickSequelEdge(edges) {
        return (edges || [])
            .filter(e => e?.relationType === 'SEQUEL'
                && e.node?.type === 'ANIME'
                && SEQUEL_FORMAT_PRIORITY.includes(e.node.format)
                && e.node.status !== 'NOT_YET_RELEASED'
                && e.node.status !== 'CANCELLED')
            .sort((a, b) => SEQUEL_FORMAT_PRIORITY.indexOf(a.node.format) - SEQUEL_FORMAT_PRIORITY.indexOf(b.node.format))[0] || null;
    }

    /**
     * Suite AniList de l'anime en cours ({ id, title }), ou null s'il n'y en a pas (ou pas encore diffusée).
     * Une recherche par anime : lancée pendant le préchargement, elle est prête à la fin de l'épisode.
     */
    function findSequelMedia(mediaId) {
        mediaId = Number(mediaId);
        if (!mediaId || typeof callAnilistGraphQL !== 'function') return Promise.resolve(null);
        if (!sequelLookups.has(mediaId)) {
            const query = `
                query ($id: Int) {
                    Media(id: $id, type: ANIME) {
                        relations {
                            edges {
                                relationType
                                node { id type format status title { english userPreferred romaji } }
                            }
                        }
                    }
                }
            `;
            const lookup = callAnilistGraphQL(query, { id: mediaId })
                .then(data => {
                    const edge = pickSequelEdge(data?.Media?.relations?.edges);
                    if (!edge) return null;
                    const t = edge.node.title || {};
                    return { id: edge.node.id, title: t.english || t.userPreferred || t.romaji || 'Saison suivante' };
                })
                .catch(err => {
                    sequelLookups.delete(mediaId); // erreur réseau : nouvel essai au prochain appel
                    console.warn('[Saison suivante] Recherche AniList impossible :', err.message);
                    return null;
                });
            sequelLookups.set(mediaId, lookup);
        }
        return sequelLookups.get(mediaId);
    }

    async function playSequelFirstEpisode(sequel) {
        dismissNextEpisodeCountdown();
        if (!sequel || typeof openAnimePage !== 'function') return;
        showToast(`📺 Saison suivante : ${sequel.title}`);
        // Fiche de la suite (URL #/anime/<id>?ep=1, le retour y ramène), puis lecture de l'épisode 1
        await openAnimePage(sequel.id, { ep: 1 });
        if (window._currentAnimePageId === sequel.id && typeof playAnimeEpisode === 'function') {
            playAnimeEpisode(1);
        }
    }

    /**
     * Ce qui suit l'épisode en cours : { kind: 'pack', file, label } (fichier suivant du même torrent),
     * { kind: 'search', epNum, label } (nouvelle recherche Nyaa), { kind: 'finished' } ou null
     */
    function resolveNextEpisodeTarget() {
        if (Array.isArray(window._currentPackFiles) && window._currentPackFiles.length > 1) {
            const curEp = currentDetectedEpisode;
            let nextFile = window._currentPackFiles.find(f => f.episode === curEp + 1);
            if (!nextFile) {
                const curIdx = window._currentPackFiles.findIndex(f => f.id === currentActiveFileIndex);
                if (curIdx !== -1 && curIdx < window._currentPackFiles.length - 1) {
                    nextFile = window._currentPackFiles[curIdx + 1];
                }
            }
            if (nextFile) return { kind: 'pack', file: nextFile, label: nextFile.label || ('Épisode ' + (curEp + 1)) };
        }
        if (currentAnimeItem) {
            const nextEpNum = (currentDetectedEpisode || 1) + 1;
            if (currentAnilistMedia?.episodes && currentDetectedEpisode >= currentAnilistMedia.episodes) {
                return { kind: 'finished' };
            }
            return { kind: 'search', epNum: nextEpNum, label: `Épisode ${nextEpNum}` };
        }
        return null;
    }

    function requestTorrentPreload(magnet, fileIndex) {
        return fetch('/api/torrserver/preload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ magnet, fileIndex })
        }).catch(() => {});
    }

    // Vers 80 % de l'épisode : TorrServer commence à télécharger le suivant, qui démarrera presque instantanément
    async function checkPreloadNextEpisode(effectiveTime, totalDur) {
        const epKey = window._currentPlayingEpisodeKey;
        if (!epKey || nextEpisodePreloadKey === epKey || !totalDur || totalDur <= 300) return;
        if (effectiveTime < totalDur * NEXT_EPISODE_PRELOAD_AT) return;
        // Sans enchaînement automatique, rien ne dit que l'épisode suivant sera regardé : pas de téléchargement inutile
        if ((localStorage.getItem('animflix_autoplay_next') || 'enabled') === 'disabled') return;
        nextEpisodePreloadKey = epKey;

        const target = resolveNextEpisodeTarget();
        if (!target) return;
        if (target.kind === 'finished') {
            // Dernier épisode : la suite AniList est cherchée maintenant pour proposer la saison suivante sans attente
            findSequelMedia(currentAnilistMedia?.id);
            return;
        }
        if (target.kind === 'pack') {
            requestTorrentPreload(currentActiveMagnet, target.file.id);
            return;
        }

        // Épisode dans un autre torrent : même recherche et même choix que l'enchaînement (searchNextEpisodeTorrent)
        try {
            const parsed = getAnimeDetails(currentAnimeItem);
            const animeName = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle;
            const torrent = await searchNextEpisodeTorrent(animeName, target.epNum);
            if (!torrent || window._currentPlayingEpisodeKey !== epKey) return;
            preparedNextEpisode = { forEpKey: epKey, epNum: target.epNum, torrent };
            console.log(`⏩ Épisode ${target.epNum} préparé : ${torrent.titre}`);
            requestTorrentPreload(torrent.lienMagnet, 1);
        } catch (e) {
            console.warn('[Préchargement] Recherche de l\'épisode suivant impossible :', e.message);
        }
    }

    function checkAutoPlayNextEpisode(effectiveTime, totalDur) {
        checkPreloadNextEpisode(effectiveTime, totalDur);
        if (hasNextEpisodeTriggered || !totalDur || totalDur <= 60) return;
        const autoPref = localStorage.getItem('animflix_autoplay_next') || 'enabled';
        if (autoPref === 'disabled') return;
        const timeLeft = totalDur - effectiveTime;
        if (timeLeft <= 25 && timeLeft > 0) {
            triggerNextEpisodeOverlay();
        }
    }

    function triggerNextEpisodeOverlay(forceImmediate = false) {
        if (hasNextEpisodeTriggered) return;

        const target = resolveNextEpisodeTarget();
        if (!target) return;
        hasNextEpisodeTriggered = true;

        if (target.kind === 'finished') {
            // Fin de saison : enchaîner sur la suite AniList si elle existe
            const epKey = window._currentPlayingEpisodeKey;
            findSequelMedia(currentAnilistMedia?.id).then(sequel => {
                if (window._currentPlayingEpisodeKey !== epKey) return; // autre épisode lancé entre-temps
                if (!sequel) {
                    // Pas de suite : invitation à noter la série (si elle n'a pas encore de note AniList)
                    const prompted = typeof maybePromptAnilistRating === 'function' && maybePromptAnilistRating();
                    if (!prompted) showToast("🎉 Vous avez terminé tous les épisodes de cette saison !");
                    return;
                }
                showNextEpisodeOverlay({
                    badge: '📺 Saison suivante',
                    label: sequel.title,
                    action: () => playSequelFirstEpisode(sequel),
                    countdown: forceImmediate ? 5 : SEQUEL_COUNTDOWN_SEC
                });
            });
            return;
        }

        showNextEpisodeOverlay({
            badge: '🎬 Épisode suivant',
            label: target.label,
            action: target.kind === 'pack'
                ? () => playNextPackEpisode(target.file)
                : () => playNextEpisodeSearch(target.epNum),
            countdown: forceImmediate ? 3 : 6
        });
    }

    function showNextEpisodeOverlay({ badge, label, action, countdown }) {
        pendingNextEpisodeAction = action;

        const overlay = document.getElementById('playerNextEpOverlay');
        const badgeEl = document.getElementById('nextEpBadge');
        const labelEl = document.getElementById('nextEpLabel');
        const timerEl = document.getElementById('nextEpCountdownSec');

        if (!overlay) return;

        if (badgeEl) badgeEl.textContent = badge;
        if (labelEl) labelEl.textContent = label;
        if (timerEl) timerEl.textContent = countdown;
        overlay.style.display = 'flex';

        if (nextEpisodeCountdownTimer) clearInterval(nextEpisodeCountdownTimer);
        nextEpisodeCountdownTimer = setInterval(() => {
            countdown--;
            if (timerEl) timerEl.textContent = countdown;
            if (countdown <= 0) {
                clearInterval(nextEpisodeCountdownTimer);
                nextEpisodeCountdownTimer = null;
                playNextEpisodeNow();
            }
        }, 1000);
    }

    function playNextEpisodeNow() {
        if (nextEpisodeCountdownTimer) {
            clearInterval(nextEpisodeCountdownTimer);
            nextEpisodeCountdownTimer = null;
        }
        const overlay = document.getElementById('playerNextEpOverlay');
        if (overlay) overlay.style.display = 'none';

        if (typeof pendingNextEpisodeAction === 'function') {
            const action = pendingNextEpisodeAction;
            pendingNextEpisodeAction = null;
            action();
        }
    }

    function dismissNextEpisodeCountdown() {
        if (nextEpisodeCountdownTimer) {
            clearInterval(nextEpisodeCountdownTimer);
            nextEpisodeCountdownTimer = null;
        }
        pendingNextEpisodeAction = null;
        const overlay = document.getElementById('playerNextEpOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    function playNextPackEpisode(nextFile) {
        dismissNextEpisodeCountdown();
        if (!currentAnimeItem || !nextFile) return;

        currentActiveFileIndex = nextFile.id;
        currentStreamOffset = 0;
        if (nextFile.episode) {
            currentDetectedEpisode = nextFile.episode;
            const epBadge = document.getElementById('detailEpisodeBadge');
            if (epBadge) epBadge.innerText = '🎬 Épisode ' + nextFile.episode;
            updatePlayerTrackButton();
        }
        const newVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(currentAnimeItem.lienMagnet) + "&index=" + nextFile.id + "&play";
        updateVlcLinks(newVlcUrl);
        showToast(`🎬 Enchaînement : ${nextFile.label}`);

        document.querySelectorAll('.btn-pack-ep').forEach(b => {
            if (b.title === nextFile.name) b.classList.add('active');
            else b.classList.remove('active');
        });

        startStreamingInPlayer(currentAnimeItem.lienMagnet, currentAnimeItem.titre, newVlcUrl, nextFile.id, 0);
        if (typeof AppRouter !== 'undefined') {
            AppRouter.sync(AppRouter.watchPath(currentAnimeItem.lienMagnet, nextFile.id), { replace: true });
        }
    }

    function playNextEpisodeSearch(nextEpNum) {
        dismissNextEpisodeCountdown();
        if (!currentAnimeItem) return;
        const parsed = getAnimeDetails(currentAnimeItem);
        const animeName = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle;

        showToast(`🔍 Recherche automatique de l'Épisode ${nextEpNum}... ⏳`);
        // L'URL reste sur le lecteur : l'épisode suivant la remplacera (le retour ramène à la page d'origine)
        closeDetailView({ navigate: false });
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = animeName;

        // Torrent déjà choisi et préchargé pendant l'épisode précédent : l'enchaînement le reprend
        // (préparé depuis l'épisode qui se termine : pas un reste d'un autre anime ayant le même numéro suivant)
        const prepared = preparedNextEpisode
            && preparedNextEpisode.epNum === nextEpNum
            && preparedNextEpisode.forEpKey === window._currentPlayingEpisodeKey
            ? preparedNextEpisode.torrent : null;
        preparedNextEpisode = null;

        if (typeof executeSearchForAnime === 'function') {
            executeSearchForAnime(animeName, {
                nextEp: nextEpNum,
                animeName: animeName,
                autoPlayDirect: true,
                preparedTorrent: prepared
            });
        }
    }

