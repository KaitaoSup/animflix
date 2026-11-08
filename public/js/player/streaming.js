    // --- GESTION DU MOTEUR HLS ADAPTATIF (.M3U8 / HLS.JS & NATIF IOS/TV) ---
    let currentHlsInstance = null;
    let lastAutoFallbackKey = null;

    function destroyCurrentHlsInstance(notifyServer = false) {
        if (currentHlsInstance) {
            try {
                currentHlsInstance.destroy();
            } catch (e) {}
            currentHlsInstance = null;
        }
        if (notifyServer) {
            const clientId = getOrCreateClientId();
            if (clientId) {
                fetch('/api/hls/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ clientId })
                }).catch(() => {});
            }
        }
    }
    window.destroyCurrentHlsInstance = destroyCurrentHlsInstance;

    /**
     * Plage (secondes, relative au début du flux en cours) que FFmpeg a déjà générée dans la session HLS.
     * Un saut dans cette plage se fait sans relancer FFmpeg : les segments sont déjà sur le serveur.
     * Retourne null hors HLS ou si la playlist n'est pas encore connue.
     */
    function getHlsGeneratedRange() {
        if (currentHlsInstance) {
            const levels = currentHlsInstance.levels || [];
            const level = levels[currentHlsInstance.currentLevel] || levels[0];
            const frags = level && level.details && level.details.fragments;
            if (!frags || frags.length === 0) return null;
            const last = frags[frags.length - 1];
            return { start: frags[0].start, end: last.start + last.duration };
        }
        // HLS natif (Safari / iOS) : la plage navigable couvre toute la playlist EVENT
        const video = document.getElementById('videoPlayer');
        if (video && typeof video.src === 'string' && video.src.includes('/api/hls/') &&
            video.seekable && video.seekable.length > 0) {
            return { start: video.seekable.start(0), end: video.seekable.end(video.seekable.length - 1) };
        }
        return null;
    }
    window.getHlsGeneratedRange = getHlsGeneratedRange;

    // --- SERVEUR SATURÉ (HTTP 503 : limite de lectures simultanées atteinte) ---
    // Une <video> ne donne pas le code HTTP de son échec : on interroge /api/streams/capacity pour savoir
    // si le refus vient de la saturation, plutôt que d'annoncer à tort un format illisible.
    const STREAM_CAPACITY_RETRY_MS = 10000;
    const STREAM_CAPACITY_MAX_RETRIES = 6; // 1 minute d'essais automatiques
    let streamCapacityRetry = { key: null, count: 0, timer: null, retryFn: null };

    async function fetchStreamCapacity() {
        try {
            const res = await fetch('/api/streams/capacity', { cache: 'no-store' });
            return res.ok ? await res.json() : null;
        } catch (e) {
            return null;
        }
    }

    function resetStreamCapacityRetry() {
        clearTimeout(streamCapacityRetry.timer);
        streamCapacityRetry = { key: null, count: 0, timer: null, retryFn: null };
    }

    function retryStreamNow() {
        const fn = streamCapacityRetry.retryFn;
        clearTimeout(streamCapacityRetry.timer);
        streamCapacityRetry.timer = null;
        if (typeof fn === 'function') fn();
    }
    window.retryStreamNow = retryStreamNow;

    /**
     * Si l'échec de lecture vient de la saturation du serveur : affiche le message et programme un nouvel
     * essai. Retourne false si le serveur n'est pas saturé (autre cause d'erreur).
     */
    async function handleStreamCapacityError(playId, retryFn) {
        const cap = await fetchStreamCapacity();
        if (!cap || !cap.full || currentPlaySessionId !== playId) return false;

        const playerStatus = document.getElementById('player-status');
        const statusText = document.getElementById('status-text');
        const key = `${currentActiveMagnet}_${currentActiveFileIndex}`;
        if (streamCapacityRetry.key !== key) {
            resetStreamCapacityRetry();
            streamCapacityRetry.key = key;
        }
        clearTimeout(streamCapacityRetry.timer);
        streamCapacityRetry.retryFn = retryFn;
        if (playerStatus) playerStatus.style.display = 'block';

        const retryButton = `<button class="btn-secondary" style="margin-top:10px;" onclick="retryStreamNow()">↻ Réessayer maintenant</button>`;
        if (streamCapacityRetry.count >= STREAM_CAPACITY_MAX_RETRIES) {
            if (statusText) {
                statusText.innerHTML = `⛔ Le serveur est occupé : ${cap.active} lecture(s) en cours sur ${cap.max} possibles.` +
                    `<br><span style='font-size:13px; color:#ffa033;'>Arrêtez une lecture sur un autre appareil, puis réessayez.</span><br>${retryButton}`;
            }
            return true;
        }

        streamCapacityRetry.count++;
        if (statusText) {
            statusText.innerHTML = `⛔ Le serveur est occupé : ${cap.active} lecture(s) en cours sur ${cap.max} possibles.` +
                `<br><span style='font-size:13px; color:#ffa033;'>Nouvel essai automatique dans ${STREAM_CAPACITY_RETRY_MS / 1000} s ` +
                `(${streamCapacityRetry.count}/${STREAM_CAPACITY_MAX_RETRIES})…</span><br>${retryButton}`;
        }
        streamCapacityRetry.timer = setTimeout(() => {
            streamCapacityRetry.timer = null;
            // L'utilisateur a lancé autre chose entre-temps : ne pas relancer l'ancien épisode
            if (currentPlaySessionId === playId) retryFn();
        }, STREAM_CAPACITY_RETRY_MS);
        return true;
    }

    // --- LECTEUR VIDÉO ET STREAMING ---
    async function startStreamingInPlayer(magnet, titre, vlcUrl, fileIndex = null, seekSeconds = 0) {
        currentActiveMagnet = magnet;
        if (fileIndex !== null) {
            currentActiveFileIndex = fileIndex;
        }
        currentStreamOffset = seekSeconds;
        if (seekDebounceTimeout) {
            clearTimeout(seekDebounceTimeout);
            seekDebounceTimeout = null;
        }
        pendingSeekTarget = null;
        hasAutoTrackedCurrentEpisode = false;
        hasNextEpisodeTriggered = false;
        dismissNextEpisodeCountdown();

        // Cacher immédiatement le bouton AniSkip si la lecture reprend hors de l'opening
        if (!currentAniSkipIntervals?.op || seekSeconds >= currentAniSkipIntervals.op.endTime) {
            hideAniSkipButton();
        }

        const epKey = `${magnet}_${currentActiveFileIndex}`;
        const isNewEp = (window._currentPlayingEpisodeKey !== epKey);
        window._currentPlayingEpisodeKey = epKey;

        if (isNewEp) {
            hasSkippedCurrentOp = false;
            hasSkippedCurrentEd = false;
            currentAniSkipIntervals = null;
            window.currentAniSkipIntervals = null;
            aniSkipLoadedFor = null;
            checkAniSkipForCurrentEpisode();
        } else if (seekSeconds === 0) {
            hasSkippedCurrentOp = false;
            hasSkippedCurrentEd = false;
        } else if (aniSkipNeedsRefresh()) {
            checkAniSkipForCurrentEpisode();
        }

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

        // Mise à jour du badge moteur en haut du lecteur
        const engineBadge = document.getElementById('playerEngineBadge');
        if (engineBadge) {
            engineBadge.classList.remove('hls', 'transcode');
            if (streamMode === 'hls') {
                engineBadge.textContent = 'HLS .m3u8';
                engineBadge.classList.add('hls');
            } else if (streamMode === 'transcode') {
                engineBadge.textContent = 'Transcode H.264';
                engineBadge.classList.add('transcode');
            } else {
                engineBadge.textContent = 'Direct MP4';
            }
        }

        playerStatus.style.display = 'block';
        statusText.innerText = seekSeconds > 0 
            ? `Reprise à ${formatTimestamp(seekSeconds)}... ⏳`
            : (streamMode === 'hls'
                ? "Initialisation du flux HLS Adaptatif (.m3u8)... 📡"
                : "Connexion à TorrServer & chargement du flux... ⏳");

        // Démarrage du monitoring P2P en temps réel
        startTorrServerP2pPolling(magnet);

        // Nettoyage d'une éventuelle instance HLS précédente
        destroyCurrentHlsInstance(false);

        const playId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        currentPlaySessionId = playId;

        const clientId = getOrCreateClientId();

        if (streamMode === 'hls') {
            let hlsUrl = `/api/hls/${encodeURIComponent(playId)}/index.m3u8?magnet=` + encodeURIComponent(magnet) +
                         `&fileIndex=` + encodeURIComponent(currentActiveFileIndex) +
                         `&clientId=` + encodeURIComponent(clientId);

            if (currentActiveAudioIndex !== null && currentActiveAudioIndex !== '') {
                hlsUrl += '&audioIndex=' + encodeURIComponent(currentActiveAudioIndex);
            }
            if (typeof currentManualAudioOffset === 'number' && currentManualAudioOffset !== 0) {
                hlsUrl += '&audioOffset=' + encodeURIComponent(currentManualAudioOffset);
            }
            if (seekSeconds > 0) {
                hlsUrl += '&ss=' + encodeURIComponent(seekSeconds);
            }

            if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                const hls = new Hls({
                    maxBufferLength: 60,
                    maxMaxBufferLength: 180,
                    backBufferLength: 90,
                    enableWorker: true,
                    lowLatencyMode: false,
                    manifestLoadingTimeOut: 25000,
                    manifestLoadingMaxRetry: 4,
                    levelLoadingTimeOut: 25000,
                    fragLoadingTimeOut: 25000
                });
                currentHlsInstance = hls;
                hls.loadSource(hlsUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    video.play().catch(() => {});
                });
                hls.on(Hls.Events.ERROR, (event, data) => {
                    // 503 : serveur saturé. Inutile de laisser hls.js réessayer en boucle
                    if (data && data.response && data.response.code === 503) {
                        if (streamTimeout) clearTimeout(streamTimeout);
                        destroyCurrentHlsInstance(false);
                        handleStreamCapacityError(playId, () => startStreamingInPlayer(magnet, titre, vlcUrl, currentActiveFileIndex, currentStreamOffset))
                            .then(handled => {
                                if (!handled && currentPlaySessionId === playId) {
                                    statusText.innerHTML = "⚠️ Le serveur a refusé le flux HLS. Réessayez dans un instant.";
                                }
                            });
                        return;
                    }
                    // 404 : la session HLS n'existe plus côté serveur (supprimée après 2 min sans requête,
                    // typiquement une longue pause). Relancer le flux à la position actuelle au lieu de
                    // laisser hls.js réessayer indéfiniment une session disparue.
                    if (data && data.fatal && data.response && data.response.code === 404 &&
                        currentPlaySessionId === playId) {
                        const resumeAt = Math.max(0, Math.floor(currentStreamOffset + (video.currentTime || 0)));
                        console.warn(`📡 Session HLS ${playId} expirée côté serveur : reprise à ${resumeAt}s`);
                        destroyCurrentHlsInstance(false);
                        startStreamingInPlayer(magnet, titre, vlcUrl, currentActiveFileIndex, resumeAt);
                        return;
                    }
                    if (data && data.fatal) {
                        switch (data.type) {
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                hls.startLoad();
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                hls.recoverMediaError();
                                break;
                            default:
                                destroyCurrentHlsInstance(false);
                                break;
                        }
                    }
                });
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // Support natif iOS / iPadOS / Safari / Apple TV AirPlay
                video.src = hlsUrl;
                video.addEventListener('loadedmetadata', () => {
                    video.play().catch(() => {});
                }, { once: true });
            } else {
                showToast("⚠️ HLS non supporté sur ce navigateur, bascule en Transcodage MP4");
                const detailSel = document.getElementById('detailStreamMode');
                if (detailSel) detailSel.value = 'transcode';
                return startStreamingInPlayer(magnet, titre, vlcUrl, currentActiveFileIndex, seekSeconds);
            }
        } else {
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
        }

        setupSubtitles(magnet, type, currentActiveFileIndex, seekSeconds);

        // Synchronisation directe avec le point clé exact (Keyframe) détecté par le serveur
        // Le serveur répond au plus tard après 5 s : réessayer tant que la mesure n'est pas prête
        // (en HLS, elle dépend d'une lecture du torrent qui peut être plus lente au démarrage)
        const syncPlaySession = (attempt = 0) => {
            fetch('/api/play-sync?playId=' + encodeURIComponent(playId) + '&expectedSeek=' + encodeURIComponent(seekSeconds))
                .then(res => res.json())
                .then(data => {
                    if (currentPlaySessionId !== playId || !data) return;
                    if (!data.resolved) {
                        if (attempt < 5) syncPlaySession(attempt + 1);
                        return;
                    }
                    if (typeof data.actualStart === 'number') {
                        console.log(`🎯 Synchro appliquée pour ${playId}: Seek demandé=${seekSeconds}s -> Keyframe réel=${data.actualStart}s (Décalage=${data.keyframeOffset}s)`);
                        currentStreamOffset = data.actualStart;
                        updatePlayerProgress();
                        if (typeof updateSubtitleOffset === 'function') {
                            updateSubtitleOffset(data.actualStart);
                        }
                    }
                })
                .catch(() => {});
        };
        syncPlaySession();

        video.onplaying = () => {
            if (streamTimeout) clearTimeout(streamTimeout);
            resetStreamCapacityRetry();
            playerStatus.style.display = 'none';
            const playIcon = document.getElementById('customPlayIcon');
            if (playIcon) playIcon.textContent = '❚❚';
            const hudDot = document.getElementById('p2pHudDot');
            if (hudDot) hudDot.className = 'p2p-hud-dot active';
            resetControlsTimer();
            updatePlayerProgress();
            if (typeof applySubtitleCuesToTrack === 'function') {
                applySubtitleCuesToTrack(currentStreamOffset);
            }
            // Synchronisation de l'API native MediaSession
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'playing';
                updateMediaSession();
                updateMediaSessionPositionState(true);
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
            const hudDot = document.getElementById('p2pHudDot');
            if (hudDot) hudDot.className = 'p2p-hud-dot active';
            video.play().catch(() => {});
            updatePlayerProgress();
            if (typeof applySubtitleCuesToTrack === 'function') {
                applySubtitleCuesToTrack(currentStreamOffset);
            }
        };

        video.onwaiting = () => {
            playerStatus.style.display = 'block';
            statusText.innerText = "Mise en mémoire tampon P2P... ⏳";
            const liveBox = document.getElementById('player-p2p-live');
            if (liveBox) liveBox.style.display = 'flex';
            const hudDot = document.getElementById('p2pHudDot');
            if (hudDot) hudDot.className = 'p2p-hud-dot buffering';
            if (currentActiveMagnet) {
                fetchTorrServerP2pStats(currentActiveMagnet);
            }
        };

        video.onpause = () => {
            const playIcon = document.getElementById('customPlayIcon');
            if (playIcon) playIcon.textContent = '▶';
            showControls();
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'paused';
            }
            if (typeof savePlaybackProgress === 'function') {
                savePlaybackProgress(true);
            }
        };

        video.onended = () => {
            if ('mediaSession' in navigator) {
                navigator.mediaSession.playbackState = 'none';
            }
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
                let peerNote = "";
                if (lastP2pData && lastP2pData.totalPeers === 0) {
                    peerNote = "<br><span style='font-size:12px; color:#f87171;'>⚠️ Aucun pair détecté dans le swarm pour le moment.</span>";
                }
                statusText.innerHTML = "⏳ Le flux torrent met du temps à démarrer..." + peerNote + "<br><span style='font-size:13px; color:#ffa033;'>Cliquez sur <b>Ouvrir dans VLC</b> ci-dessous pour une lecture immédiate et fluide !</span>";
            }
        }, 8500);

        video.onerror = async () => {
            if (streamTimeout) clearTimeout(streamTimeout);
            // Serveur saturé (503) : message clair et nouvel essai, sans basculer de mode de lecture
            const retry = () => startStreamingInPlayer(magnet, titre, vlcUrl, currentActiveFileIndex, currentStreamOffset);
            if (await handleStreamCapacityError(playId, retry)) return;
            if (currentPlaySessionId !== playId) return;
            // Bascule automatique intelligente (Direct -> HLS Adaptatif) si le codec HEVC 10-bit / AV1 n'est pas décodé nativement
            const fallbackKey = `${magnet}_${currentActiveFileIndex}`;
            if (streamMode === 'direct' && lastAutoFallbackKey !== fallbackKey) {
                lastAutoFallbackKey = fallbackKey;
                const detailSel = document.getElementById('detailStreamMode');
                const navSel = document.getElementById('streamMode');
                if (detailSel) detailSel.value = 'hls';
                if (navSel) navSel.value = 'hls';
                showToast("📡 Codec non supporté en Direct : bascule automatique en HLS Adaptatif...");
                startStreamingInPlayer(magnet, titre, vlcUrl, currentActiveFileIndex, currentStreamOffset);
                return;
            }
            statusText.innerHTML = "⚠️ Le navigateur ne peut pas lire ce format directement.<br><span style='font-size:13px; color:#ffa033;'>Utilisez le mode <b>HLS / Transcodage</b> ou cliquez sur <b>Ouvrir dans VLC</b> !</span>";
        };
    }


