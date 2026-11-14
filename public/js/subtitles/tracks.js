    function resetSubtitlesState() {
        if (currentSubAbort) {
            currentSubAbort.abort();
            currentSubAbort = null;
        }
        destroyJassub();
        libassFallbackActive = false; // nouvel épisode : retenter libass
        currentRawAssContent = null;
        currentLoadedSubKey = null;
        currentLoadedSubMagnet = null;
        currentLoadedSubFileIndex = null;
        currentSubTracks = [];
        currentFontUrls = [];
        currentFontsKey = null;
        currentFontsPromise = null;
        cachedEpisodeCues = [];
        currentActualStartOffset = 0.0;
        currentManualSubOffset = 0.0;
        currentTextTrack = null;
        const subStatus = document.getElementById('sub-status');
        if (subStatus) subStatus.innerText = "";
    }

    // Réaligne instantanément les sous-titres quand le serveur confirme le point clé réel (keyframe)
    function updateSubtitleOffset(actualStart) {
        currentActualStartOffset = parseFloat(actualStart) || 0;
        const effOffset = currentActualStartOffset - currentManualSubOffset;
        if (jassubInstance && isLibassActive()) {
            jassubInstance.timeOffset = effOffset;
            safeJassubRender(true);
        } else {
            applySubtitleCuesToTrack(currentActualStartOffset);
        }
    }

    // Réglage manuel de décalage des sous-titres (accessible via boutons et raccourcis G / H)
    function adjustSubtitleSync(deltaSeconds) {
        currentManualSubOffset = Math.round((currentManualSubOffset + deltaSeconds) * 10) / 10;
        const display = document.getElementById('subSyncDisplay');
        if (display) {
            display.textContent = (currentManualSubOffset >= 0 ? '+' : '') + currentManualSubOffset.toFixed(1) + 's';
        }
        const effOffset = currentActualStartOffset - currentManualSubOffset;
        if (jassubInstance && isLibassActive()) {
            jassubInstance.timeOffset = effOffset;
            safeJassubRender(true);
            const subStatus = document.getElementById('sub-status');
            if (subStatus) {
                const modeLabel = currentSubStyle.mode === 'custom' ? 'Style personnalisé' : 'Original Fansub';
                const offsetLabel = currentManualSubOffset !== 0
                    ? ` [Sync: ${currentManualSubOffset > 0 ? '+' : ''}${currentManualSubOffset.toFixed(1)}s]`
                    : '';
                subStatus.innerText = `✨ Sous-titres HD actifs (libass • ${modeLabel})${offsetLabel}`;
            }
        } else {
            applySubtitleCuesToTrack(currentActualStartOffset);
        }
        showToast(`⏱️ Synchro sous-titres : ${currentManualSubOffset >= 0 ? '+' : ''}${currentManualSubOffset.toFixed(1)}s`);
    }

    function resetSubtitleSync() {
        currentManualSubOffset = 0.0;
        const display = document.getElementById('subSyncDisplay');
        if (display) {
            display.textContent = "0.0s";
        }
        const effOffset = currentActualStartOffset - currentManualSubOffset;
        if (jassubInstance && isLibassActive()) {
            jassubInstance.timeOffset = effOffset;
            safeJassubRender(true);
            const subStatus = document.getElementById('sub-status');
            if (subStatus) {
                const modeLabel = currentSubStyle.mode === 'custom' ? 'Style personnalisé' : 'Original Fansub';
                subStatus.innerText = `✨ Sous-titres HD actifs (libass • ${modeLabel})`;
            }
        } else {
            applySubtitleCuesToTrack(currentActualStartOffset);
        }
        showToast("⏱️ Synchronisation réinitialisée (0.0s)");
    }

    // Nouvel essai d'analyse des pistes quand le serveur n'a pas pu les lire (torrent encore lent)
    let trackProbeRetryTimer = null;
    let trackProbeRetryCount = 0;
    let userPickedSubTrack = false;

    function scheduleTrackProbeRetry(magnet, type, fileIndex) {
        clearTimeout(trackProbeRetryTimer);
        if (trackProbeRetryCount >= 5) return;
        trackProbeRetryCount++;
        trackProbeRetryTimer = setTimeout(() => {
            trackProbeRetryTimer = null;
            // Toujours sur le même fichier ?
            if (magnet !== currentLoadedSubMagnet || fileIndex !== currentLoadedSubFileIndex) return;
            currentLoadedSubMagnet = null; // forcer la reconstruction des listes
            setupSubtitles(magnet, type, fileIndex, currentActualStartOffset, { isProbeRetry: true });
        }, 8000);
    }

    async function setupSubtitles(magnet, type, fileIndex = 1, seekOffset = 0, { isProbeRetry = false } = {}) {
        const subSelect = document.getElementById('subSelect');
        const audioSelect = document.getElementById('audioSelect');
        const subStatus = document.getElementById('sub-status');

        currentActualStartOffset = parseFloat(seekOffset) || 0;

        // Si on est dans le même fichier torrent (ex: simple saut/avance/recul dans la vidéo)
        if (magnet === currentLoadedSubMagnet && fileIndex === currentLoadedSubFileIndex) {
            const chosenIndex = subSelect ? parseInt(subSelect.value, 10) : 0;
            if (chosenIndex !== -1) {
                streamSubtitlesLive(magnet, chosenIndex, fileIndex, currentActualStartOffset);
            }
            return;
        }

        currentLoadedSubMagnet = magnet;
        currentLoadedSubFileIndex = fileIndex;
        if (!isProbeRetry) {
            clearTimeout(trackProbeRetryTimer);
            trackProbeRetryTimer = null;
            trackProbeRetryCount = 0;
            userPickedSubTrack = false;
            subSelect.innerHTML = '<option value="-1">Analyse des pistes... ⏳</option>';
            if (audioSelect) audioSelect.innerHTML = '<option value="">Analyse audio... ⏳</option>';
            subStatus.innerText = "";
        }

        try {
            const res = await fetch('/api/streams?magnet=' + encodeURIComponent(magnet) + '&fileIndex=' + fileIndex);
            const info = await res.json();
            const subTracks = info.subTracks || [];
            const audioTracks = info.audioTracks || [];
            currentSubTracks = subTracks;

            // Opening / ending trouvés dans les chapitres du fichier (prioritaires sur AniSkip)
            if (!info.probeFailed && typeof setChapterSkipIntervals === 'function') {
                setChapterSkipIntervals(`${magnet}_${fileIndex}`, info.skipChapters || null);
            }

            if (info.probeFailed) {
                // Pistes inconnues pour l'instant : réessayer, sans écraser la liste si c'est déjà un nouvel essai
                scheduleTrackProbeRetry(magnet, type, fileIndex);
                if (isProbeRetry) return;
            } else if (isProbeRetry) {
                console.log("[Sous-titres] Analyse des pistes réussie après un nouvel essai :", subTracks);
            }

            // Récupération de la durée exacte de la vidéo analysée
            if (info && info.duration && info.duration > 0) {
                currentTotalDuration = info.duration;
                const totalLabel = document.getElementById('playerDisplayTotal');
                if (totalLabel) totalLabel.textContent = formatTimestamp(currentTotalDuration);
                updatePlayerProgress();
                if (typeof renderAniSkipTimelineMarkers === 'function') {
                    renderAniSkipTimelineMarkers();
                }
            }

            // 1. Mise à jour du sélecteur Audio
            if (audioSelect) {
                audioSelect.innerHTML = '';
                const optAuto = document.createElement('option');
                optAuto.value = "";
                optAuto.textContent = "Auto (Défaut)";
                audioSelect.appendChild(optAuto);

                audioTracks.forEach(a => {
                    const opt = document.createElement('option');
                    opt.value = a.index;
                    opt.textContent = a.label;
                    if (currentActiveAudioIndex !== null && currentActiveAudioIndex === a.index) {
                        opt.selected = true;
                    }
                    audioSelect.appendChild(opt);
                });
            }

            // 2. Mise à jour du sélecteur Sous-titres
            const subPickedBeforeRetry = isProbeRetry ? subSelect.value : null;
            subSelect.innerHTML = '';
            if (subTracks.length === 0) {
                subSelect.innerHTML = '<option value="-1">Aucun sous-titre intégré</option>';
                subStatus.innerText = "";
                return;
            }

            subTracks.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.index;
                opt.textContent = t.label;
                subSelect.appendChild(opt);
            });

            const optOff = document.createElement('option');
            optOff.value = "-1";
            optOff.textContent = "Désactiver les sous-titres";
            subSelect.appendChild(optOff);

            let chosenIndex = info.subIndex !== null ? info.subIndex : 0;
            if (type === 'vf' && info.frAudioIndex !== null && currentActiveAudioIndex === null) {
                chosenIndex = -1;
            }
            // Après un nouvel essai, respecter un choix fait à la main entre-temps
            if (isProbeRetry && userPickedSubTrack && subPickedBeforeRetry !== null
                && subTracks.some(t => String(t.index) === subPickedBeforeRetry || subPickedBeforeRetry === '-1')) {
                chosenIndex = parseInt(subPickedBeforeRetry, 10);
            }

            subSelect.value = chosenIndex;
            if (chosenIndex !== -1) {
                streamSubtitlesLive(magnet, chosenIndex, fileIndex, seekOffset);
            } else {
                subStatus.innerText = "Sous-titres désactivés";
                document.getElementById('toggleSubBtn').innerText = "CC OFF";
                document.getElementById('toggleSubBtn').style.background = "#555";
            }
        } catch (err) {
            subSelect.innerHTML = '<option value="0">Sous-titre 1 (Auto)</option><option value="-1">Désactivés</option>';
            streamSubtitlesLive(magnet, 0, fileIndex, seekOffset);
        }
    }

    async function streamSubtitlesLive(magnet, subIndex, fileIndex = 1, seekOffset = 0) {
        const subKey = `${magnet}_f${fileIndex}_s${subIndex}`;
        currentActualStartOffset = parseFloat(seekOffset) || 0;

        // Si cette piste est déjà active ou en cours de streaming pour ce fichier
        if (subKey === currentLoadedSubKey) {
            const effOffset = currentActualStartOffset - currentManualSubOffset;
            if (isLibassActive() && jassubInstance) {
                jassubInstance.timeOffset = effOffset;
                safeJassubRender(true);
            } else {
                applySubtitleCuesToTrack(currentActualStartOffset);
            }
            return;
        }

        if (currentSubAbort) {
            currentSubAbort.abort();
        }
        currentSubAbort = new AbortController();

        currentLoadedSubKey = subKey;
        cachedEpisodeCues = [];

        const subStatus = document.getElementById('sub-status');
        const toggleBtn = document.getElementById('toggleSubBtn');

        if (toggleBtn) {
            toggleBtn.innerText = "CC ON";
            toggleBtn.style.background = "var(--primary)";
        }

        const signsIndex = findCompanionSignsTrack(subIndex);
        if (signsIndex !== null) {
            console.log(`[Sous-titres] Piste panneaux compagnon détectée (piste ${signsIndex}), fusion avec la piste ${subIndex}`);
        }
        const buildSubUrl = (idx, format) => '/api/subtitles?magnet=' + encodeURIComponent(magnet) + '&fileIndex=' + fileIndex + '&subIndex=' + idx + '&format=' + format;

        // Lit un flux texte et transmet uniquement des lignes complètes (jamais une réplique coupée au milieu d'une balise)
        async function readTextLines(url, signal, onLines) {
            const response = await fetch(url, { signal, cache: 'no-cache' });
            if (!response.ok || !response.body) throw new Error("HTTP " + response.status);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let lineBuffer = "";
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });
                if (!chunk) continue;
                lineBuffer += chunk;
                const lastNewlineIdx = lineBuffer.lastIndexOf('\n');
                if (lastNewlineIdx === -1) continue;
                const readyChunk = lineBuffer.substring(0, lastNewlineIdx + 1);
                lineBuffer = lineBuffer.substring(lastNewlineIdx + 1);
                await onLines(readyChunk);
            }
            const tail = lineBuffer + decoder.decode();
            if (tail.trim().length > 0) await onLines(tail + '\n');
        }

        // --- MODE 1 : LIBASS WASM (JASSUB) HAUTE DÉFINITION (STREAMING TEMPS RÉEL) ---
        if (isLibassActive() && typeof window.JASSUB !== 'undefined') {
            subStatus.innerText = "⏳ Chargement des sous-titres HD (libass)...";
            subStatus.style.color = "#ffa033";
            loadEmbeddedFonts(magnet, fileIndex);

            const streamSignal = currentSubAbort.signal;
            let fullAssContent = "";
            let signsAssContent = "";
            let jassubInitialized = false;
            let lastTrackUpdateTime = 0;
            let dlgCount = 0;
            let signsCount = 0;
            let appliedCount = 0;
            let trackUpdateTimer = null;
            let trackUpdateInFlight = false;
            const styleUsage = new Map();
            const totalCount = () => dlgCount + signsCount;

            const ensureEventsSection = (txt) => txt.includes('[Events]')
                ? txt
                : txt + '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

            // Contenu complet à rendre : dialogues + panneaux de la piste compagnon
            const buildMergedAss = () => signsAssContent
                ? mergeSignsIntoAss(ensureEventsSection(fullAssContent), signsAssContent)
                : fullAssContent;

            const updateStatus = () => {
                if (!subStatus || subtitlesHidden) return;
                const modeLabel = currentSubStyle.mode === 'custom' ? 'Personnalisé' : 'Fansub';
                const signsLabel = signsCount > 0 ? ` + ${signsCount} panneaux` : '';
                subStatus.innerText = `✨ Sous-titres HD actifs (${dlgCount} répliques${signsLabel} • ${modeLabel})`;
                subStatus.style.color = "#46d369";
            };

            // Envoie le contenu accumulé au worker libass (au plus toutes les 300 ms au début, puis 1,5 s)
            const pushTrackUpdate = async () => {
                trackUpdateTimer = null;
                if (streamSignal.aborted || trackUpdateInFlight) return;
                if (!jassubInstance || !jassubInstance.renderer) return;
                if (totalCount() === appliedCount) return;
                trackUpdateInFlight = true;
                lastTrackUpdateTime = Date.now();
                appliedCount = totalCount();
                try {
                    const merged = buildMergedAss();
                    currentRawAssContent = merged;
                    const subToRender = currentSubStyle.mode === 'custom'
                        ? applyStyleOverrideToAss(merged, currentSubStyle, styleUsage)
                        : merged;
                    await jassubInstance.renderer.setTrack(subToRender);
                    safeJassubRender(true);
                } catch (e) {}
                trackUpdateInFlight = false;
                updateStatus();
                if (totalCount() !== appliedCount) scheduleTrackUpdate();
            };

            const scheduleTrackUpdate = () => {
                if (!jassubInitialized || trackUpdateTimer || streamSignal.aborted) return;
                const interval = totalCount() < 50 ? 300 : 1500;
                const wait = Math.max(0, interval - (Date.now() - lastTrackUpdateTime));
                trackUpdateTimer = setTimeout(pushTrackUpdate, wait);
            };
            streamSignal.addEventListener('abort', () => clearTimeout(trackUpdateTimer), { once: true });

            // Délai de sécurité : si aucun en-tête ASS n'arrive en 12s, repli sur WebVTT pour cette piste
            const timeoutId = setTimeout(() => {
                if (!jassubInitialized && !streamSignal.aborted) {
                    console.warn("[JASSUB] Délai dépassé (12s), repli automatique sur WebVTT");
                    activateLibassFallback(magnet, subIndex, fileIndex);
                }
            }, 12000);

            // Piste panneaux compagnon : lue en parallèle, une erreur n'affecte jamais les dialogues
            const signsPromise = signsIndex === null ? Promise.resolve() : readTextLines(buildSubUrl(signsIndex, 'ass'), streamSignal, (lines) => {
                signsAssContent += lines;
                signsCount += (lines.match(/^Dialogue\s*:/gim) || []).length;
                scheduleTrackUpdate();
            }).catch(err => {
                if (err.name !== 'AbortError') console.warn("[JASSUB] Piste panneaux indisponible :", err.message);
            });

            try {
                await readTextLines(buildSubUrl(subIndex, 'ass'), streamSignal, async (readyChunk) => {
                    fullAssContent += readyChunk;

                    // Comptage incrémental (uniquement sur le nouveau morceau)
                    dlgCount += (readyChunk.match(/^Dialogue\s*:/gim) || []).length;
                    countDialogueStyles(readyChunk, styleUsage);

                    // Dès que l'en-tête ASS (styles ou events) est reçu, initialiser libass immédiatement
                    if (!jassubInitialized) {
                        const hasStyles = /^\[V4\+? Styles\]/im.test(fullAssContent) && /^Style\s*:/im.test(fullAssContent);
                        const hasEvents = fullAssContent.includes('[Events]');

                        if (hasStyles || hasEvents) {
                            clearTimeout(timeoutId);
                            jassubInitialized = true;
                            appliedCount = totalCount();
                            lastTrackUpdateTime = Date.now();
                            await initOrUpdateJassub(ensureEventsSection(buildMergedAss()));
                            if (streamSignal.aborted) return;
                            // Le contenu reçu pendant l'initialisation sera poussé au prochain cycle
                            if (totalCount() !== appliedCount) scheduleTrackUpdate();
                        }
                    } else if (totalCount() !== appliedCount) {
                        scheduleTrackUpdate();
                    }
                });

                clearTimeout(timeoutId);
                if (streamSignal.aborted) return;

                if (!jassubInitialized && fullAssContent.trim().length > 0) {
                    jassubInitialized = true;
                    appliedCount = totalCount();
                    await initOrUpdateJassub(ensureEventsSection(buildMergedAss()));
                }

                // Attendre la fin de la piste panneaux, puis pousser la version finale complète
                await signsPromise;
                clearTimeout(trackUpdateTimer);
                trackUpdateTimer = null;
                if (streamSignal.aborted) return;
                currentRawAssContent = buildMergedAss();
                if (jassubInstance && jassubInstance.renderer) {
                    while (trackUpdateInFlight) await new Promise(r => setTimeout(r, 50));
                    appliedCount = -1;
                    await pushTrackUpdate();
                }
                return;
            } catch (err) {
                clearTimeout(timeoutId);
                if (err.name === 'AbortError') return;
                console.warn("[JASSUB] Échec chargement sous-titres ASS, repli sur WebVTT :", err.message);
                // Repli automatique sur WebVTT
            }
        }

        // --- MODE 2 : STREAMING WEBVTT CLASSIQUE (REPLI OU SÉLECTION UTILISATEUR) ---
        subStatus.innerText = "⏳ Chargement des sous-titres WebVTT...";
        subStatus.style.color = "#ffa033";
        applySubtitleCuesToTrack(currentActualStartOffset);

        const seenCues = new Set();
        let lastApplyTime = 0;

        function processVttBlock(block) {
            if (!block) return;
            const lines = block.trim().split('\n');
            for (let i = 0; i < lines.length; i++) {
                const match = lines[i].match(/((?:\d+:)?\d+:\d+\.\d+)\s*-->\s*((?:\d+:)?\d+:\d+\.\d+)(.*)/);
                if (match) {
                    const rawStart = parseVttTime(match[1]);
                    const rawEnd = parseVttTime(match[2]);
                    const settingsStr = (match[3] || '').trim();
                    const rawTextLines = lines.slice(i + 1);
                    const text = cleanSubtitleLines(rawTextLines);

                    if (text && !isNaN(rawStart) && !isNaN(rawEnd) && rawEnd > rawStart) {
                        let isTop = false;
                        let explicitAlign = null;

                        if (settingsStr) {
                            const lineMatch = settingsStr.match(/line:(-?\d+(?:\.\d+)?%?)/);
                            if (lineMatch) {
                                const rawLine = lineMatch[1];
                                const num = parseFloat(rawLine);
                                if (!isNaN(num) && num <= 30 && rawLine.includes('%')) {
                                    isTop = true;
                                } else if (!isNaN(num) && num >= 0 && num <= 4 && !rawLine.includes('%')) {
                                    isTop = true;
                                }
                            }
                            const alignMatch = settingsStr.match(/align:(start|center|end|left|right)/);
                            if (alignMatch) explicitAlign = alignMatch[1];
                        }

                        const cleanPlain = text.replace(/<[^>]*>/g, '').trim();
                        if (!isTop && /^(\[|\()(panneau|texte|titre|pancarte|enseigne|écrit|lettre|message|avis|sign|text|title|screen|traduction|trad)\b/i.test(cleanPlain)) {
                            isTop = true;
                        }

                        const cueKey = (isTop ? 'T_' : 'B_') + rawStart.toFixed(3) + '_' + rawEnd.toFixed(3) + '_' + cleanPlain;

                        if (!seenCues.has(cueKey)) {
                            seenCues.add(cueKey);
                            cachedEpisodeCues.push({
                                rawStart,
                                rawEnd,
                                text,
                                isTop,
                                explicitAlign
                            });
                        }
                    }
                    break;
                }
            }
        }

        // Lit un flux WebVTT bloc par bloc et rafraîchit le TextTrack (au plus toutes les 300 ms)
        async function consumeVttStream(url, signal) {
            let buffer = "";
            await readTextLines(url, signal, (lines) => {
                buffer += lines;
                const blocks = buffer.split(/\n\s*\n/);
                buffer = blocks.pop() || "";
                for (const block of blocks) processVttBlock(block);

                const now = Date.now();
                if (now - lastApplyTime > 300) {
                    lastApplyTime = now;
                    applySubtitleCuesToTrack(currentActualStartOffset);
                }
            });
            if (buffer.trim()) processVttBlock(buffer);
        }

        const vttSignal = currentSubAbort.signal;
        const vttSignsPromise = signsIndex === null ? Promise.resolve() : consumeVttStream(buildSubUrl(signsIndex, 'vtt'), vttSignal)
            .catch(err => {
                if (err.name !== 'AbortError') console.warn("[Sous-titres] Piste panneaux WebVTT indisponible :", err.message);
            });

        try {
            await consumeVttStream(buildSubUrl(subIndex, 'vtt'), vttSignal);
            await vttSignsPromise;
            if (vttSignal.aborted) return;
            applySubtitleCuesToTrack(currentActualStartOffset);
        } catch (err) {
            if (err.name === 'AbortError') return;
            if (/^HTTP /.test(err.message || '')) {
                subStatus.innerText = "⚠️ Sous-titres indisponibles";
                subStatus.style.color = "#ff4444";
                return;
            }
            console.warn("Erreur streaming sous-titres:", err);
            subStatus.innerText = "";
        }
    }

    function toggleSubtitles() {
        const btn = document.getElementById('toggleSubBtn');
        const customCc = document.getElementById('customCcBadge');
        const subStatus = document.getElementById('sub-status');
        const subCanvas = document.querySelector('canvas.JASSUB');

        let isCurrentlyVisible = false;
        if (isLibassActive() && jassubInstance && subCanvas) {
            isCurrentlyVisible = !subtitlesHidden;
        } else if (currentTextTrack) {
            isCurrentlyVisible = currentTextTrack.mode === 'showing';
        }

        if (isCurrentlyVisible) {
            subtitlesHidden = true;
            if (currentTextTrack) currentTextTrack.mode = 'hidden';
            applyJassubCanvasVisibility();
            if (btn) { btn.innerText = "CC OFF"; btn.style.background = "#555"; }
            if (customCc) customCc.style.opacity = '0.4';
            if (subStatus) subStatus.innerText = "Sous-titres masqués";
            showToast("Sous-titres masqués");
        } else {
            subtitlesHidden = false;
            if (currentTextTrack && !isLibassActive()) currentTextTrack.mode = 'showing';
            applyJassubCanvasVisibility();
            if (btn) { btn.innerText = "CC ON"; btn.style.background = "var(--primary)"; }
            if (customCc) customCc.style.opacity = '1';
            if (subStatus) subStatus.innerText = "Sous-titres affichés";
            showToast("Sous-titres affichés");
        }
    }

    function onSubtitleChange(val) {
        const subIndex = parseInt(val, 10);
        userPickedSubTrack = true;
        const btn = document.getElementById('toggleSubBtn');
        const subStatus = document.getElementById('sub-status');
        const subCanvas = document.querySelector('canvas.JASSUB');

        if (subIndex === -1) {
            if (currentSubAbort) currentSubAbort.abort();
            if (currentTextTrack) currentTextTrack.mode = 'hidden';
            destroyJassub();
            currentLoadedSubKey = null;
            btn.innerText = "CC OFF";
            btn.style.background = "#555";
            subStatus.innerText = "Sous-titres désactivés";
            showToast("Sous-titres désactivés");
        } else {
            btn.innerText = "CC ON";
            btn.style.background = "var(--primary)";
            subtitlesHidden = false;
            libassFallbackActive = false; // nouvelle piste : retenter libass
            destroyJassub();
            currentLoadedSubKey = null; // Forcer le rechargement de la nouvelle piste
            if (currentActiveMagnet) {
                streamSubtitlesLive(currentActiveMagnet, subIndex, currentActiveFileIndex, currentStreamOffset);
            }
        }
    }

