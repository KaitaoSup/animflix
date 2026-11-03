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

    // --- GESTION DES SOUS-TITRES DIRECTS WEBVTT (MODE REPLI OU CLASSIQUE) ---
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

    // Déclenchement sécurisé du rendu JASSUB (libass) sans risque de TypeError
    function safeJassubRender(repaint = false) {
        if (!jassubInstance) return;
        try {
            const video = document.getElementById('videoPlayer');
            const data = jassubInstance._lastDemandTime || {
                mediaTime: video ? (video.currentTime || 0) : 0,
                width: video ? (video.videoWidth || 1920) : 1920,
                height: video ? (video.videoHeight || 1080) : 1080
            };
            if (typeof jassubInstance.manualRender === 'function') {
                jassubInstance.manualRender(data, repaint);
            }
        } catch (e) {
            console.warn("[JASSUB] Erreur render:", e);
        }
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

        // Si le moteur libass (JASSUB) est actif, synchroniser timeOffset et désactiver le TextTrack natif
        if (isLibassActive() && jassubInstance) {
            if (currentTextTrack) {
                try { currentTextTrack.mode = 'disabled'; } catch (e) {}
            }
            if (video.textTracks) {
                for (let i = 0; i < video.textTracks.length; i++) {
                    try { video.textTracks[i].mode = 'disabled'; } catch (e) {}
                }
            }
            const effOffset = currentActualStartOffset - currentManualSubOffset;
            jassubInstance.timeOffset = effOffset;
            safeJassubRender(true);
            return;
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
        if (currentTextTrack.cues && currentTextTrack.cues.length > 0) {
            const oldCues = Array.from(currentTextTrack.cues);
            for (let i = 0; i < oldCues.length; i++) {
                try {
                    currentTextTrack.removeCue(oldCues[i]);
                } catch (e) {}
            }
        }

        if (isSubDisabled) return;

        const effOffset = currentActualStartOffset - currentManualSubOffset;
        let cueCount = 0;

        const posVal = currentSubStyle.position || '85';
        const isAuto = posVal === 'auto';
        const baseLine = isAuto ? 85 : parseFloat(posVal);

        // Préparer les répliques avec l'offset temporel actif
        const validCues = [];
        for (let i = 0; i < cachedEpisodeCues.length; i++) {
            const item = cachedEpisodeCues[i];
            const rawStart = item.rawStart - effOffset;
            const rawEnd = item.rawEnd - effOffset;
            const start = Math.max(0, Math.round(rawStart * 1000) / 1000);
            const end = Math.round(rawEnd * 1000) / 1000;

            if (!isNaN(start) && !isNaN(end) && end > start) {
                validCues.push({
                    start,
                    end,
                    text: item.text,
                    isTop: !!item.isTop,
                    explicitAlign: item.explicitAlign || null
                });
            }
        }

        // Traite un groupe (Haut ou Bas) par segmentation temporelle pour fusionner
        // proprement les sous-titres simultanés et éliminer toute superposition ou perte.
        function processCueGroup(groupCues, isTop) {
            if (groupCues.length === 0) return [];

            const sorted = groupCues.slice().sort((a, b) => a.start - b.start || a.end - b.end);

            // 1. Lisser les micro-chevauchements consécutifs (< 200ms) pour éviter les scintillements
            for (let i = 0; i < sorted.length - 1; i++) {
                const cur = sorted[i];
                const next = sorted[i + 1];
                if (next.start > cur.start && next.start < cur.end && (cur.end - next.start) <= 0.20) {
                    cur.end = next.start;
                }
            }

            // 2. Extraire tous les points temporels charnières
            const timeSet = new Set();
            for (let i = 0; i < sorted.length; i++) {
                const c = sorted[i];
                if (c.end > c.start) {
                    timeSet.add(c.start);
                    timeSet.add(c.end);
                }
            }
            const times = Array.from(timeSet).sort((a, b) => a - b);
            const segments = [];

            let startIdx = 0;
            for (let t = 0; t < times.length - 1; t++) {
                const segStart = times[t];
                const segEnd = times[t + 1];
                if (segEnd - segStart < 0.01) continue;

                while (startIdx < sorted.length && sorted[startIdx].end <= segStart) {
                    startIdx++;
                }

                const texts = [];
                const seen = new Set();
                let explicitAlign = null;

                for (let i = startIdx; i < sorted.length; i++) {
                    const c = sorted[i];
                    if (c.start >= segEnd) break;
                    if (c.start <= segStart && c.end >= segEnd) {
                        const clean = c.text.trim();
                        if (clean && !seen.has(clean)) {
                            seen.add(clean);
                            texts.push(clean);
                        }
                        if (c.explicitAlign && !explicitAlign) {
                            explicitAlign = c.explicitAlign;
                        }
                    }
                }

                if (texts.length === 0) continue;

                let combinedText;
                if (texts.length === 1) {
                    combinedText = texts[0];
                } else if (isTop) {
                    combinedText = texts.join('\n');
                } else {
                    const hasSentenceContinuation = texts.some((txt, idx) => idx > 0 && /^[a-zà-ÿ]/.test(txt));
                    if (hasSentenceContinuation) {
                        combinedText = texts.join('\n');
                    } else {
                        combinedText = texts.map(txt => {
                            if (/^[-—–]/.test(txt) || /^[♪♫♩]/.test(txt) || /^(\[|\()/.test(txt)) return txt;
                            return "- " + txt;
                        }).join('\n');
                    }
                }

                if (segments.length > 0) {
                    const prev = segments[segments.length - 1];
                    if (Math.abs(prev.end - segStart) < 0.005 && prev.text === combinedText) {
                        prev.end = segEnd;
                        continue;
                    }
                }

                segments.push({
                    start: segStart,
                    end: segEnd,
                    text: combinedText,
                    isTop,
                    explicitAlign
                });
            }

            return segments;
        }

        const topGroup = validCues.filter(c => c.isTop);
        const bottomGroup = validCues.filter(c => !c.isTop);

        const processedTop = processCueGroup(topGroup, true);
        const processedBottom = processCueGroup(bottomGroup, false);
        const allProcessed = [...processedTop, ...processedBottom];

        for (let i = 0; i < allProcessed.length; i++) {
            const item = allProcessed[i];
            try {
                const cue = new VTTCue(item.start, item.end, item.text);
                cue.size = 100;
                cue.position = 50;
                cue.align = item.explicitAlign || 'center';

                if (item.isTop) {
                    if (isAuto) {
                        cue.snapToLines = true;
                        cue.line = 1;
                    } else {
                        cue.snapToLines = false;
                        cue.line = 8;
                        if ('lineAlign' in cue) cue.lineAlign = 'start';
                    }
                } else {
                    if (isAuto) {
                        cue.snapToLines = true;
                        cue.line = -2;
                    } else {
                        cue.snapToLines = false;
                        cue.line = baseLine;
                        if ('lineAlign' in cue) cue.lineAlign = 'end';
                    }
                }

                currentTextTrack.addCue(cue);
                cueCount++;
            } catch (e) {
                console.warn("Erreur ajout réplique VTTCue:", e);
            }
        }

        const subStatus = document.getElementById('sub-status');
        if (subStatus) {
            if (cueCount > 0) {
                const offsetLabel = currentManualSubOffset !== 0 
                    ? ` [Sync: ${currentManualSubOffset > 0 ? '+' : ''}${currentManualSubOffset.toFixed(1)}s]` 
                    : '';
                subStatus.innerText = `✅ Sous-titres synchronisés (${cachedEpisodeCues.length} répliques)${offsetLabel}`;
                subStatus.style.color = "#46d369";
            } else if (cachedEpisodeCues.length > 0) {
                subStatus.innerText = "Sous-titres prêts pour la suite de la lecture";
                subStatus.style.color = "#aaa";
            }
        }
    }

    // Conversion hex CSS vers couleur BGR ASS (&HAABBGGRR&)
    function hexToAssBgrColor(hex, alphaHex = '00') {
        let r = 'ff', g = 'ff', b = 'ff';
        if (!hex) return `&H${alphaHex}FFFFFF&`;
        const cleanHex = hex.trim();
        if (cleanHex.startsWith('#')) {
            const raw = cleanHex.slice(1);
            if (raw.length === 3) {
                r = raw[0] + raw[0];
                g = raw[1] + raw[1];
                b = raw[2] + raw[2];
            } else if (raw.length >= 6) {
                r = raw.substring(0, 2);
                g = raw.substring(2, 4);
                b = raw.substring(4, 6);
            }
        } else if (cleanHex.startsWith('rgb')) {
            const m = cleanHex.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            if (m) {
                r = parseInt(m[1], 10).toString(16).padStart(2, '0');
                g = parseInt(m[2], 10).toString(16).padStart(2, '0');
                b = parseInt(m[3], 10).toString(16).padStart(2, '0');
            }
        }
        return `&H${alphaHex}${b}${g}${r}&`.toUpperCase();
    }

    // Compte le nombre de répliques par style (champ Style des lignes Dialogue)
    function countDialogueStyles(assText, usage = new Map()) {
        if (!assText) return usage;
        const re = /^Dialogue\s*:\s*[^,]*,[^,]*,[^,]*,([^,]*),/gim;
        let m;
        while ((m = re.exec(assText)) !== null) {
            const name = m[1].trim().replace(/^\*/, '').toLowerCase();
            usage.set(name, (usage.get(name) || 0) + 1);
        }
        return usage;
    }

    const DEFAULT_ASS_STYLE_FORMAT = ['Name', 'Fontname', 'Fontsize', 'PrimaryColour', 'SecondaryColour', 'OutlineColour', 'BackColour',
        'Bold', 'Italic', 'Underline', 'StrikeOut', 'ScaleX', 'ScaleY', 'Spacing', 'Angle', 'BorderStyle', 'Outline', 'Shadow',
        'Alignment', 'MarginL', 'MarginR', 'MarginV', 'Encoding'];

    // Applique les préférences de style (taille, couleur, police, position) à un fichier ASS.
    // Seul l'en-tête (avant [Events]) est réécrit : coût constant même sur un gros fichier en streaming.
    // styleUsage (optionnel) : Map nomDeStyle(minuscule) -> nombre de répliques, pour repérer les styles de dialogue.
    function applyStyleOverrideToAss(rawAss, style, styleUsage = null) {
        if (!rawAss || typeof rawAss !== 'string') return rawAss;

        const eventsIdx = rawAss.search(/^\[Events\]/im);
        const header = eventsIdx === -1 ? rawAss : rawAss.slice(0, eventsIdx);
        const events = eventsIdx === -1 ? '' : rawAss.slice(eventsIdx);
        const usage = styleUsage || countDialogueStyles(events);

        // 1. Détection de PlayResY pour dimensionnement relatif exact
        let playResY = 1080;
        const playResMatch = header.match(/PlayResY\s*:\s*(\d+)/i);
        if (playResMatch) {
            const parsed = parseInt(playResMatch[1], 10);
            if (!isNaN(parsed) && parsed > 0) playResY = parsed;
        } else if (!/PlayResX/i.test(header)) {
            playResY = 288; // valeur implicite de libass sans PlayRes
        }

        // 2. Calcul proportionnel de la taille de police
        let fontSize = Math.round(playResY * 0.062);
        if (style.size === '1.0rem') fontSize = Math.round(playResY * 0.048);
        else if (style.size === '1.3rem') fontSize = Math.round(playResY * 0.062);
        else if (style.size === '1.65rem') fontSize = Math.round(playResY * 0.078);
        else if (style.size === '2.0rem') fontSize = Math.round(playResY * 0.096);

        // 3. Calcul de la marge inférieure (hauteur)
        let marginV = Math.round(playResY * 0.15);
        if (style.position === '78') marginV = Math.round(playResY * 0.22);
        else if (style.position === '82') marginV = Math.round(playResY * 0.18);
        else if (style.position === '85') marginV = Math.round(playResY * 0.15);
        else if (style.position === '89') marginV = Math.round(playResY * 0.11);
        else if (style.position === '94') marginV = Math.round(playResY * 0.06);
        else if (style.position === 'auto') marginV = Math.round(playResY * 0.05);

        // 4. Extraction du nom de police principal
        let fontName = 'Arial';
        if (style.font) {
            const parts = style.font.split(',');
            fontName = parts[0].replace(/['"]/g, '').trim() || 'Arial';
        }

        // 5. Couleurs et fond
        const primaryColor = hexToAssBgrColor(style.color, '00');
        let backColor = '&H80000000&';
        let borderStyle = 1;
        if (style.bg === 'transparent') {
            backColor = '&HFF000000&';
        } else if (style.bg && (style.bg.includes('0.95') || style.bg.includes('opaque'))) {
            borderStyle = 3;
            backColor = '&H00000000&';
        }

        // 6. Contour et ombrage
        let outline = 2.5;
        let shadow = 2.0;
        if (style.shadow === 'outline') { outline = 3.5; shadow = 0; }
        else if (style.shadow === 'shadow') { outline = 2.2; shadow = 2.8; }
        else if (style.shadow === 'light') { outline = 1.2; shadow = 1.0; }
        else if (style.shadow === 'none') { outline = 0; shadow = 0; }

        const overrides = {
            fontname: fontName, fontsize: fontSize, primarycolour: primaryColor, secondarycolour: '&H000000FF&',
            outlinecolour: '&H00000000&', tertiarycolour: '&H00000000&', backcolour: backColor,
            bold: -1, underline: 0, strikeout: 0, scalex: 100, scaley: 100, spacing: 0, angle: 0,
            borderstyle: borderStyle, outline, shadow, alignment: 2, marginl: 30, marginr: 30, marginv: marginV,
            alphalevel: 0, encoding: 1
        };

        // Construit une ligne Style en respectant l'ordre des champs déclaré par la ligne Format du fichier
        // (l'italique d'origine est conservé, ex: style "Italique" / pensées)
        function buildCustomStyleLine(formatFields, originalValues) {
            const values = formatFields.map((field, idx) => {
                const key = field.toLowerCase();
                if (key === 'name') return originalValues ? originalValues[idx] : 'Default';
                if (key === 'italic') return originalValues ? originalValues[idx] : 0;
                return key in overrides ? overrides[key] : (originalValues ? originalValues[idx] : 0);
            });
            return 'Style: ' + values.join(',');
        }

        // Styles de dialogue : nom évocateur, ou style très utilisé (≥ 15 % des répliques, ou le plus utilisé)
        const totalDialogues = [...usage.values()].reduce((a, b) => a + b, 0);
        let topStyle = null;
        let topCount = 0;
        for (const [name, count] of usage) {
            if (count > topCount) { topStyle = name; topCount = count; }
        }
        const dialogueNameRegex = /(default|main|dialog|dial|texte|normal|vostfr|subtitle|french|italique|italic|flashback|narrat|pens[ée]e|thought)/i;
        const signNameRegex = /(sign|panneau|titre|title|kara|song|lyric|romaji|logo|credit)|(^|[\s_\-])(ts|op|ed|note)([\s_\-\d]|$)/i;
        const isDialogueStyle = (name) => {
            const key = name.trim().replace(/^\*/, '').toLowerCase();
            const count = usage.get(key) || 0;
            if (key === topStyle) return true;
            if (signNameRegex.test(key)) return false; // panneaux, karaokés, titres : jamais restylés
            if (totalDialogues > 0 && count / totalDialogues >= 0.15) return true;
            return dialogueNameRegex.test(key);
        };

        const lines = header.split(/\r?\n/);
        let inStyles = false;
        let formatFields = DEFAULT_ASS_STYLE_FORMAT;
        let replacedAny = false;
        let stylesEndIdx = -1;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (/^\[v4\+?\s*styles\]/i.test(line)) {
                inStyles = true;
                continue;
            }
            if (/^\[.*\]/.test(line)) {
                if (inStyles) stylesEndIdx = i;
                inStyles = false;
                continue;
            }
            if (!inStyles) continue;

            if (/^format\s*:/i.test(line)) {
                formatFields = line.replace(/^format\s*:/i, '').split(',').map(f => f.trim()).filter(Boolean);
            } else if (/^style\s*:/i.test(line)) {
                const values = line.replace(/^style\s*:/i, '').split(',').map(v => v.trim());
                const nameIdx = formatFields.findIndex(f => f.toLowerCase() === 'name');
                const name = values[nameIdx >= 0 ? nameIdx : 0] || '';
                if (values.length === formatFields.length && isDialogueStyle(name)) {
                    lines[i] = buildCustomStyleLine(formatFields, values);
                    replacedAny = true;
                }
            }
        }

        // Aucun style de dialogue reconnu : ajouter/forcer un style "Default" en fin de section
        if (!replacedAny) {
            const insertAt = stylesEndIdx !== -1 ? stylesEndIdx : lines.length;
            lines.splice(insertAt, 0, buildCustomStyleLine(formatFields, null));
        }

        let newHeader = lines.join('\n');
        if (events && !newHeader.endsWith('\n')) newHeader += '\n';
        return newHeader + events;
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

        // --- MODE 1 : LIBASS WASM (JASSUB) HAUTE DÉFINITION (STREAMING TEMPS RÉEL) ---
        if (isLibassActive() && typeof window.JASSUB !== 'undefined') {
            subStatus.innerText = "⏳ Chargement des sous-titres HD (libass)...";
            subStatus.style.color = "#ffa033";

            try {
                const subUrl = '/api/subtitles?magnet=' + encodeURIComponent(magnet) + '&fileIndex=' + fileIndex + '&subIndex=' + subIndex + '&format=ass';
                const response = await fetch(subUrl, { signal: currentSubAbort.signal });
                if (!response.ok || !response.body) {
                    throw new Error("HTTP " + response.status);
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                const streamSignal = currentSubAbort.signal;
                let lineBuffer = "";
                let fullAssContent = "";
                let jassubInitialized = false;
                let lastTrackUpdateTime = 0;
                let dlgCount = 0;
                let appliedDialogueCount = 0;
                let trackUpdateTimer = null;
                let trackUpdateInFlight = false;
                const styleUsage = new Map();

                const ensureEventsSection = (txt) => txt.includes('[Events]')
                    ? txt
                    : txt + '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

                const updateStatus = () => {
                    if (!subStatus || subtitlesHidden) return;
                    const modeLabel = currentSubStyle.mode === 'custom' ? 'Personnalisé' : 'Fansub';
                    subStatus.innerText = `✨ Sous-titres HD actifs (${dlgCount} répliques • ${modeLabel})`;
                    subStatus.style.color = "#46d369";
                };

                // Envoie le contenu accumulé au worker libass (au plus toutes les 300 ms au début, puis 1,5 s)
                const pushTrackUpdate = async () => {
                    trackUpdateTimer = null;
                    if (streamSignal.aborted || trackUpdateInFlight) return;
                    if (!jassubInstance || !jassubInstance.renderer) return;
                    if (dlgCount === appliedDialogueCount) return;
                    trackUpdateInFlight = true;
                    lastTrackUpdateTime = Date.now();
                    appliedDialogueCount = dlgCount;
                    try {
                        const subToRender = currentSubStyle.mode === 'custom'
                            ? applyStyleOverrideToAss(fullAssContent, currentSubStyle, styleUsage)
                            : fullAssContent;
                        await jassubInstance.renderer.setTrack(subToRender);
                        safeJassubRender(true);
                    } catch (e) {}
                    trackUpdateInFlight = false;
                    updateStatus();
                    if (dlgCount !== appliedDialogueCount) scheduleTrackUpdate();
                };

                const scheduleTrackUpdate = () => {
                    if (trackUpdateTimer || streamSignal.aborted) return;
                    const interval = dlgCount < 50 ? 300 : 1500;
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

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    if (!chunk) continue;
                    lineBuffer += chunk;

                    // Découpage strict aux sauts de ligne pour ne JAMAIS couper une réplique au milieu d'une balise {\pos(...)}
                    const lastNewlineIdx = lineBuffer.lastIndexOf('\n');
                    if (lastNewlineIdx === -1) continue;

                    const readyChunk = lineBuffer.substring(0, lastNewlineIdx + 1);
                    lineBuffer = lineBuffer.substring(lastNewlineIdx + 1);
                    fullAssContent += readyChunk;
                    currentRawAssContent = fullAssContent;

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
                            appliedDialogueCount = dlgCount;
                            lastTrackUpdateTime = Date.now();
                            await initOrUpdateJassub(ensureEventsSection(fullAssContent));
                            if (streamSignal.aborted) return;
                            // Le contenu reçu pendant l'initialisation sera poussé au prochain cycle
                            currentRawAssContent = fullAssContent;
                            if (dlgCount !== appliedDialogueCount) scheduleTrackUpdate();
                        }
                    } else if (dlgCount !== appliedDialogueCount) {
                        scheduleTrackUpdate();
                    }
                }

                clearTimeout(timeoutId);
                clearTimeout(trackUpdateTimer);
                trackUpdateTimer = null;
                if (streamSignal.aborted) return;

                // Traiter le reliquat éventuel de la dernière ligne
                const tail = lineBuffer + decoder.decode();
                if (tail.trim().length > 0) {
                    const remaining = tail + '\n';
                    fullAssContent += remaining;
                    dlgCount += (remaining.match(/^Dialogue\s*:/gim) || []).length;
                    countDialogueStyles(remaining, styleUsage);
                }
                currentRawAssContent = fullAssContent;

                if (!jassubInitialized && fullAssContent.trim().length > 0) {
                    await initOrUpdateJassub(ensureEventsSection(fullAssContent));
                } else if (jassubInstance && jassubInstance.renderer) {
                    // Attendre une éventuelle mise à jour en cours, puis pousser la version finale complète
                    while (trackUpdateInFlight) await new Promise(r => setTimeout(r, 50));
                    appliedDialogueCount = -1;
                    await pushTrackUpdate();
                }
                return;
            } catch (err) {
                if (err.name === 'AbortError') return;
                console.warn("[JASSUB] Échec chargement sous-titres ASS, repli sur WebVTT :", err.message);
                // Repli automatique sur WebVTT
            }
        }

        // --- MODE 2 : STREAMING WEBVTT CLASSIQUE (REPLI OU SÉLECTION UTILISATEUR) ---
        subStatus.innerText = "⏳ Chargement des sous-titres WebVTT...";
        subStatus.style.color = "#ffa033";
        applySubtitleCuesToTrack(currentActualStartOffset);

        try {
            const subUrl = '/api/subtitles?magnet=' + encodeURIComponent(magnet) + '&fileIndex=' + fileIndex + '&subIndex=' + subIndex + '&format=vtt';
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

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const blocks = buffer.split(/\n\s*\n/);
                buffer = blocks.pop() || "";

                for (const block of blocks) {
                    processVttBlock(block);
                }

                const now = Date.now();
                if (now - lastApplyTime > 300) {
                    lastApplyTime = now;
                    applySubtitleCuesToTrack(currentActualStartOffset);
                }
            }

            if (buffer.trim()) {
                processVttBlock(buffer);
                buffer = "";
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

    // --- STYLE ET PERSONNALISATION DES SOUS-TITRES ---
    const defaultSubStyle = {
        renderer: 'libass', // 'libass' (libass WebAssembly) ou 'vtt' (WebVTT classique)
        mode: 'original',   // 'original' (Styles & polices de la team fansub) ou 'custom' (Style personnalisé)
        size: '1.3rem',
        color: '#ffffff',
        bg: 'rgba(0, 0, 0, 0.75)',
        shadow: 'shadow',
        font: '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
        layout: 'compact',
        position: '85' // Élévation en hauteur par défaut (15% au-dessus du bas de l'écran)
    };

    let currentSubStyle = { ...defaultSubStyle };

    function cleanSubtitleLines(rawLines) {
        if (!rawLines || rawLines.length === 0) return "";
        if (currentSubStyle.layout === 'original' || rawLines.length === 1) {
            return rawLines.map(l => l.replace(/\\h/gi, ' ').replace(/\\N/gi, '\n')).join('\n').trim();
        }

        const result = [];
        for (let idx = 0; idx < rawLines.length; idx++) {
            let line = rawLines[idx].trim();
            if (!line) continue;
            line = line.replace(/\\h/gi, ' ').replace(/\\N/gi, ' ');

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

        const rendererEl = document.getElementById('subRendererEngine');
        const modeEl = document.getElementById('subStyleMode');
        const sizeEl = document.getElementById('subStyleSize');
        const colorEl = document.getElementById('subStyleColor');
        const bgEl = document.getElementById('subStyleBg');
        const shadowEl = document.getElementById('subStyleShadow');
        const fontEl = document.getElementById('subStyleFont');
        const layoutEl = document.getElementById('subStyleLayout');
        const positionEl = document.getElementById('subStylePosition');

        if (rendererEl) rendererEl.value = currentSubStyle.renderer || 'libass';
        if (modeEl) modeEl.value = currentSubStyle.mode || 'original';
        if (sizeEl) sizeEl.value = currentSubStyle.size;
        if (colorEl) colorEl.value = currentSubStyle.color;
        if (bgEl) bgEl.value = currentSubStyle.bg;
        if (shadowEl) shadowEl.value = currentSubStyle.shadow;
        if (fontEl) fontEl.value = currentSubStyle.font;
        if (layoutEl) layoutEl.value = currentSubStyle.layout || 'compact';
        if (positionEl) positionEl.value = currentSubStyle.position || '85';

        applySubStyle();
    }

    function updateSubStyle() {
        const rendererEl = document.getElementById('subRendererEngine');
        const modeEl = document.getElementById('subStyleMode');
        const sizeEl = document.getElementById('subStyleSize');
        const colorEl = document.getElementById('subStyleColor');
        const bgEl = document.getElementById('subStyleBg');
        const shadowEl = document.getElementById('subStyleShadow');
        const fontEl = document.getElementById('subStyleFont');
        const layoutEl = document.getElementById('subStyleLayout');
        const positionEl = document.getElementById('subStylePosition');

        const prevRenderer = currentSubStyle.renderer;

        if (rendererEl) currentSubStyle.renderer = rendererEl.value;
        if (modeEl) currentSubStyle.mode = modeEl.value;
        if (sizeEl) currentSubStyle.size = sizeEl.value;
        if (colorEl) currentSubStyle.color = colorEl.value;
        if (bgEl) currentSubStyle.bg = bgEl.value;
        if (shadowEl) currentSubStyle.shadow = shadowEl.value;
        if (fontEl) currentSubStyle.font = fontEl.value;
        if (layoutEl) currentSubStyle.layout = layoutEl.value;
        if (positionEl) currentSubStyle.position = positionEl.value;

        try {
            localStorage.setItem('animflix_sub_style', JSON.stringify(currentSubStyle));
        } catch (e) {}

        applySubStyle();

        // Si le moteur de rendu a changé (passage de libass à vtt ou vice-versa)
        if (prevRenderer !== currentSubStyle.renderer) {
            libassFallbackActive = false;
            destroyJassub();
            const subSelect = document.getElementById('subSelect');
            const chosenIndex = subSelect ? parseInt(subSelect.value, 10) : 0;
            if (chosenIndex !== -1 && currentLoadedSubMagnet) {
                currentLoadedSubKey = null; // forcer le rechargement
                streamSubtitlesLive(currentLoadedSubMagnet, chosenIndex, currentLoadedSubFileIndex, currentActualStartOffset);
            }
            return;
        }

        // Si le moteur libass est actif, réinitialiser le rendu avec le style choisi
        if (isLibassActive() && currentRawAssContent) {
            initOrUpdateJassub();
        } else {
            applySubtitleCuesToTrack();
        }
    }

    function resetSubStyle() {
        currentSubStyle = { ...defaultSubStyle };
        try {
            localStorage.removeItem('animflix_sub_style');
        } catch (e) {}
        loadSavedSubStyle();
        if (isLibassActive() && currentRawAssContent) {
            initOrUpdateJassub();
        } else {
            applySubtitleCuesToTrack();
        }
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
            if (isLibassActive() && currentSubStyle.mode === 'original') {
                preview.style.backgroundColor = 'transparent';
                preview.style.color = '#ffffff';
                preview.style.fontFamily = 'inherit';
                preview.style.fontSize = '1.1rem';
                preview.style.fontWeight = 'bold';
                preview.style.textShadow = '0 2px 4px rgba(0,0,0,0.9), 0 0 6px #000';
                preview.innerHTML = "✨ Style Original Fansub actif<br><small style='font-size: 10px; color: #aaa; font-weight: normal;'>(Polices & couleurs définies par les traducteurs)</small>";
            } else {
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

    // Export global explicite sur window pour l'interaction avec le lecteur et les modules
    window.updateSubtitleOffset = updateSubtitleOffset;
    window.applySubtitleCuesToTrack = applySubtitleCuesToTrack;
    window.setupSubtitles = setupSubtitles;
    window.streamSubtitlesLive = streamSubtitlesLive;
    window.adjustSubtitleSync = adjustSubtitleSync;
    window.resetSubtitleSync = resetSubtitleSync;
    window.toggleSubtitles = toggleSubtitles;
    window.onSubtitleChange = onSubtitleChange;
    window.toggleSubStyleMenu = toggleSubStyleMenu;
