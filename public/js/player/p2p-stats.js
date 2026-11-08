    // --- TÉLÉMÉTRIE & STATS P2P EN DIRECT (TORRSERVER) ---
    let p2pPollingTimer = null;
    let currentP2pMagnet = null;
    let isP2pHudOpen = false;
    let lastP2pData = null;

    function startTorrServerP2pPolling(magnet) {
        if (p2pPollingTimer) {
            clearTimeout(p2pPollingTimer);
            p2pPollingTimer = null;
        }
        currentP2pMagnet = magnet;

        // Reset visuel immédiat des indicateurs P2P
        const liveBox = document.getElementById('player-p2p-live');
        const speedVal = document.getElementById('p2pStatusSpeedVal');
        const peersVal = document.getElementById('p2pStatusPeersVal');
        const bufferVal = document.getElementById('p2pStatusBufferVal');
        const progressFill = document.getElementById('p2pProgressFill');
        const subDetail = document.getElementById('p2pSubDetail');
        const hudDot = document.getElementById('p2pHudDot');
        const hudBadge = document.getElementById('playerP2pSpeedBadge');

        if (liveBox) liveBox.style.display = 'flex';
        if (speedVal) speedVal.textContent = '0 Ko/s';
        if (peersVal) peersVal.textContent = 'Recherche pairs...';
        if (bufferVal) bufferVal.textContent = '0%';
        if (progressFill) progressFill.style.width = '0%';
        if (subDetail) subDetail.textContent = 'Connexion à TorrServer & swarm BitTorrent...';
        if (hudDot) hudDot.className = 'p2p-hud-dot buffering';
        if (hudBadge) hudBadge.textContent = 'P2P';

        // Épisode gardé sur le serveur : lecture depuis le disque, pas de statistiques P2P à suivre
        if (typeof getKeptServerDownload === 'function' && getKeptServerDownload(magnet, currentActiveFileIndex)) {
            if (liveBox) liveBox.style.display = 'none';
            if (subDetail) subDetail.textContent = 'Lecture du fichier gardé sur le serveur';
            if (hudDot) hudDot.className = 'p2p-hud-dot idle';
            if (hudBadge) hudBadge.textContent = '💾 Local';
            return;
        }

        pollLoop();

        async function pollLoop() {
            if (!currentP2pMagnet || currentP2pMagnet !== magnet) return;
            await fetchTorrServerP2pStats(magnet);
            if (!currentP2pMagnet || currentP2pMagnet !== magnet) return;

            const video = document.getElementById('videoPlayer');
            const playerStatus = document.getElementById('player-status');
            const isStatusVisible = playerStatus && playerStatus.style.display !== 'none';
            const isBuffering = !video || video.paused || video.readyState < 3 || isStatusVisible;

            // Sondage rapide (1s) lors du préchargement ou rebuffering, plus espacé (2.5s) en lecture fluide
            const delay = isBuffering ? 1000 : 2500;
            p2pPollingTimer = setTimeout(pollLoop, delay);
        }
    }

    function stopTorrServerP2pPolling() {
        if (p2pPollingTimer) {
            clearTimeout(p2pPollingTimer);
            p2pPollingTimer = null;
        }
        currentP2pMagnet = null;
        lastP2pData = null;

        const hudCard = document.getElementById('playerP2pHudCard');
        if (hudCard) hudCard.style.display = 'none';
        const hudBtn = document.getElementById('playerP2pBtn');
        if (hudBtn) hudBtn.classList.remove('active');
        const hudDot = document.getElementById('p2pHudDot');
        if (hudDot) hudDot.className = 'p2p-hud-dot idle';
        const hudBadge = document.getElementById('playerP2pSpeedBadge');
        if (hudBadge) hudBadge.textContent = 'P2P';
        isP2pHudOpen = false;
    }

    async function fetchTorrServerP2pStats(magnet) {
        if (!magnet) return;
        try {
            const res = await fetch('/api/torrserver/stats?magnet=' + encodeURIComponent(magnet));
            if (!res.ok) return;
            const data = await res.json();
            if (currentP2pMagnet !== magnet) return;
            lastP2pData = data;

            const liveBox = document.getElementById('player-p2p-live');
            const speedVal = document.getElementById('p2pStatusSpeedVal');
            const peersVal = document.getElementById('p2pStatusPeersVal');
            const bufferVal = document.getElementById('p2pStatusBufferVal');
            const progressFill = document.getElementById('p2pProgressFill');
            const subDetail = document.getElementById('p2pSubDetail');
            const statusText = document.getElementById('status-text');
            const playerStatus = document.getElementById('player-status');
            const hudDot = document.getElementById('p2pHudDot');
            const hudBadge = document.getElementById('playerP2pSpeedBadge');

            if (data.online && data.found) {
                if (liveBox) liveBox.style.display = 'flex';
                if (speedVal) speedVal.textContent = data.downloadSpeedFormatted || '0 Ko/s';
                if (peersVal) {
                    peersVal.textContent = (data.activePeers > 0 || data.totalPeers > 0)
                        ? `${data.activePeers} / ${data.totalPeers} pairs`
                        : 'Recherche pairs...';
                }
                if (bufferVal) bufferVal.textContent = `${data.preloadPercent || 0}%`;
                if (progressFill) progressFill.style.width = `${data.preloadPercent || 0}%`;

                // Mettre à jour le message d'état si la modale de chargement est visible
                if (statusText && playerStatus && playerStatus.style.display !== 'none') {
                    if (data.stat === 1) {
                        statusText.innerText = data.totalPeers > 0
                            ? `Découverte du swarm : ${data.totalPeers} pairs détectés... 🌐`
                            : "Connexion aux nœuds & recherche des métadonnées... ⏳";
                    } else if (data.stat === 2) {
                        statusText.innerText = `Mise en mémoire tampon (${data.preloadPercent}%)... 📦`;
                    } else if (data.stat === 3 && data.preloadPercent >= 100) {
                        statusText.innerText = "Démarrage du flux vidéo... ▶";
                    }
                }

                if (subDetail) {
                    if (data.stat === 1) {
                        subDetail.textContent = `Tracker DHT actif (${data.totalPeers || 0} pairs détectés)`;
                    } else if (data.stat === 2) {
                        const loadedStr = data.preloadedBytes > 0 ? `${(data.preloadedBytes / (1024 * 1024)).toFixed(1)} Mo` : '0 Mo';
                        const targetStr = data.preloadSize > 0 ? `${(data.preloadSize / (1024 * 1024)).toFixed(1)} Mo` : '32 Mo';
                        subDetail.textContent = `Tampon : ${loadedStr} / ${targetStr} (Débit : ${data.downloadSpeedFormatted})`;
                    } else if (data.stat === 3) {
                        subDetail.textContent = `Streaming fluide P2P • ${data.connectedSeeders || 0} seeders actifs`;
                    }
                }

                // Puce lumineuse d'état et vitesse dans la barre de contrôle
                if (hudDot) {
                    if (data.stat === 3 && data.downloadSpeed > 0) {
                        hudDot.className = 'p2p-hud-dot active';
                    } else if (data.stat === 1 || data.stat === 2) {
                        hudDot.className = 'p2p-hud-dot buffering';
                    } else {
                        hudDot.className = 'p2p-hud-dot idle';
                    }
                }

                if (hudBadge) {
                    if (data.downloadSpeed && data.downloadSpeed > 0) {
                        hudBadge.textContent = data.downloadSpeedFormatted;
                    } else if (data.connectedSeeders > 0) {
                        hudBadge.textContent = `${data.connectedSeeders} seed`;
                    } else {
                        hudBadge.textContent = 'P2P';
                    }
                }

                // Mise à jour de la carte HUD détaillée si ouverte
                updatePlayerP2pHudCardUI(data);

            } else if (data.online && !data.found) {
                if (hudDot) hudDot.className = 'p2p-hud-dot buffering';
                if (hudBadge) hudBadge.textContent = 'Init...';
                if (subDetail) subDetail.textContent = "Initialisation de la session TorrServer...";
            }
        } catch (e) {}
    }

    function updatePlayerP2pHudCardUI(data) {
        if (!data) return;
        const dl = document.getElementById('p2pHudDlSpeed');
        const ul = document.getElementById('p2pHudUlSpeed');
        const peers = document.getElementById('p2pHudPeers');
        const seeders = document.getElementById('p2pHudSeeders');
        const buf = document.getElementById('p2pHudBufferInfo');
        const engine = document.getElementById('p2pHudEngineStatus');

        if (dl) dl.textContent = data.downloadSpeedFormatted || '0 Ko/s';
        if (ul) ul.textContent = data.uploadSpeedFormatted || '0 Ko/s';
        if (peers) peers.textContent = `${data.activePeers || 0} / ${data.totalPeers || 0}`;
        if (seeders) seeders.textContent = `${data.connectedSeeders || 0} sources`;
        if (buf) {
            const loaded = data.loadedSizeFormatted || '0 Mo';
            const total = data.torrentSizeFormatted || '--';
            buf.textContent = `${loaded} / ${total} (Buffer ${data.preloadPercent || 0}%)`;
        }
        if (engine) {
            engine.textContent = data.statLabel || 'Actif';
            engine.style.color = data.stat === 3 ? '#4ade80' : (data.stat === 2 ? '#fbbf24' : '#38bdf8');
        }
    }

    function togglePlayerP2pHud(event) {
        if (event) event.stopPropagation();
        const card = document.getElementById('playerP2pHudCard');
        const btn = document.getElementById('playerP2pBtn');
        if (!card) return;

        isP2pHudOpen = (card.style.display !== 'block');
        card.style.display = isP2pHudOpen ? 'block' : 'none';
        if (btn) {
            if (isP2pHudOpen) btn.classList.add('active');
            else btn.classList.remove('active');
        }

        if (isP2pHudOpen) {
            if (lastP2pData) {
                updatePlayerP2pHudCardUI(lastP2pData);
            }
            if (currentActiveMagnet) {
                fetchTorrServerP2pStats(currentActiveMagnet);
            }
        }
    }

