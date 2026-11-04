// =========================================================================
// --- ANIMFLIX MEDIA PLAYER (CUSTOM CONTROLS, TIMELINE, SHORTCUTS) ---
// =========================================================================

    // Identifiant unique et persistant du client pour une isolation stricte des sessions multi-écrans
    function getOrCreateClientId() {
        let id = null;
        try {
            id = localStorage.getItem('animflix_client_id');
        } catch (e) {}
        if (!id || !/^[a-zA-Z0-9_\-]{4,64}$/.test(id)) {
            id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
            try {
                localStorage.setItem('animflix_client_id', id);
            } catch (e) {}
        }
        window._animflixClientId = id;
        return id;
    }
    window.getOrCreateClientId = getOrCreateClientId;

    function updatePlayerProgress(overrideTime = null) {
        const video = document.getElementById('videoPlayer');
        if (!video) return;
        // Pendant le debounce d'un saut, afficher la cible demandée plutôt que la position de l'ancien flux
        const effectiveTime = (typeof overrideTime === 'number')
            ? overrideTime
            : (typeof pendingSeekTarget === 'number'
                ? pendingSeekTarget
                : Math.max(0, currentStreamOffset + (video.currentTime || 0)));
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

        // Mise à jour de la mémoire tampon (buffer) avec affichage précis de la tranche chargée
        if (video.buffered && video.buffered.length > 0 && totalDur > 0) {
            try {
                const bufStart = video.buffered.start(0);
                const bufEnd = video.buffered.end(video.buffered.length - 1);
                const startSec = Math.max(0, currentStreamOffset + bufStart);
                const endSec = Math.max(0, currentStreamOffset + bufEnd);
                const startPct = Math.min(100, Math.max(0, (startSec / totalDur) * 100));
                const endPct = Math.min(100, Math.max(0, (endSec / totalDur) * 100));
                const bufEl = document.getElementById('playerScrubberBuffered');
                if (bufEl) {
                    bufEl.style.left = startPct + '%';
                    bufEl.style.width = Math.max(0, endPct - startPct) + '%';
                }
            } catch (e) {}
        }

        // Sauvegarde automatique et périodique de la progression dans l'historique local
        if (!isScrubbing && typeof savePlaybackProgress === 'function') {
            savePlaybackProgress();
        }

        // Vérification dynamique AniSkip (Opening / Ending)
        if (!isScrubbing && typeof updateAniSkipButton === 'function') {
            updateAniSkipButton(effectiveTime);
        }

        // Vérification de fin d'épisode pour l'enchaînement automatique (Binge-Watching)
        if (!isScrubbing && typeof checkAutoPlayNextEpisode === 'function') {
            checkAutoPlayNextEpisode(effectiveTime, totalDur);
        }

        // Synchronisation de la position MediaSession (écran de verrouillage / casque Bluetooth)
        if (typeof updateMediaSessionPositionState === 'function') {
            updateMediaSessionPositionState();
        }
    }

    let seekDebounceTimeout = null;
    // Cible d'un saut en attente (debounce) : permet d'additionner les appuis rapides (+10s x3 = +30s)
    let pendingSeekTarget = null;
    function seekVideoTo(targetSeconds, immediate = false) {
        if (!currentActiveMagnet) return;
        if (typeof dismissResumeBanner === 'function') {
            dismissResumeBanner(false);
        }
        const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;
        const target = Math.max(0, Math.min(totalDur, Math.round(targetSeconds)));

        // Masquer immédiatement le bouton AniSkip si la cible de saut est hors de l'opening
        if (!currentAniSkipIntervals?.op || target >= currentAniSkipIntervals.op.endTime) {
            hideAniSkipButton();
        }

        // ⚡ SEEK INSTANTANÉ EN MÉMOIRE TAMPON (0ms In-Buffer Seek sans relancer FFmpeg)
        const video = document.getElementById('videoPlayer');
        if (video && video.readyState >= 1 && video.buffered && video.buffered.length > 0) {
            const relTarget = target - currentStreamOffset;
            if (relTarget >= 0) {
                let isBuffered = false;
                for (let i = 0; i < video.buffered.length; i++) {
                    try {
                        const startB = video.buffered.start(i);
                        const endB = video.buffered.end(i);
                        if (relTarget >= Math.max(0, startB - 0.25) && relTarget <= (endB - 0.35)) {
                            isBuffered = true;
                            break;
                        }
                    } catch (e) {}
                }
                if (isBuffered) {
                    if (seekDebounceTimeout) {
                        clearTimeout(seekDebounceTimeout);
                        seekDebounceTimeout = null;
                    }
                    pendingSeekTarget = null;
                    try {
                        video.currentTime = relTarget;
                        updatePlayerProgress();
                        if (typeof updateMediaSessionPositionState === 'function') {
                            updateMediaSessionPositionState(true);
                        }
                        return;
                    } catch (e) {}
                }
            }
        }
        
        // Rafraîchissement visuel immédiat de la timeline vers la cible demandée
        pendingSeekTarget = target;
        updatePlayerProgress(target);
        if (typeof updateMediaSessionPositionState === 'function') {
            updateMediaSessionPositionState(true);
        }

        if (seekDebounceTimeout) {
            clearTimeout(seekDebounceTimeout);
            seekDebounceTimeout = null;
        }

        const executeSeek = () => {
            seekDebounceTimeout = null;
            pendingSeekTarget = null;
            currentStreamOffset = target;
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
        const currentPos = (typeof pendingSeekTarget === 'number')
            ? pendingSeekTarget
            : currentStreamOffset + (video.currentTime || 0);
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

    function resetControlsTimer(delay = 4500) {
        showControls();
        const video = document.getElementById('videoPlayer');
        if (video && !video.paused) {
            if (controlsHideTimeout) clearTimeout(controlsHideTimeout);
            controlsHideTimeout = setTimeout(() => {
                const wrapper = document.getElementById('playerVideoWrapper');
                if (wrapper && !isScrubbing) {
                    wrapper.classList.add('hide-controls');
                }
            }, delay);
        }
    }

    function togglePlayerFullscreen() {
        const wrapper = document.getElementById('playerVideoWrapper') || document.getElementById('videoPlayer');
        if (!wrapper) return;
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
        if (isFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen().catch(() => {});
            } else if (document.mozCancelFullScreen) {
                document.mozCancelFullScreen().catch(() => {});
            }
            if (screen.orientation && screen.orientation.unlock) {
                try { screen.orientation.unlock(); } catch (e) {}
            }
        } else {
            const req = wrapper.requestFullscreen 
                ? wrapper.requestFullscreen() 
                : (wrapper.webkitRequestFullscreen 
                    ? wrapper.webkitRequestFullscreen() 
                    : (wrapper.mozRequestFullScreen ? wrapper.mozRequestFullScreen() : null));

            if (req && req.then) {
                req.then(() => {
                    if (screen.orientation && screen.orientation.lock) {
                        screen.orientation.lock('landscape').catch(() => {});
                    }
                }).catch(() => {});
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

