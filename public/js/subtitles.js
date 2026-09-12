// =========================================================================
// --- ANIMFLIX SUBTITLES (WEBVTT STREAMING, TIME OFFSET & STYLING) ---
// =========================================================================

    // --- GESTION DES SOUS-TITRES DIRECTS WEBVTT ---
    let cachedEpisodeCues = []; // [{ rawStart, rawEnd, text }, ...]
    let currentLoadedSubKey = null; // `${magnet}_f${fileIndex}_s${subIndex}`
    let currentLoadedSubMagnet = null;
    let currentLoadedSubFileIndex = null;
    let currentManualSubOffset = 0.0; // Secondes (ajustable avec raccourcis G / H ou interface)
    let currentActualStartOffset = 0.0;

    function parseVttTime(str) {
        if (!str) return 0;
        const parts = str.trim().split(':');
        if (parts.length === 3) {
            return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
        } else if (parts.length === 2) {
            return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
        }
        return 0;
    }

    // Applique les répliques en mémoire au TextTrack HTML5 avec l'offset exact et décalage manuel
    function applySubtitleCuesToTrack(seekOffset = null) {
        const video = document.getElementById('videoPlayer');
        if (!video) return;

        if (seekOffset !== null && !isNaN(seekOffset)) {
            currentActualStartOffset = parseFloat(seekOffset);
        } else if (typeof currentStreamOffset === 'number' && !isNaN(currentStreamOffset)) {
            currentActualStartOffset = currentStreamOffset;
        }

        const subSelect = document.getElementById('subSelect');
        const isSubDisabled = subSelect && subSelect.value === "-1";

        // Vérifier si currentTextTrack est valide et toujours attaché au lecteur vidéo
        let isTrackValid = false;
        if (currentTextTrack && video.textTracks) {
            for (let i = 0; i < video.textTracks.length; i++) {
                if (video.textTracks[i] === currentTextTrack) {
                    isTrackValid = true;
                    break;
                }
            }
        }

        if (!isTrackValid) {
            for (let i = 0; i < video.textTracks.length; i++) {
                try { video.textTracks[i].mode = 'disabled'; } catch (e) {}
            }
            try {
                currentTextTrack = video.addTextTrack("subtitles", "Animflix WebVTT", "fr");
                currentTextTrack.mode = isSubDisabled ? "hidden" : "showing";
            } catch (e) {
                console.warn("Impossible d'ajouter le TextTrack:", e);
                return;
            }
        } else {
            currentTextTrack.mode = isSubDisabled ? "hidden" : "showing";
        }

        // Vider proprement les anciennes répliques pour éviter les décalages ou conflits
        if (currentTextTrack.cues) {
            while (currentTextTrack.cues.length > 0) {
                try {
                    currentTextTrack.removeCue(currentTextTrack.cues[0]);
                } catch (e) {
                    break;
                }
            }
        }

        if (isSubDisabled) return;

        const effOffset = currentActualStartOffset - currentManualSubOffset;
        let cueCount = 0;

        for (let i = 0; i < cachedEpisodeCues.length; i++) {
            const item = cachedEpisodeCues[i];
            const rawStart = item.rawStart - effOffset;
            const rawEnd = item.rawEnd - effOffset;
            const start = Math.max(0, Math.round(rawStart * 1000) / 1000);
            const end = Math.round(rawEnd * 1000) / 1000;

            if (!isNaN(start) && !isNaN(end) && end > start) {
                try {
                    const cue = new VTTCue(start, end, item.text);
                    cue.size = 100;
                    cue.position = 50;
                    cue.align = 'center';
                    currentTextTrack.addCue(cue);
                    cueCount++;
                } catch (e) {}
            }
        }

        const subStatus = document.getElementById('sub-status');
        if (subStatus) {
            if (cueCount > 0) {
                const offsetLabel = currentManualSubOffset !== 0 
                    ? ` [Sync: ${currentManualSubOffset > 0 ? '+' : ''}${currentManualSubOffset.toFixed(1)}s]` 
                    : '';
                subStatus.innerText = `✅ Sous-titres synchronisés (${cueCount} répliques)${offsetLabel}`;
                subStatus.style.color = "#46d369";
            } else if (cachedEpisodeCues.length > 0) {
                subStatus.innerText = "Sous-titres prêts pour la suite de la lecture";
                subStatus.style.color = "#aaa";
            }
        }
    }

    function resetSubtitlesState() {
        if (currentSubAbort) {
            currentSubAbort.abort();
            currentSubAbort = null;
        }
        currentLoadedSubKey = null;
        currentLoadedSubMagnet = null;
        currentLoadedSubFileIndex = null;
        cachedEpisodeCues = [];
        currentActualStartOffset = 0.0;
        currentManualSubOffset = 0.0;
        currentTextTrack = null;
        const subStatus = document.getElementById('sub-status');
        if (subStatus) subStatus.innerText = "";
    }

    // Réaligne instantanément les sous-titres quand le serveur confirme le point clé réel (keyframe)
    function updateSubtitleOffset(actualStart) {
        currentActualStartOffset = actualStart;
        applySubtitleCuesToTrack(actualStart);
    }

    // Réglage manuel de décalage des sous-titres (accessible via boutons et raccourcis G / H)
    function adjustSubtitleSync(deltaSeconds) {
        currentManualSubOffset = Math.round((currentManualSubOffset + deltaSeconds) * 10) / 10;
        const display = document.getElementById('subSyncDisplay');
        if (display) {
            display.textContent = (currentManualSubOffset >= 0 ? '+' : '') + currentManualSubOffset.toFixed(1) + 's';
        }
        applySubtitleCuesToTrack(currentActualStartOffset);
        showToast(`⏱️ Synchro sous-titres : ${currentManualSubOffset >= 0 ? '+' : ''}${currentManualSubOffset.toFixed(1)}s`);
    }

    function resetSubtitleSync() {
        currentManualSubOffset = 0.0;
        const display = document.getElementById('subSyncDisplay');
        if (display) {
            display.textContent = "0.0s";
        }
        applySubtitleCuesToTrack(currentActualStartOffset);
        showToast("⏱️ Synchronisation réinitialisée (0.0s)");
    }

    async function setupSubtitles(magnet, type, fileIndex = 1, seekOffset = 0) {
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
        subSelect.innerHTML = '<option value="-1">Analyse des pistes... ⏳</option>';
        if (audioSelect) audioSelect.innerHTML = '<option value="">Analyse audio... ⏳</option>';
        subStatus.innerText = "";

        try {
            const res = await fetch('/api/streams?magnet=' + encodeURIComponent(magnet) + '&fileIndex=' + fileIndex);
            const info = await res.json();
            const subTracks = info.subTracks || [];
            const audioTracks = info.audioTracks || [];

            // Récupération de la durée exacte de la vidéo analysée
            if (info && info.duration && info.duration > 0) {
                currentTotalDuration = info.duration;
                const totalLabel = document.getElementById('playerDisplayTotal');
                if (totalLabel) totalLabel.textContent = formatTimestamp(currentTotalDuration);
                updatePlayerProgress();
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
            applySubtitleCuesToTrack(currentActualStartOffset);
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

        subStatus.innerText = "⏳ Chargement des sous-titres...";
        subStatus.style.color = "#ffa033";
        toggleBtn.innerText = "CC ON";
        toggleBtn.style.background = "var(--primary)";

        applySubtitleCuesToTrack(currentActualStartOffset);

        try {
            const subUrl = '/api/subtitles?magnet=' + encodeURIComponent(magnet) + '&fileIndex=' + fileIndex + '&subIndex=' + subIndex;
            const response = await fetch(subUrl, { signal: currentSubAbort.signal });
            if (!response.ok || !response.body) {
                subStatus.innerText = "⚠️ Sous-titres indisponibles";
                subStatus.style.color = "#ff4444";
                return;
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            const seenCues = new Set();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const blocks = buffer.split(/\n\s*\n/);
                buffer = blocks.pop() || "";

                for (const block of blocks) {
                    const lines = block.trim().split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        const match = lines[i].match(/((?:\d+:)?\d+:\d+\.\d+)\s*-->\s*((?:\d+:)?\d+:\d+\.\d+)/);
                        if (match) {
                            const rawStart = parseVttTime(match[1]);
                            const rawEnd = parseVttTime(match[2]);
                            const cueKey = rawStart + '_' + rawEnd;

                            if (!seenCues.has(cueKey)) {
                                seenCues.add(cueKey);
                                const rawTextLines = lines.slice(i + 1);
                                const text = cleanSubtitleLines(rawTextLines);
                                if (text && !isNaN(rawStart) && !isNaN(rawEnd) && rawEnd > rawStart) {
                                    cachedEpisodeCues.push({ rawStart, rawEnd, text });
                                }
                            }
                            break;
                        }
                    }
                }
                // Appliquer les répliques décodées avec le décalage temporel ACTUEL de la vidéo
                applySubtitleCuesToTrack(currentActualStartOffset);
            }

            applySubtitleCuesToTrack(currentActualStartOffset);
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.warn("Erreur streaming sous-titres:", err);
                subStatus.innerText = "";
            }
        }
    }

    function toggleSubtitles() {
        const btn = document.getElementById('toggleSubBtn');
        const customCc = document.getElementById('customCcBadge');
        const subStatus = document.getElementById('sub-status');
        if (!currentTextTrack && cachedEpisodeCues.length > 0) {
            applySubtitleCuesToTrack(currentActualStartOffset);
        }
        if (!currentTextTrack) return;

        if (currentTextTrack.mode === 'showing') {
            currentTextTrack.mode = 'hidden';
            if (btn) { btn.innerText = "CC OFF"; btn.style.background = "#555"; }
            if (customCc) customCc.style.opacity = '0.4';
            if (subStatus) subStatus.innerText = "Sous-titres masqués";
            showToast("Sous-titres masqués");
        } else {
            currentTextTrack.mode = 'showing';
            if (btn) { btn.innerText = "CC ON"; btn.style.background = "var(--primary)"; }
            if (customCc) customCc.style.opacity = '1';
            if (subStatus) subStatus.innerText = "Sous-titres affichés";
            showToast("Sous-titres affichés");
        }
    }

    function onSubtitleChange(val) {
        const subIndex = parseInt(val, 10);
        const btn = document.getElementById('toggleSubBtn');
        const subStatus = document.getElementById('sub-status');

        if (subIndex === -1) {
            if (currentSubAbort) currentSubAbort.abort();
            if (currentTextTrack) currentTextTrack.mode = 'hidden';
            btn.innerText = "CC OFF";
            btn.style.background = "#555";
            subStatus.innerText = "Sous-titres désactivés";
            showToast("Sous-titres désactivés");
        } else {
            btn.innerText = "CC ON";
            btn.style.background = "var(--primary)";
            if (currentActiveMagnet) {
                streamSubtitlesLive(currentActiveMagnet, subIndex, currentActiveFileIndex, currentStreamOffset);
            }
        }
    }

    // --- STYLE ET PERSONNALISATION DES SOUS-TITRES ---
    const defaultSubStyle = {
        size: '1.3rem',
        color: '#ffffff',
        bg: 'rgba(0, 0, 0, 0.75)',
        shadow: 'shadow',
        font: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
        layout: 'compact'
    };

    let currentSubStyle = { ...defaultSubStyle };

    function cleanSubtitleLines(rawLines) {
        if (!rawLines || rawLines.length === 0) return "";
        if (currentSubStyle.layout === 'original' || rawLines.length === 1) {
            return rawLines.map(l => l.replace(/\\h/gi, ' ').replace(/\\N/g, '\n')).join('\n').trim();
        }

        const result = [];
        for (let idx = 0; idx < rawLines.length; idx++) {
            let line = rawLines[idx].trim();
            if (!line) continue;
            line = line.replace(/\\h/gi, ' ').replace(/\\N/g, ' ');

            if (result.length === 0) {
                result.push(line);
                continue;
            }

            const prev = result[result.length - 1];
            const cleanPrev = prev.replace(/<[^>]*>/g, '').trim();
            const cleanCurrent = line.replace(/<[^>]*>/g, '').trim();

            const isDialogue = /^[-—–]/.test(cleanCurrent);
            const prevIsDialogue = /^[-—–]/.test(cleanPrev);
            const isMusic = /^[♪♫♩]/.test(cleanCurrent) || /[♪♫♩]$/.test(cleanPrev);

            if (isDialogue || (prevIsDialogue && !cleanPrev.endsWith(',')) || isMusic) {
                result.push(line);
            } else {
                const combinedClean = cleanPrev + ' ' + cleanCurrent;
                if (combinedClean.length <= 110) {
                    result[result.length - 1] = prev + ' ' + line;
                } else {
                    result.push(line);
                }
            }
        }
        return result.join('\n');
    }

    function loadSavedSubStyle() {
        try {
            const saved = localStorage.getItem('animflix_sub_style');
            if (saved) {
                currentSubStyle = Object.assign({}, defaultSubStyle, JSON.parse(saved));
            }
        } catch (e) {}

        const sizeEl = document.getElementById('subStyleSize');
        const colorEl = document.getElementById('subStyleColor');
        const bgEl = document.getElementById('subStyleBg');
        const shadowEl = document.getElementById('subStyleShadow');
        const fontEl = document.getElementById('subStyleFont');
        const layoutEl = document.getElementById('subStyleLayout');

        if (sizeEl) sizeEl.value = currentSubStyle.size;
        if (colorEl) colorEl.value = currentSubStyle.color;
        if (bgEl) bgEl.value = currentSubStyle.bg;
        if (shadowEl) shadowEl.value = currentSubStyle.shadow;
        if (fontEl) fontEl.value = currentSubStyle.font;
        if (layoutEl) layoutEl.value = currentSubStyle.layout || 'compact';

        applySubStyle();
    }

    function updateSubStyle() {
        const sizeEl = document.getElementById('subStyleSize');
        const colorEl = document.getElementById('subStyleColor');
        const bgEl = document.getElementById('subStyleBg');
        const shadowEl = document.getElementById('subStyleShadow');
        const fontEl = document.getElementById('subStyleFont');
        const layoutEl = document.getElementById('subStyleLayout');

        if (sizeEl) currentSubStyle.size = sizeEl.value;
        if (colorEl) currentSubStyle.color = colorEl.value;
        if (bgEl) currentSubStyle.bg = bgEl.value;
        if (shadowEl) currentSubStyle.shadow = shadowEl.value;
        if (fontEl) currentSubStyle.font = fontEl.value;
        if (layoutEl) currentSubStyle.layout = layoutEl.value;

        try {
            localStorage.setItem('animflix_sub_style', JSON.stringify(currentSubStyle));
        } catch (e) {}

        applySubStyle();
    }

    function resetSubStyle() {
        currentSubStyle = { ...defaultSubStyle };
        try {
            localStorage.removeItem('animflix_sub_style');
        } catch (e) {}
        loadSavedSubStyle();
        showToast("Style des sous-titres réinitialisé");
    }

    function applySubStyle() {
        let shadowCss = '0 2px 4px rgba(0, 0, 0, 0.95), 0 0 8px #000000';
        if (currentSubStyle.shadow === 'outline') {
            shadowCss = '-1.5px -1.5px 0 #000, 1.5px -1.5px 0 #000, -1.5px 1.5px 0 #000, 1.5px 1.5px 0 #000, 0 2px 5px rgba(0,0,0,0.95)';
        } else if (currentSubStyle.shadow === 'light') {
            shadowCss = '0 1px 2px rgba(0,0,0,0.8)';
        } else if (currentSubStyle.shadow === 'none') {
            shadowCss = 'none';
        }

        let styleEl = document.getElementById('dynamic-sub-style');
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'dynamic-sub-style';
            document.head.appendChild(styleEl);
        }

        styleEl.textContent = `
            video::cue {
                background-color: ${currentSubStyle.bg} !important;
                color: ${currentSubStyle.color} !important;
                font-family: ${currentSubStyle.font} !important;
                font-size: ${currentSubStyle.size} !important;
                font-weight: 600 !important;
                line-height: 1.35 !important;
                text-shadow: ${shadowCss} !important;
                padding: 3px 10px !important;
                border-radius: 4px !important;
                white-space: pre-line !important;
                max-width: 96% !important;
                text-align: center !important;
            }
            @media (max-width: 768px) {
                video::cue {
                    font-size: calc(${currentSubStyle.size} * 0.8) !important;
                }
            }
        `;

        const preview = document.getElementById('sub-preview-box');
        if (preview) {
            preview.style.backgroundColor = currentSubStyle.bg;
            preview.style.color = currentSubStyle.color;
            preview.style.fontFamily = currentSubStyle.font;
            preview.style.fontSize = currentSubStyle.size;
            preview.style.fontWeight = "600";
            preview.style.textShadow = shadowCss;
            if (currentSubStyle.layout === 'original') {
                preview.innerHTML = "Sous-titre d'exemple<br>sur deux lignes";
            } else {
                preview.innerHTML = "Sous-titre VOSTFR d'exemple sur une seule ligne";
            }
        }
    }

    function toggleSubStyleMenu(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        const menu = document.getElementById('subStyleMenu');
        if (!menu) return;
        const isVisible = menu.style.display === 'block';
        menu.style.display = isVisible ? 'none' : 'block';
        if (!isVisible) {
            applySubStyle();
        }
    }
