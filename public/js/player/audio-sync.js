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

