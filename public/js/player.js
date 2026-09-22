// =========================================================================
// --- ANIMFLIX MEDIA PLAYER (CUSTOM CONTROLS, TIMELINE, SHORTCUTS) ---
// =========================================================================

    function updatePlayerProgress() {
        const video = document.getElementById('videoPlayer');
        if (!video) return;
        const effectiveTime = Math.max(0, currentStreamOffset + (video.currentTime || 0));
        const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;

        if (!isScrubbing) {
            const curLabel = document.getElementById('playerDisplayCurrent');
            const totalLabel = document.getElementById('playerDisplayTotal');
            const prog = document.getElementById('playerScrubberProgress');

            if (curLabel) curLabel.textContent = formatTimestamp(effectiveTime);
            if (totalLabel) totalLabel.textContent = formatTimestamp(totalDur);

            if (prog && totalDur > 0) {
                const pct = Math.min(100, Math.max(0, (effectiveTime / totalDur) * 100));
                prog.style.width = pct + '%';
            }
        }

        // Mise à jour de la mémoire tampon (buffer)
        if (video.buffered && video.buffered.length > 0 && totalDur > 0) {
            try {
                const bufEnd = video.buffered.end(video.buffered.length - 1);
                const bufTotal = currentStreamOffset + bufEnd;
                const bufPct = Math.min(100, Math.max(0, (bufTotal / totalDur) * 100));
                const bufEl = document.getElementById('playerScrubberBuffered');
                if (bufEl) bufEl.style.width = bufPct + '%';
            } catch (e) {}
        }

        // Sauvegarde automatique et périodique de la progression dans l'historique local
        if (typeof savePlaybackProgress === 'function') {
            savePlaybackProgress();
        }

        // Vérification dynamique AniSkip (Opening / Ending)
        if (typeof updateAniSkipButton === 'function') {
            updateAniSkipButton(effectiveTime);
        }

        // Vérification de fin d'épisode pour l'enchaînement automatique (Binge-Watching)
        if (typeof checkAutoPlayNextEpisode === 'function') {
            checkAutoPlayNextEpisode(effectiveTime, totalDur);
        }
    }

    let seekDebounceTimeout = null;
    function seekVideoTo(targetSeconds, immediate = false) {
        if (!currentActiveMagnet) return;
        if (typeof dismissResumeBanner === 'function') {
            dismissResumeBanner(false);
        }
        const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;
        const target = Math.max(0, Math.min(totalDur, Math.round(targetSeconds)));
        
        currentStreamOffset = target;
        updatePlayerProgress();

        if (seekDebounceTimeout) {
            clearTimeout(seekDebounceTimeout);
            seekDebounceTimeout = null;
        }

        const executeSeek = () => {
            const currentVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(currentActiveMagnet) + "&index=" + currentActiveFileIndex + "&play";
            startStreamingInPlayer(currentActiveMagnet, currentAnimeItem?.titre || 'Anime', currentVlcUrl, currentActiveFileIndex, target);
        };

        if (immediate) {
            executeSeek();
        } else {
            seekDebounceTimeout = setTimeout(executeSeek, 200);
        }
    }

    function jumpSeekRelative(deltaSeconds) {
        const video = document.getElementById('videoPlayer');
        if (!video || !currentActiveMagnet) return;
        const currentPos = currentStreamOffset + (video.currentTime || 0);
        const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;
        const targetPos = Math.max(0, Math.min(totalDur, Math.round(currentPos + deltaSeconds)));
        showToast((deltaSeconds > 0 ? `⏩ +${deltaSeconds}s` : `⏪ ${Math.abs(deltaSeconds)}s`) + ` (${formatTimestamp(targetPos)})`);
        seekVideoTo(targetPos);
    }

    function showCenterFeedback(icon) {
        const el = document.getElementById('playerCenterIndicator');
        if (!el) return;
        el.textContent = icon;
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 400);
    }

    function toggleCustomPlayPause() {
        const video = document.getElementById('videoPlayer');
        if (!video) return;
        if (video.paused) {
            video.play().catch(() => {});
            showCenterFeedback('▶');
        } else {
            video.pause();
            showCenterFeedback('❚❚');
        }
    }

    function onCustomVolumeInput(val) {
        const video = document.getElementById('videoPlayer');
        if (!video) return;
        video.volume = parseFloat(val);
        video.muted = (video.volume === 0);
        updateVolumeIcon();
    }

    function toggleCustomMute() {
        const video = document.getElementById('videoPlayer');
        if (!video) return;
        video.muted = !video.muted;
        updateVolumeIcon();
    }

    function updateVolumeIcon() {
        const video = document.getElementById('videoPlayer');
        const icon = document.getElementById('customVolumeIcon');
        const slider = document.getElementById('customVolumeSlider');
        if (!video || !icon) return;
        if (video.muted || video.volume === 0) {
            icon.textContent = '🔇';
            if (slider) slider.value = 0;
        } else if (video.volume < 0.5) {
            icon.textContent = '🔉';
            if (slider) slider.value = video.volume;
        } else {
            icon.textContent = '🔊';
            if (slider) slider.value = video.volume;
        }
    }

    function showControls() {
        const wrapper = document.getElementById('playerVideoWrapper');
        if (!wrapper) return;
        wrapper.classList.remove('hide-controls');
        if (controlsHideTimeout) clearTimeout(controlsHideTimeout);
    }

    function resetControlsTimer() {
        showControls();
        const video = document.getElementById('videoPlayer');
        if (video && !video.paused) {
            if (controlsHideTimeout) clearTimeout(controlsHideTimeout);
            controlsHideTimeout = setTimeout(() => {
                const wrapper = document.getElementById('playerVideoWrapper');
                if (wrapper && !isScrubbing) {
                    wrapper.classList.add('hide-controls');
                }
            }, 2600);
        }
    }

    function togglePlayerFullscreen() {
        const wrapper = document.getElementById('playerVideoWrapper') || document.getElementById('videoPlayer');
        if (!wrapper) return;
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else {
            if (wrapper.requestFullscreen) {
                wrapper.requestFullscreen().catch(() => {});
            } else if (wrapper.webkitRequestFullscreen) {
                wrapper.webkitRequestFullscreen().catch(() => {});
            }
        }
    }

    function onAudioChange(val) {
        currentActiveAudioIndex = (val !== '' && val !== null) ? parseInt(val, 10) : null;
        const video = document.getElementById('videoPlayer');
        const curPos = Math.round(currentStreamOffset + (video?.currentTime || 0));
        showToast("Piste audio modifiée : " + (currentActiveAudioIndex !== null ? 'Piste ' + (currentActiveAudioIndex + 1) : 'Automatique'));
        if (currentActiveMagnet) {
            const currentVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(currentActiveMagnet) + "&index=" + currentActiveFileIndex + "&play";
            startStreamingInPlayer(currentActiveMagnet, currentAnimeItem?.titre || 'Anime', currentVlcUrl, currentActiveFileIndex, curPos);
        }
    }

    // --- SYNCHRONISATION / DÉCALAGE AUDIO (ACCESSIBLE VIA BOUTONS ET RACCOURCIS J / K) ---
    let audioSyncDebounceTimeout = null;

    function adjustAudioSync(deltaSeconds) {
        if (typeof currentManualAudioOffset !== 'number') currentManualAudioOffset = 0.0;
        currentManualAudioOffset = Math.round((currentManualAudioOffset + deltaSeconds) * 10) / 10;
        updateAudioSyncDisplay();
        showToast(`🔊 Synchro audio : ${currentManualAudioOffset >= 0 ? '+' : ''}${currentManualAudioOffset.toFixed(1)}s`);

        if (!currentActiveMagnet) return;

        if (audioSyncDebounceTimeout) clearTimeout(audioSyncDebounceTimeout);
        audioSyncDebounceTimeout = setTimeout(() => {
            const video = document.getElementById('videoPlayer');
            const curPos = Math.max(0, Math.round(currentStreamOffset + (video?.currentTime || 0)));
            const currentVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(currentActiveMagnet) + "&index=" + currentActiveFileIndex + "&play";
            startStreamingInPlayer(currentActiveMagnet, currentAnimeItem?.titre || 'Anime', currentVlcUrl, currentActiveFileIndex, curPos);
        }, 400);
    }

    function resetAudioSync() {
        currentManualAudioOffset = 0.0;
        updateAudioSyncDisplay();
        showToast("🔊 Synchro audio réinitialisée (0.0s)");

        if (!currentActiveMagnet) return;

        if (audioSyncDebounceTimeout) clearTimeout(audioSyncDebounceTimeout);
        const video = document.getElementById('videoPlayer');
        const curPos = Math.max(0, Math.round(currentStreamOffset + (video?.currentTime || 0)));
        const currentVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(currentActiveMagnet) + "&index=" + currentActiveFileIndex + "&play";
        startStreamingInPlayer(currentActiveMagnet, currentAnimeItem?.titre || 'Anime', currentVlcUrl, currentActiveFileIndex, curPos);
    }

    function updateAudioSyncDisplay() {
        const display = document.getElementById('audioSyncDisplay');
        if (display) {
            const offset = (typeof currentManualAudioOffset === 'number') ? currentManualAudioOffset : 0.0;
            display.textContent = (offset >= 0 ? '+' : '') + offset.toFixed(1) + 's';
        }
    }

    window.adjustAudioSync = adjustAudioSync;
    window.resetAudioSync = resetAudioSync;
    window.updateAudioSyncDisplay = updateAudioSyncDisplay;

    // --- ANISKIP (DÉTECTION ET SAUT INTELLIGENT DE L'OPENING & ENDING) ---
    let currentAniSkipIntervals = null;
    let isAniSkipLoading = false;

    async function checkAniSkipForCurrentEpisode() {
        currentAniSkipIntervals = null;
        hideAniSkipButton();

        let malId = currentAnilistMedia?.idMal;
        const ep = currentDetectedEpisode || 1;
        const duration = currentTotalDuration || 1440;

        // Si pas encore d'idMal mais que l'on a le titre, tenter une résolution AniList
        if (!malId && currentAnimeItem) {
            const parsed = getAnimeDetails(currentAnimeItem);
            const name = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle;
            if (name && typeof callAnilistGraphQL === 'function') {
                try {
                    const query = `query ($search: String) { Media(search: $search, type: ANIME) { id idMal episodes } }`;
                    const data = await callAnilistGraphQL(query, { search: name });
                    if (data?.Media?.idMal) {
                        malId = data.Media.idMal;
                        if (currentAnilistMedia) {
                            currentAnilistMedia.idMal = malId;
                            if (!currentAnilistMedia.episodes) currentAnilistMedia.episodes = data.Media.episodes;
                        }
                    }
                } catch (e) {}
            }
        }

        if (!malId) return;

        try {
            isAniSkipLoading = true;
            const url = `https://api.aniskip.com/v2/skip-times/${malId}/${ep}?types[]=op&types[]=ed&episodeLength=${duration}`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = await res.json();
            if (data && data.found && Array.isArray(data.results)) {
                const intervals = {};
                data.results.forEach(r => {
                    if (r.skipType === 'op' && r.interval) {
                        intervals.op = {
                            startTime: Math.max(0, parseFloat(r.interval.startTime) || 0),
                            endTime: parseFloat(r.interval.endTime) || 0
                        };
                    } else if (r.skipType === 'ed' && r.interval) {
                        intervals.ed = {
                            startTime: Math.max(0, parseFloat(r.interval.startTime) || 0),
                            endTime: parseFloat(r.interval.endTime) || 0
                        };
                    }
                });
                currentAniSkipIntervals = intervals;
                console.log(`[AniSkip] Intervalles trouvés pour MAL ${malId} Ép. ${ep} :`, intervals);
            }
        } catch(err) {
            console.warn("[AniSkip] Erreur skip-times:", err.message);
        } finally {
            isAniSkipLoading = false;
        }
    }

    function updateAniSkipButton(effectiveTime) {
        const btn = document.getElementById('aniSkipOverlayBtn');
        if (!btn) return;

        if (!currentAniSkipIntervals) {
            btn.style.display = 'none';
            return;
        }

        const skipPref = localStorage.getItem('animflix_aniskip_mode') || 'button';
        if (skipPref === 'disabled') {
            btn.style.display = 'none';
            return;
        }

        const op = currentAniSkipIntervals.op;
        const ed = currentAniSkipIntervals.ed;

        if (op && effectiveTime >= op.startTime && effectiveTime < op.endTime) {
            if (skipPref === 'auto') {
                seekVideoTo(op.endTime, true);
                showToast("⏭️ Opening passé automatiquement (AniSkip)");
                return;
            }
            const remaining = Math.max(1, Math.round(op.endTime - effectiveTime));
            const textSpan = document.getElementById('aniSkipText');
            if (textSpan) textSpan.textContent = `Passer l'Opening (${remaining}s)`;
            btn.style.display = 'inline-flex';
            btn.onclick = () => {
                seekVideoTo(op.endTime, true);
                showToast("⏭️ Opening passé !");
            };
            return;
        }

        if (ed && effectiveTime >= ed.startTime && effectiveTime < ed.endTime) {
            if (skipPref === 'auto') {
                seekVideoTo(ed.endTime, true);
                showToast("⏭️ Ending passé automatiquement (AniSkip)");
                return;
            }
            const remaining = Math.max(1, Math.round(ed.endTime - effectiveTime));
            const textSpan = document.getElementById('aniSkipText');
            if (textSpan) textSpan.textContent = `Passer l'Ending (${remaining}s)`;
            btn.style.display = 'inline-flex';
            btn.onclick = () => {
                seekVideoTo(ed.endTime, true);
                showToast("⏭️ Ending passé !");
            };
            return;
        }

        btn.style.display = 'none';
    }

    function hideAniSkipButton() {
        const btn = document.getElementById('aniSkipOverlayBtn');
        if (btn) btn.style.display = 'none';
    }

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

    // --- PICTURE-IN-PICTURE (PIP) ---
    async function togglePictureInPicture() {
        const video = document.getElementById('videoPlayer');
        if (!video) return;
        try {
            if (document.pictureInPictureElement) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
                await video.requestPictureInPicture();
            } else {
                showToast("Picture-in-Picture non supporté sur ce navigateur");
            }
        } catch(err) {
            console.warn("Erreur PiP:", err);
        }
    }

    // --- VITESSE DE LECTURE (PLAYBACK SPEED) ---
    const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2, 0.75];
    let currentSpeedIndex = 0;

    function cyclePlaybackSpeed() {
        const video = document.getElementById('videoPlayer');
        if (!video) return;
        currentSpeedIndex = (currentSpeedIndex + 1) % PLAYBACK_SPEEDS.length;
        const newSpeed = PLAYBACK_SPEEDS[currentSpeedIndex];
        video.playbackRate = newSpeed;
        const label = document.getElementById('playerSpeedLabel');
        if (label) label.textContent = newSpeed + 'x';
        showToast(`⚡ Vitesse de lecture : ${newSpeed}x`);
    }

    // --- NORMALISATION AUDIO / BOOST DES VOIX (MODE NUIT) ---
    let audioCtx = null;
    let audioSourceNode = null;
    let audioCompressorNode = null;
    let isAudioNormalizationActive = false;

    function toggleAudioNormalization() {
        const video = document.getElementById('videoPlayer');
        if (!video) return;

        try {
            if (!audioCtx) {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) {
                    showToast("Web Audio API non supporté");
                    return;
                }
                audioCtx = new AudioContextClass();
                audioSourceNode = audioCtx.createMediaElementSource(video);
                audioCompressorNode = audioCtx.createDynamicsCompressor();

                // Paramètres optimisés : compresse les bruits forts et réhausse les chuchotements/voix
                audioCompressorNode.threshold.setValueAtTime(-24, audioCtx.currentTime);
                audioCompressorNode.knee.setValueAtTime(30, audioCtx.currentTime);
                audioCompressorNode.ratio.setValueAtTime(12, audioCtx.currentTime);
                audioCompressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
                audioCompressorNode.release.setValueAtTime(0.25, audioCtx.currentTime);

                audioSourceNode.connect(audioCtx.destination);
            }

            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            isAudioNormalizationActive = !isAudioNormalizationActive;
            audioSourceNode.disconnect();

            const btn = document.getElementById('audioNormalizeBtn');
            if (isAudioNormalizationActive) {
                audioSourceNode.connect(audioCompressorNode);
                audioCompressorNode.connect(audioCtx.destination);
                if (btn) btn.classList.add('active');
                showToast("🎙️ Boost des dialogues & Mode Nuit activé");
            } else {
                audioSourceNode.connect(audioCtx.destination);
                if (btn) btn.classList.remove('active');
                showToast("🎙️ Audio standard restauré");
            }
        } catch(err) {
            console.warn("Erreur Audio Normalization:", err);
            showToast("⚠️ Impossible d'activer le boost audio sur ce flux");
        }
    }

    window.togglePictureInPicture = togglePictureInPicture;
    window.cyclePlaybackSpeed = cyclePlaybackSpeed;
    window.toggleAudioNormalization = toggleAudioNormalization;
    window.playNextEpisodeNow = playNextEpisodeNow;
    window.dismissNextEpisodeCountdown = dismissNextEpisodeCountdown;
    window.checkAniSkipForCurrentEpisode = checkAniSkipForCurrentEpisode;

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

    // --- LECTEUR VIDÉO ET STREAMING ---
    async function startStreamingInPlayer(magnet, titre, vlcUrl, fileIndex = null, seekSeconds = 0) {
        currentActiveMagnet = magnet;
        if (fileIndex !== null) {
            currentActiveFileIndex = fileIndex;
        }
        currentStreamOffset = seekSeconds;
        hasAutoTrackedCurrentEpisode = false;
        hasNextEpisodeTriggered = false;
        dismissNextEpisodeCountdown();
        checkAniSkipForCurrentEpisode();
        updatePlayerTrackButton();

        if (seekSeconds > 0 && typeof dismissResumeBanner === 'function') {
            dismissResumeBanner(false);
        }

        // Afficher le badge épisode dans le lecteur overlay
        const epBadge = document.getElementById('playerOverlayEpBadge');
        if (epBadge) {
            const curEp = currentDetectedEpisode || (currentAnimeItem ? parseAnimeDetails(currentAnimeItem.titre).episode : null);
            if (curEp) {
                epBadge.innerText = typeof curEp === 'number' ? `Ép. ${curEp}` : curEp;
                epBadge.style.display = 'inline-block';
            } else {
                epBadge.style.display = 'none';
            }
        }

        // Rafraîchissement immédiat de l'affichage de progression
        updatePlayerProgress();

        const streamMode = document.getElementById('detailStreamMode') ? document.getElementById('detailStreamMode').value : 'direct';
        const type = document.getElementById('searchType').value || 'vostfr';
        const video = document.getElementById('videoPlayer');
        const playerStatus = document.getElementById('player-status');
        const statusText = document.getElementById('status-text');
        playerStatus.style.display = 'block';
        statusText.innerText = seekSeconds > 0 
            ? `Reprise à ${formatTimestamp(seekSeconds)}... ⏳`
            : "Connexion à TorrServer & chargement du flux... ⏳";

        const playId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        currentPlaySessionId = playId;

        const clientId = window._animflixClientId || (window._animflixClientId = 'c_' + Math.random().toString(36).slice(2, 10));

        let webUrl = '/play?magnet=' + encodeURIComponent(magnet) + 
                     '&mode=' + encodeURIComponent(streamMode) + 
                     '&type=' + encodeURIComponent(type) +
                     '&fileIndex=' + encodeURIComponent(currentActiveFileIndex) +
                     '&playId=' + encodeURIComponent(playId) +
                     '&clientId=' + encodeURIComponent(clientId);

        if (currentActiveAudioIndex !== null && currentActiveAudioIndex !== '') {
            webUrl += '&audioIndex=' + encodeURIComponent(currentActiveAudioIndex);
        }
        if (typeof currentManualAudioOffset === 'number' && currentManualAudioOffset !== 0) {
            webUrl += '&audioOffset=' + encodeURIComponent(currentManualAudioOffset);
        }
        if (seekSeconds > 0) {
            webUrl += '&ss=' + encodeURIComponent(seekSeconds);
        }

        video.src = webUrl;

        setupSubtitles(magnet, type, currentActiveFileIndex, seekSeconds);

        // Synchronisation directe avec le point clé exact (Keyframe) détecté par le serveur
        fetch('/api/play-sync?playId=' + encodeURIComponent(playId))
            .then(res => res.json())
            .then(data => {
                if (currentPlaySessionId === playId && data && data.resolved && typeof data.actualStart === 'number') {
                    console.log(`🎯 Synchro appliquée pour ${playId}: Seek demandé=${seekSeconds}s -> Keyframe réel=${data.actualStart}s (Décalage=${data.keyframeOffset}s)`);
                    currentStreamOffset = data.actualStart;
                    updatePlayerProgress();
                    if (typeof updateSubtitleOffset === 'function') {
                        updateSubtitleOffset(data.actualStart);
                    }
                }
            })
            .catch(() => {});

        video.onplaying = () => {
            if (streamTimeout) clearTimeout(streamTimeout);
            playerStatus.style.display = 'none';
            const playIcon = document.getElementById('customPlayIcon');
            if (playIcon) playIcon.textContent = '❚❚';
            resetControlsTimer();
            if (typeof applySubtitleCuesToTrack === 'function') {
                applySubtitleCuesToTrack(currentStreamOffset);
            }
            // Appliquer la vitesse de lecture préférée
            const prefSpeed = parseFloat(localStorage.getItem('animflix_default_speed'));
            if (!isNaN(prefSpeed) && prefSpeed > 0 && video.playbackRate !== prefSpeed) {
                video.playbackRate = prefSpeed;
                const label = document.getElementById('playerSpeedLabel');
                if (label) label.textContent = prefSpeed + 'x';
            }
            // Appliquer le boost des voix si configuré par défaut
            const prefVoice = localStorage.getItem('animflix_default_voice_boost');
            if (prefVoice === 'enabled' && !isAudioNormalizationActive && typeof toggleAudioNormalization === 'function') {
                toggleAudioNormalization();
            }
        };

        video.oncanplay = () => {
            if (streamTimeout) clearTimeout(streamTimeout);
            playerStatus.style.display = 'none';
            const playIcon = document.getElementById('customPlayIcon');
            if (playIcon) playIcon.textContent = '❚❚';
            video.play().catch(() => {});
            if (typeof applySubtitleCuesToTrack === 'function') {
                applySubtitleCuesToTrack(currentStreamOffset);
            }
        };

        video.onpause = () => {
            const playIcon = document.getElementById('customPlayIcon');
            if (playIcon) playIcon.textContent = '▶';
            showControls();
            if (typeof savePlaybackProgress === 'function') {
                savePlaybackProgress(true);
            }
        };

        video.onended = () => {
            if (typeof markCurrentPlaybackCompleted === 'function') {
                markCurrentPlaybackCompleted();
            }
            if (typeof triggerNextEpisodeOverlay === 'function') {
                triggerNextEpisodeOverlay(true);
            }
        };

        if (streamTimeout) clearTimeout(streamTimeout);
        streamTimeout = setTimeout(() => {
            if (playerStatus.style.display !== 'none') {
                statusText.innerHTML = "⏳ Le flux torrent met du temps à démarrer...<br><span style='font-size:13px; color:#ffa033;'>Cliquez sur <b>Ouvrir dans VLC</b> ci-dessous pour une lecture immédiate et fluide !</span>";
            }
        }, 7000);

        video.onerror = () => {
            if (streamTimeout) clearTimeout(streamTimeout);
            statusText.innerHTML = "⚠️ Le navigateur ne peut pas lire ce format directement.<br><span style='font-size:13px; color:#ffa033;'>Utilisez le bouton ci-dessous pour le regarder dans <b>VLC</b> !</span>";
        };
    }


    // Initialisation du lecteur vidéo et de sa barre interactive
    function initCustomPlayerControls() {
        const video = document.getElementById('videoPlayer');
        const wrapper = document.getElementById('playerVideoWrapper');
        const scrubberContainer = document.getElementById('playerScrubberContainer');
        const scrubberTrack = document.getElementById('playerScrubberTrack');
        const scrubberProgress = document.getElementById('playerScrubberProgress');
        const scrubberTooltip = document.getElementById('playerScrubberTooltip');
        const playIcon = document.getElementById('customPlayIcon');
        const volumeSlider = document.getElementById('customVolumeSlider');

        if (!video || !wrapper) return;

        // 1. Progression continue et affichage
        video.addEventListener('timeupdate', updatePlayerProgress);

        // 2. Événements Play / Pause
        video.addEventListener('play', () => {
            if (playIcon) playIcon.textContent = '❚❚';
            resetControlsTimer();
        });
        video.addEventListener('pause', () => {
            if (playIcon) playIcon.textContent = '▶';
            showControls();
        });

        // 3. Clic / Double-clic sur la vidéo (Play/Pause et Plein écran)
        let clickTimeout = null;
        video.addEventListener('click', (e) => {
            e.stopPropagation();
            if (clickTimeout) {
                clearTimeout(clickTimeout);
                clickTimeout = null;
                togglePlayerFullscreen();
            } else {
                clickTimeout = setTimeout(() => {
                    clickTimeout = null;
                    toggleCustomPlayPause();
                }, 220);
            }
        });

        // 4. Disparition auto des contrôles
        wrapper.addEventListener('mousemove', resetControlsTimer);
        wrapper.addEventListener('touchstart', resetControlsTimer, { passive: true });
        wrapper.addEventListener('mouseleave', () => {
            if (!video.paused && !isScrubbing) {
                wrapper.classList.add('hide-controls');
            }
        });

        // 5. Timeline Scrubber interactif (clic et glisser-déposer fluide)
        if (scrubberContainer && scrubberTrack) {
            function getRatio(e) {
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                const rect = scrubberTrack.getBoundingClientRect();
                return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            }

            function updateScrubVisual(ratio) {
                const pct = ratio * 100;
                if (scrubberProgress) scrubberProgress.style.width = pct + '%';
                const targetSec = Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440));
                const curLabel = document.getElementById('playerDisplayCurrent');
                if (curLabel) curLabel.textContent = formatTimestamp(targetSec);
            }

            function updateTooltip(e) {
                if (!scrubberTooltip) return;
                const clientX = e.touches ? e.touches[0].clientX : e.clientX;
                const rect = scrubberTrack.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
                const hoverSec = Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440));
                scrubberTooltip.textContent = formatTimestamp(hoverSec);
                const offsetLeft = Math.max(20, Math.min(rect.width - 20, clientX - rect.left));
                scrubberTooltip.style.left = offsetLeft + 'px';
                scrubberTooltip.style.display = 'block';
            }

            scrubberContainer.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                isScrubbing = true;
                scrubberContainer.classList.add('scrubbing');
                const ratio = getRatio(e);
                updateScrubVisual(ratio);
                updateTooltip(e);
            });

            scrubberContainer.addEventListener('mousemove', (e) => {
                if (!isScrubbing) {
                    updateTooltip(e);
                }
            });

            scrubberContainer.addEventListener('mouseleave', () => {
                if (!isScrubbing && scrubberTooltip) {
                    scrubberTooltip.style.display = 'none';
                }
            });

            window.addEventListener('mousemove', (e) => {
                if (isScrubbing) {
                    resetControlsTimer();
                    const ratio = getRatio(e);
                    updateScrubVisual(ratio);
                    updateTooltip(e);
                }
            });

            window.addEventListener('mouseup', (e) => {
                if (isScrubbing) {
                    isScrubbing = false;
                    scrubberContainer.classList.remove('scrubbing');
                    if (scrubberTooltip) scrubberTooltip.style.display = 'none';
                    const ratio = getRatio(e);
                    const targetSec = Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440));
                    seekVideoTo(targetSec);
                }
            });

            // Touch events pour tablettes et mobiles
            scrubberContainer.addEventListener('touchstart', (e) => {
                isScrubbing = true;
                scrubberContainer.classList.add('scrubbing');
                const ratio = getRatio(e);
                updateScrubVisual(ratio);
                updateTooltip(e);
            }, { passive: true });

            window.addEventListener('touchmove', (e) => {
                if (isScrubbing) {
                    resetControlsTimer();
                    const ratio = getRatio(e);
                    updateScrubVisual(ratio);
                    updateTooltip(e);
                }
            }, { passive: true });

            window.addEventListener('touchend', (e) => {
                if (isScrubbing) {
                    isScrubbing = false;
                    scrubberContainer.classList.remove('scrubbing');
                    if (scrubberTooltip) scrubberTooltip.style.display = 'none';
                    if (e.changedTouches && e.changedTouches[0]) {
                        const rect = scrubberTrack.getBoundingClientRect();
                        const ratio = Math.max(0, Math.min(1, (e.changedTouches[0].clientX - rect.left) / rect.width));
                        seekVideoTo(Math.round(ratio * (currentTotalDuration > 0 ? currentTotalDuration : 1440)));
                    }
                }
            });
        }

        if (volumeSlider) {
            volumeSlider.value = video.volume;
        }
    }


    // Gestion des raccourcis clavier
    window.addEventListener('keydown', (e) => {
        const anilistBadge = document.getElementById('anilistUserBadge');
        if (e.key === 'Escape' && anilistBadge && anilistBadge.classList.contains('active')) {
            anilistBadge.classList.remove('active');
            return;
        }

        const detailView = document.getElementById('detailView');
        const isDetailActive = detailView && detailView.style.display === 'block';

        if (e.key === 'Escape') {
            const settingsModal = document.getElementById('settingsModal');
            if (settingsModal && settingsModal.style.display === 'flex') {
                if (typeof closeSettingsModal === 'function') closeSettingsModal();
                return;
            }
            const menu = document.getElementById('subStyleMenu');
            if (menu && menu.style.display === 'block') {
                menu.style.display = 'none';
                return;
            }
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
                return;
            }
            if (isDetailActive) {
                closeDetailView();
            }
            return;
        }

        if (!isDetailActive) return;

        const video = document.getElementById('videoPlayer');
        if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            toggleCustomPlayPause();
        } else if (e.key.toLowerCase() === 'c' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            toggleSubtitles();
        } else if (e.key.toLowerCase() === 's' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            toggleSubStyleMenu();
        } else if (e.key.toLowerCase() === 'g' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            if (typeof adjustSubtitleSync === 'function') adjustSubtitleSync(-0.1);
        } else if (e.key.toLowerCase() === 'h' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            if (typeof adjustSubtitleSync === 'function') adjustSubtitleSync(0.1);
        } else if (e.key.toLowerCase() === 'j' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            if (typeof adjustAudioSync === 'function') adjustAudioSync(-0.1);
        } else if (e.key.toLowerCase() === 'k' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            if (typeof adjustAudioSync === 'function') adjustAudioSync(0.1);
        } else if (e.key === 'ArrowRight' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            jumpSeekRelative(10);
        } else if (e.key === 'ArrowLeft' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            jumpSeekRelative(-10);
        } else if (e.key === 'ArrowUp' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            if (video) {
                video.volume = Math.min(1, Math.round((video.volume + 0.05) * 100) / 100);
                video.muted = false;
                updateVolumeIcon();
                showToast(`Volume : ${Math.round(video.volume * 100)}%`);
            }
        } else if (e.key === 'ArrowDown' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'INPUT') {
            e.preventDefault();
            if (video) {
                video.volume = Math.max(0, Math.round((video.volume - 0.05) * 100) / 100);
                updateVolumeIcon();
                showToast(`Volume : ${Math.round(video.volume * 100)}%`);
            }
        } else if (e.key.toLowerCase() === 'm' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            toggleCustomMute();
        } else if (e.key.toLowerCase() === 'f' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            togglePlayerFullscreen();
        } else if (e.key.toLowerCase() === 'p' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            togglePictureInPicture();
        } else if (e.key.toLowerCase() === 'n' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            toggleAudioNormalization();
        } else if ((e.key === '>' || e.key === ']' || e.key === '<' || e.key === '[') && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
            e.preventDefault();
            cyclePlaybackSpeed();
        }
    });

    window.addEventListener('beforeunload', () => {
        if (typeof savePlaybackProgress === 'function') {
            savePlaybackProgress(true);
        }
    });

