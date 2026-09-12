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
    }

    function seekVideoTo(targetSeconds) {
        if (!currentActiveMagnet) return;
        const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;
        const target = Math.max(0, Math.min(totalDur, Math.round(targetSeconds)));
        
        currentStreamOffset = target;
        updatePlayerProgress();

        const currentVlcUrl = "http://" + TORR_HOST + ":8090/stream?link=" + encodeURIComponent(currentActiveMagnet) + "&index=" + currentActiveFileIndex + "&play";
        startStreamingInPlayer(currentActiveMagnet, currentAnimeItem?.titre || 'Anime', currentVlcUrl, currentActiveFileIndex, target);
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
        updatePlayerTrackButton();

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

        let webUrl = '/play?magnet=' + encodeURIComponent(magnet) + 
                     '&mode=' + encodeURIComponent(streamMode) + 
                     '&type=' + encodeURIComponent(type) +
                     '&fileIndex=' + encodeURIComponent(currentActiveFileIndex) +
                     '&playId=' + encodeURIComponent(playId);

        if (currentActiveAudioIndex !== null && currentActiveAudioIndex !== '') {
            webUrl += '&audioIndex=' + encodeURIComponent(currentActiveAudioIndex);
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
        }
    });
