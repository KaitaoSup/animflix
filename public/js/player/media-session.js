    // --- INTÉGRATION DE L'API NATIVE MEDIA SESSION (ÉCRAN DE VERROUILLAGE, BLUETOOTH & OS) ---
    let mediaSessionActionsConfigured = false;
    let lastMediaSessionPosTime = 0;

    function setupMediaSessionActions() {
        if (!('mediaSession' in navigator) || mediaSessionActionsConfigured) return;
        mediaSessionActionsConfigured = true;

        const actions = [
            ['play', () => {
                const video = document.getElementById('videoPlayer');
                if (video && video.paused) {
                    video.play().catch(() => {});
                }
            }],
            ['pause', () => {
                const video = document.getElementById('videoPlayer');
                if (video && !video.paused) {
                    video.pause();
                }
            }],
            ['seekbackward', (details) => {
                const skip = details?.seekOffset || 10;
                jumpSeekRelative(-skip);
            }],
            ['seekforward', (details) => {
                const skip = details?.seekOffset || 10;
                jumpSeekRelative(skip);
            }],
            ['seekto', (details) => {
                if (details && typeof details.seekTime === 'number' && !isNaN(details.seekTime)) {
                    seekVideoTo(details.seekTime);
                }
            }],
            ['previoustrack', () => {
                if (Array.isArray(window._currentPackFiles) && window._currentPackFiles.length > 1) {
                    const curEp = currentDetectedEpisode;
                    let prevFile = window._currentPackFiles.find(f => f.episode === curEp - 1);
                    if (!prevFile) {
                        const curIdx = window._currentPackFiles.findIndex(f => f.id === currentActiveFileIndex);
                        if (curIdx > 0) {
                            prevFile = window._currentPackFiles[curIdx - 1];
                        }
                    }
                    if (prevFile && typeof playNextPackEpisode === 'function') {
                        playNextPackEpisode(prevFile);
                        return;
                    }
                }
                seekVideoTo(0, true);
            }],
            ['nexttrack', () => {
                if (typeof triggerNextEpisodeOverlay === 'function') {
                    triggerNextEpisodeOverlay(true);
                }
            }],
            ['stop', () => {
                const video = document.getElementById('videoPlayer');
                if (video) video.pause();
                if (typeof closeDetailView === 'function') {
                    closeDetailView();
                }
            }]
        ];

        for (const [action, handler] of actions) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch (err) {
                // Ignore actions non supportées
            }
        }
    }

    function updateMediaSession() {
        if (!('mediaSession' in navigator)) return;

        if (!currentAnimeItem && !currentActiveMagnet) {
            navigator.mediaSession.metadata = null;
            return;
        }

        const parsed = getAnimeDetails(currentAnimeItem);
        const animeTitle = currentAnimeItem?.animeName || parsed.animeName || currentAnimeItem?.cleanTitle || 'Anime';
        const epNum = currentDetectedEpisode || (currentAnimeItem ? parseAnimeDetails(currentAnimeItem.titre).episode : null) || parsed.episode || 'Épisode 1';
        const epLabel = typeof epNum === 'number' ? `Épisode ${epNum}` : String(epNum);
        const seasonLabel = parsed.season || 'Saison 1';

        let posterUrl = currentAnimeItem?.poster || 
                        (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.coverImage?.large) ||
                        (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.coverImage?.medium) || '';

        if (posterUrl && posterUrl.startsWith('/')) {
            posterUrl = window.location.origin + posterUrl;
        }

        const artwork = [];
        if (posterUrl) {
            artwork.push(
                { src: posterUrl, sizes: '96x96', type: 'image/jpeg' },
                { src: posterUrl, sizes: '128x128', type: 'image/jpeg' },
                { src: posterUrl, sizes: '192x192', type: 'image/jpeg' },
                { src: posterUrl, sizes: '256x256', type: 'image/jpeg' },
                { src: posterUrl, sizes: '384x384', type: 'image/jpeg' },
                { src: posterUrl, sizes: '512x512', type: 'image/jpeg' }
            );
        } else {
            artwork.push(
                { src: window.location.origin + '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: window.location.origin + '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
            );
        }

        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: `${animeTitle} — ${epLabel}`,
                artist: animeTitle,
                album: `${seasonLabel} • Animflix`,
                artwork: artwork
            });
        } catch (e) {
            console.warn("[MediaSession] Erreur MediaMetadata:", e);
        }

        setupMediaSessionActions();
        updateMediaSessionPositionState(true);
    }

    function updateMediaSessionPositionState(force = false) {
        if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
        const now = Date.now();
        if (!force && (now - lastMediaSessionPosTime < 1000)) return;
        lastMediaSessionPosTime = now;

        const video = document.getElementById('videoPlayer');
        if (!video) return;

        const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;
        const currentPos = Math.max(0, Math.min(totalDur, currentStreamOffset + (video.currentTime || 0)));

        try {
            navigator.mediaSession.setPositionState({
                duration: totalDur,
                playbackRate: video.playbackRate || 1,
                position: currentPos
            });
        } catch (e) {}
    }

    function resetMediaSession() {
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.playbackState = 'none';
                navigator.mediaSession.metadata = null;
            } catch (e) {}
        }
    }

    window.updateMediaSession = updateMediaSession;
    window.resetMediaSession = resetMediaSession;
    window.updateMediaSessionPositionState = updateMediaSessionPositionState;

