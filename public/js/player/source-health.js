    // --- SIGNALEMENT DES SOURCES (TORRENT QUI NE DÉMARRE PAS / ILLISIBLE) ---
    //
    // Le lecteur indique au serveur si une source démarre ou échoue. Une source en échec passe après les
    // autres dans le choix automatique, pour tous les comptes ; un démarrage réussi efface les échecs.

    const SOURCE_STALL_REPORT_MS = 60000;
    const sourceReportsSent = new Set(); // `${outcome}|${hash}_f${index}` déjà envoyés pendant cette session
    const sourcesStarted = new Set();     // sources ayant réussi à démarrer (pas de faux échec après un seek)
    let sourceStallTimer = null;

    function sourceReportKey(magnet, fileIndex) {
        const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet || '');
        return m ? `${m[1].toLowerCase()}_f${parseInt(fileIndex, 10) || 1}` : null;
    }

    function currentSourceTitle() {
        const parsed = currentAnimeItem && typeof getAnimeDetails === 'function' ? getAnimeDetails(currentAnimeItem) : {};
        const name = currentAnimeItem?.animeName || parsed.animeName || currentAnimeItem?.titre || '';
        const ep = Number(currentDetectedEpisode) || null;
        return (ep ? `${name} - Épisode ${ep}` : name) || (currentAnimeItem?.titre || '');
    }

    /**
     * Envoie le résultat d'une lecture : outcome 'ok' | 'fail', reason 'no_peers' | 'stalled' | 'unplayable' | 'manual'
     */
    function reportSourceOutcome(outcome, reason = null, { magnet = currentActiveMagnet, fileIndex = currentActiveFileIndex, force = false } = {}) {
        const key = sourceReportKey(magnet, fileIndex);
        if (!key) return Promise.resolve(null);
        // Fichier gardé sur le serveur : il ne dépend pas du torrent
        if (typeof getKeptServerDownload === 'function' && getKeptServerDownload(magnet, fileIndex)) return Promise.resolve(null);
        if (outcome === 'ok') sourcesStarted.add(key);
        // Une source qui a déjà démarré n'est pas « cassée » (sauf signalement manuel)
        if (outcome === 'fail' && reason !== 'manual' && sourcesStarted.has(key)) return Promise.resolve(null);
        const sentKey = `${outcome}|${key}`;
        if (!force && sourceReportsSent.has(sentKey)) return Promise.resolve(null);
        sourceReportsSent.add(sentKey);
        return fetch('/api/sources/report', {
            method: 'POST',
            headers: typeof getAuthHeaders === 'function' ? getAuthHeaders() : { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                magnet, fileIndex: parseInt(fileIndex, 10) || 1, outcome, reason,
                title: currentSourceTitle(),
                clientId: typeof getOrCreateClientId === 'function' ? getOrCreateClientId() : undefined
            })
        }).then(r => (r.ok ? r.json() : null)).catch(() => null);
    }

    // Lancée à chaque démarrage de flux : sans image au bout de 60 s, la source est signalée
    function armSourceStallReport(playId, magnet, fileIndex) {
        clearSourceStallReport();
        sourceStallTimer = setTimeout(() => {
            sourceStallTimer = null;
            if (currentPlaySessionId !== playId || currentActiveMagnet !== magnet || document.visibilityState !== 'visible') return;
            const playerStatus = document.getElementById('player-status');
            if (!playerStatus || playerStatus.style.display === 'none') return;
            const noPeers = typeof lastP2pData !== 'undefined' && lastP2pData && lastP2pData.found && !lastP2pData.totalPeers;
            reportSourceOutcome('fail', noPeers ? 'no_peers' : 'stalled', { magnet, fileIndex });
        }, SOURCE_STALL_REPORT_MS);
    }

    function clearSourceStallReport() {
        if (sourceStallTimer) clearTimeout(sourceStallTimer);
        sourceStallTimer = null;
    }

    // Bouton « Source cassée » : signalement manuel puis proposition d'une autre source
    async function reportCurrentSourceBroken() {
        if (!currentActiveMagnet) return;
        const ok = typeof openUiDialog === 'function'
            ? await openUiDialog({
                title: 'Signaler cette source ?',
                message: "Elle passera après les autres sources dans le choix automatique, pour tous les comptes du serveur, jusqu'à ce que quelqu'un réussisse à la lire.",
                okLabel: 'Signaler', cancelLabel: 'Annuler'
            })
            : confirm('Signaler cette source comme cassée ?');
        if (!ok) return;
        const key = sourceReportKey(currentActiveMagnet, currentActiveFileIndex);
        if (key) sourcesStarted.delete(key);
        await reportSourceOutcome('fail', 'manual', { force: true });
        showToast('🚫 Source signalée : choisissez-en une autre dans la liste');
        // Liste des sources de l'épisode (fiche anime) si on vient d'une fiche
        const ep = Number(currentDetectedEpisode) || null;
        if (window._currentAnimePageId && typeof openAnimeSourcePicker === 'function' && typeof animePageState !== 'undefined'
            && animePageState.media?.id === window._currentAnimePageId) {
            if (typeof closeDetailView === 'function') closeDetailView({ navigate: false });
            openAnimeSourcePicker(ep || 1);
        }
    }

    window.reportCurrentSourceBroken = reportCurrentSourceBroken;
