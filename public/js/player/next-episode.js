    // --- BINGE-WATCHING & ENCHAÎNEMENT AUTOMATIQUE DES ÉPISODES ---
    let hasNextEpisodeTriggered = false;
    let nextEpisodeCountdownTimer = null;
    let pendingNextEpisodeAction = null;

    // Épisode suivant préparé pendant la lecture : { forEpKey, epNum, torrent }
    let preparedNextEpisode = null;
    let nextEpisodePreloadKey = null; // épisode en cours pour lequel le préchargement a déjà été lancé
    const NEXT_EPISODE_PRELOAD_AT = 0.8;

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
        if (!target || target.kind === 'finished') return;
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
        if (target.kind === 'finished') {
            showToast("🎉 Vous avez terminé tous les épisodes de cette saison !");
            hasNextEpisodeTriggered = true;
            return;
        }
        const targetLabel = target.label;
        const targetAction = target.kind === 'pack'
            ? () => playNextPackEpisode(target.file)
            : () => playNextEpisodeSearch(target.epNum);

        hasNextEpisodeTriggered = true;
        pendingNextEpisodeAction = targetAction;

        const overlay = document.getElementById('playerNextEpOverlay');
        const labelEl = document.getElementById('nextEpLabel');
        const timerEl = document.getElementById('nextEpCountdownSec');

        if (!overlay) return;

        if (labelEl) labelEl.textContent = targetLabel;
        let countdown = forceImmediate ? 3 : 6;
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

