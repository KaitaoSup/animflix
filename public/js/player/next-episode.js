    // --- BINGE-WATCHING & ENCHAÎNEMENT AUTOMATIQUE DES ÉPISODES ---
    let hasNextEpisodeTriggered = false;
    let nextEpisodeCountdownTimer = null;
    let pendingNextEpisodeAction = null;

    function checkAutoPlayNextEpisode(effectiveTime, totalDur) {
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

        let targetLabel = null;
        let targetAction = null;

        // 1. Vérifier si c'est un pack multi-fichiers
        if (Array.isArray(window._currentPackFiles) && window._currentPackFiles.length > 1) {
            const curEp = currentDetectedEpisode;
            let nextFile = window._currentPackFiles.find(f => f.episode === curEp + 1);
            if (!nextFile) {
                const curIdx = window._currentPackFiles.findIndex(f => f.id === currentActiveFileIndex);
                if (curIdx !== -1 && curIdx < window._currentPackFiles.length - 1) {
                    nextFile = window._currentPackFiles[curIdx + 1];
                }
            }
            if (nextFile) {
                targetLabel = nextFile.label || ('Épisode ' + (curEp + 1));
                targetAction = () => playNextPackEpisode(nextFile);
            }
        }

        // 2. Sinon, épisode individuel
        if (!targetAction && currentAnimeItem) {
            const nextEpNum = (currentDetectedEpisode || 1) + 1;
            if (currentAnilistMedia?.episodes && currentDetectedEpisode >= currentAnilistMedia.episodes) {
                showToast("🎉 Vous avez terminé tous les épisodes de cette saison !");
                hasNextEpisodeTriggered = true;
                return;
            }
            targetLabel = `Épisode ${nextEpNum}`;
            targetAction = () => playNextEpisodeSearch(nextEpNum);
        }

        if (!targetAction) return;

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
    }

    function playNextEpisodeSearch(nextEpNum) {
        dismissNextEpisodeCountdown();
        if (!currentAnimeItem) return;
        const parsed = getAnimeDetails(currentAnimeItem);
        const animeName = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle;

        showToast(`🔍 Recherche automatique de l'Épisode ${nextEpNum}... ⏳`);
        closeDetailView();
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = animeName;

        if (typeof executeSearchForAnime === 'function') {
            executeSearchForAnime(animeName, {
                nextEp: nextEpNum,
                animeName: animeName,
                autoPlayDirect: true
            });
        }
    }

