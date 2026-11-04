    // --- POLICES EMBARQUÉES DE LA TEAM (PIÈCES JOINTES MKV) ---
    // Sans elles, libass remplace toutes les polices des dialogues et panneaux par la police par défaut.
    function loadEmbeddedFonts(magnet, fileIndex) {
        const key = magnet + '_f' + fileIndex;
        if (key === currentFontsKey && currentFontsPromise) return currentFontsPromise;
        currentFontsKey = key;
        currentFontUrls = [];
        currentFontsPromise = (async () => {
            // Le serveur répond 503 tant que le torrent est trop lent pour lire l'en-tête : quelques essais espacés
            for (let attempt = 0; attempt < 4; attempt++) {
                if (currentFontsKey !== key) return;
                try {
                    const res = await fetch('/api/fonts?magnet=' + encodeURIComponent(magnet) + '&fileIndex=' + fileIndex);
                    if (res.ok) {
                        const data = await res.json();
                        if (currentFontsKey !== key) return;
                        currentFontUrls = (data.fonts || []).map(f => new URL(f.url, location.href).href);
                        if (currentFontUrls.length > 0) {
                            console.log(`[Sous-titres] ${currentFontUrls.length} police(s) embarquée(s) de la team chargée(s)`);
                            await applyEmbeddedFonts(jassubInstance);
                        }
                        return;
                    }
                    if (res.status !== 503) return;
                } catch (e) {}
                await new Promise(r => setTimeout(r, 6000));
            }
        })();
        return currentFontsPromise;
    }

    // Ajoute les polices embarquées à une instance JASSUB (une seule fois par instance et par fichier)
    async function applyEmbeddedFonts(instance) {
        if (!instance || !instance.renderer || currentFontUrls.length === 0) return;
        if (instance._animflixFontsKey === currentFontsKey) return;
        instance._animflixFontsKey = currentFontsKey;
        try {
            await instance.renderer.addFonts(currentFontUrls);
            if (instance === jassubInstance) safeJassubRender(true);
        } catch (e) {
            console.warn("[JASSUB] Impossible d'ajouter les polices embarquées :", e);
        }
    }

    // Initialisation ou mise à jour de l'instance JASSUB (libass Wasm).
    // Les appels sont sérialisés et seul le plus récent s'applique : jamais deux instances / canvas en même temps.
    function initOrUpdateJassub(subContent = null) {
        if (subContent) currentRawAssContent = subContent;
        const gen = ++jassubGeneration;
        const run = jassubOpChain.then(() => doInitOrUpdateJassub(gen));
        jassubOpChain = run.catch(() => {});
        return run;
    }

    async function doInitOrUpdateJassub(gen) {
        if (gen !== jassubGeneration) return; // remplacé par un appel plus récent
        const video = document.getElementById('videoPlayer');
        if (!video || !currentRawAssContent) return;

        const subSelect = document.getElementById('subSelect');
        if (subSelect && subSelect.value === "-1") {
            destroyJassub();
            return;
        }

        const effOffset = currentActualStartOffset - currentManualSubOffset;
        const isCustomMode = currentSubStyle.mode === 'custom';
        const subContentToRender = isCustomMode
            ? applyStyleOverrideToAss(currentRawAssContent, currentSubStyle)
            : currentRawAssContent;

        // Détruire l'instance précédente (sans incrémenter la génération courante)
        const previous = jassubInstance;
        jassubInstance = null;
        if (previous) {
            try { await previous.destroy(); } catch (e) {}
        }
        removeJassubCanvases();
        if (gen !== jassubGeneration) return;

        let instance = null;
        try {
            instance = new window.JASSUB({
                video: video,
                subContent: subContentToRender,
                workerUrl: '/vendor/jassub/jassub-worker.bundle.js',
                wasmUrl: '/vendor/jassub/jassub-worker.wasm',
                modernWasmUrl: '/vendor/jassub/jassub-worker-modern.wasm',
                defaultFont: 'liberation sans',
                availableFonts: {
                    'liberation sans': '/vendor/jassub/default.woff2'
                },
                timeOffset: effOffset
            });
            jassubInstance = instance;
            await instance.ready;

            // Un appel plus récent (changement de style, de piste, désactivation) a pris le relais entre-temps
            if (gen !== jassubGeneration || jassubInstance !== instance) {
                try { await instance.destroy(); } catch (e) {}
                return;
            }

            try {
                if (typeof instance.resize === 'function') {
                    await instance.resize(true);
                }
                safeJassubRender(true);
            } catch (e) {}

            // Polices de la team : ajoutées sans bloquer le premier affichage (téléchargement parfois lourd)
            applyEmbeddedFonts(instance);

            applyJassubCanvasVisibility();

            // Désactiver le TextTrack natif HTML5 pour éviter tout doublon visuel
            if (currentTextTrack) {
                try { currentTextTrack.mode = 'disabled'; } catch(e) {}
            }
            if (video.textTracks) {
                for (let i = 0; i < video.textTracks.length; i++) {
                    try { video.textTracks[i].mode = 'disabled'; } catch(e) {}
                }
            }

            const subStatus = document.getElementById('sub-status');
            if (subStatus && !subtitlesHidden) {
                const modeLabel = isCustomMode ? 'Style personnalisé' : 'Original Fansub';
                const offsetLabel = currentManualSubOffset !== 0
                    ? ` [Sync: ${currentManualSubOffset > 0 ? '+' : ''}${currentManualSubOffset.toFixed(1)}s]`
                    : '';
                subStatus.innerText = `✨ Sous-titres HD actifs (libass • ${modeLabel})${offsetLabel}`;
                subStatus.style.color = "#46d369";
            }
        } catch (err) {
            if (gen !== jassubGeneration) return;
            console.warn("[JASSUB] Échec initialisation libass, repli sur WebVTT :", err);
            if (jassubInstance === instance) jassubInstance = null;
            if (instance) {
                try { await instance.destroy(); } catch(e) {}
            }
            removeJassubCanvases();
            const chosenIndex = subSelect ? parseInt(subSelect.value, 10) : 0;
            if (currentLoadedSubMagnet) {
                activateLibassFallback(currentLoadedSubMagnet, chosenIndex, currentLoadedSubFileIndex);
            }
        }
    }

