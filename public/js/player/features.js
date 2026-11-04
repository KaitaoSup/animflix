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

