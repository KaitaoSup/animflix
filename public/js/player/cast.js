    // --- TÉLÉCHARGEMENT HORS-LIGNE (LOCAL EPISODE DOWNLOAD) ---
    function downloadCurrentEpisode() {
        if (!currentActiveMagnet) {
            showToast("⚠️ Aucun épisode actif à télécharger");
            return;
        }
        const parsed = currentAnimeItem ? getAnimeDetails(currentAnimeItem) : {};
        const animeTitle = currentAnimeItem?.animeName || parsed.animeName || currentAnimeItem?.titre || 'Anime';
        const ep = currentDetectedEpisode || parsed.episode || '';
        const cleanLabel = ep ? `${animeTitle} - Episode ${ep}` : animeTitle;

        const dlUrl = `/api/download?magnet=${encodeURIComponent(currentActiveMagnet)}&fileIndex=${encodeURIComponent(currentActiveFileIndex || 1)}&title=${encodeURIComponent(cleanLabel)}`;
        showToast("📥 Téléchargement local lancé en arrière-plan !");

        const a = document.createElement('a');
        a.href = dlUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
    }
    window.downloadCurrentEpisode = downloadCurrentEpisode;

    // --- GOOGLE CAST (CHROMECAST) / APPLE AIRPLAY / DIFFUSION SMART TV ---
    let cachedServerStatusIps = null;

    async function openCastModal() {
        const modal = document.getElementById('castModal');
        if (!modal) return;
        modal.style.display = 'flex';

        const statusMsg = document.getElementById('castNativeStatusMsg');
        if (statusMsg) statusMsg.textContent = '';

        // Récupérer l'adresse IP LAN réelle (ex: 192.168.x.x) et Tailscale du serveur pour les TV
        if (!cachedServerStatusIps) {
            try {
                const res = await fetch('/api/server/status');
                if (res.ok) {
                    cachedServerStatusIps = await res.json();
                }
            } catch (e) {}
        }

        const lanHost = cachedServerStatusIps?.lanIp || cachedServerStatusIps?.tailscaleIp || window.location.hostname;
        const appPort = cachedServerStatusIps?.port || window.location.port || 3000;

        const streamInput = document.getElementById('castLanStreamUrlInput');
        const appInput = document.getElementById('castLanAppUrlInput');

        if (streamInput && currentActiveMagnet) {
            const lanStreamUrl = `http://${lanHost}:8090/stream?link=${encodeURIComponent(currentActiveMagnet)}&index=${currentActiveFileIndex || 1}&play`;
            streamInput.value = lanStreamUrl;
        }
        if (appInput) {
            appInput.value = `http://${lanHost}:${appPort}`;
        }
    }

    function closeCastModal() {
        const modal = document.getElementById('castModal');
        if (modal) modal.style.display = 'none';
    }

    async function triggerNativeCastOrAirPlay() {
        const video = document.getElementById('videoPlayer');
        const statusMsg = document.getElementById('castNativeStatusMsg');
        if (!video) return;

        // 1. Apple AirPlay natif (Safari / iOS / macOS)
        if (typeof video.webkitShowPlaybackTargetPicker === 'function') {
            try {
                video.webkitShowPlaybackTargetPicker();
                if (statusMsg) statusMsg.textContent = "📡 Sélecteur AirPlay ouvert.";
                return;
            } catch (e) {}
        }

        // 2. HTML5 Remote Playback API (Chromecast / Android / Chrome / Edge)
        if (video.remote && typeof video.remote.prompt === 'function') {
            try {
                if (statusMsg) statusMsg.textContent = "🔍 Recherche d'écrans Chromecast / Sans-fil...";
                await video.remote.prompt();
                if (statusMsg) statusMsg.textContent = "✅ Connecté à l'écran distant !";
                showToast("📺 Diffusion sur l'écran distant activée !");
                return;
            } catch (err) {
                if (statusMsg) {
                    statusMsg.textContent = "ℹ️ Astuce : Vous pouvez aussi utiliser le menu 'Caster...' de votre navigateur ou copier le lien réseau ci-dessous dans VLC sur votre TV.";
                }
                return;
            }
        }

        if (statusMsg) {
            statusMsg.textContent = "ℹ️ Utilisez l'option 'Caster' de votre navigateur ou copiez le lien réseau ci-dessous sur votre Smart TV / VLC TV.";
        }
    }

    function switchToHlsForCasting() {
        const detailSel = document.getElementById('detailStreamMode');
        if (detailSel) {
            detailSel.value = 'hls';
            if (typeof onDetailStreamModeChange === 'function') {
                onDetailStreamModeChange();
            }
        }
        closeCastModal();
    }

    function copyCastUrl(inputId) {
        const input = document.getElementById(inputId);
        if (!input || !input.value) return;
        navigator.clipboard.writeText(input.value).then(() => {
            showToast("📋 Lien réseau TV copié dans le presse-papier !");
        }).catch(() => {
            input.select();
            document.execCommand('copy');
            showToast("📋 Lien réseau TV copié !");
        });
    }

    window.openCastModal = openCastModal;
    window.closeCastModal = closeCastModal;
    window.triggerNativeCastOrAirPlay = triggerNativeCastOrAirPlay;
    window.switchToHlsForCasting = switchToHlsForCasting;
    window.copyCastUrl = copyCastUrl;

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
            const castModal = document.getElementById('castModal');
            if (castModal && castModal.style.display === 'flex') {
                closeCastModal();
                return;
            }
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
        destroyCurrentHlsInstance(true);
    });

    ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'].forEach(ev => {
        document.addEventListener(ev, () => {
            const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement);
            if (!isFs && screen.orientation && screen.orientation.unlock) {
                try { screen.orientation.unlock(); } catch (e) {}
            }
        });
    });

    window.togglePlayerP2pHud = togglePlayerP2pHud;
    window.startTorrServerP2pPolling = startTorrServerP2pPolling;
    window.stopTorrServerP2pPolling = stopTorrServerP2pPolling;
    window.fetchTorrServerP2pStats = fetchTorrServerP2pStats;



