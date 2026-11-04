// =========================================================================
// --- ANIMFLIX SUBTITLES (LIBASS WASM & WEBVTT STREAMING, TIME OFFSET & STYLING) ---
// =========================================================================

    // --- INSTANCE LIBASS WASM (JASSUB) & CONTENU ASS BRUT ---
    let jassubInstance = null;
    let currentRawAssContent = null;
    // Repli WebVTT temporaire (pour l'épisode en cours) sans toucher à la préférence enregistrée
    let libassFallbackActive = false;
    // Visibilité choisie via le bouton CC (conservée lors des recréations du canvas JASSUB)
    let subtitlesHidden = false;
    // Sérialisation des (ré)initialisations JASSUB : une seule instance / un seul canvas à la fois
    let jassubOpChain = Promise.resolve();
    let jassubGeneration = 0;

    function isLibassActive() {
        return currentSubStyle.renderer === 'libass' && !libassFallbackActive;
    }

    function removeJassubCanvases() {
        document.querySelectorAll('canvas.JASSUB').forEach(c => c.remove());
    }

    function applyJassubCanvasVisibility() {
        document.querySelectorAll('canvas.JASSUB').forEach(c => {
            c.style.display = subtitlesHidden ? 'none' : 'block';
        });
    }

    function destroyJassub() {
        jassubGeneration++; // invalide toute initialisation en cours
        const inst = jassubInstance;
        jassubInstance = null;
        if (inst) {
            try {
                const p = inst.destroy();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            } catch (e) {}
        }
        removeJassubCanvases();
    }

    // Bascule sur WebVTT pour la piste courante quand libass échoue (préférence utilisateur inchangée)
    function activateLibassFallback(magnet, subIndex, fileIndex) {
        libassFallbackActive = true;
        destroyJassub();
        currentLoadedSubKey = null;
        if (magnet && subIndex !== -1) {
            streamSubtitlesLive(magnet, subIndex, fileIndex, currentActualStartOffset);
        }
    }

