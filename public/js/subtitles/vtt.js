    // --- GESTION DES SOUS-TITRES DIRECTS WEBVTT (MODE REPLI OU CLASSIQUE) ---
    let cachedEpisodeCues = []; // [{ rawStart, rawEnd, text }, ...]
    let currentLoadedSubKey = null; // `${magnet}_f${fileIndex}_s${subIndex}`
    let currentLoadedSubMagnet = null;
    let currentLoadedSubFileIndex = null;
    let currentSubTracks = []; // pistes de sous-titres du fichier courant (réponse /api/streams)
    // Polices embarquées par la team dans le MKV (pièces jointes), transmises à libass
    let currentFontUrls = [];
    let currentFontsKey = null;
    let currentFontsPromise = null;
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
            // Vidéo pas encore chargée : ne rien dessiner. Une taille inventée (1920×1080) ferait croire à
            // JASSUB que le canvas est déjà dimensionné alors qu'il a été calculé sur une vidéo de 0×0 (NaN) :
            // il ne serait jamais redimensionné et les sous-titres resteraient invisibles.
            if (!jassubInstance._lastDemandTime && !(video && video.videoWidth > 0)) return;
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

        // Styles de dialogue : nom évocateur, ou style très utilisé (≥ 15 % des répliques, ou le plus utilisé).
        // Les styles de panneaux / karaokés / génériques (et ceux de la piste panneaux fusionnée) ne sont jamais
        // restylés, même s'ils sont majoritaires (un épisode chargé en typesetting a souvent plus de lignes "signs").
        const dialogueNameRegex = /(default|main|dialog|dial|texte|normal|vostfr|subtitle|french|italique|italic|flashback|narrat|pens[ée]e|thought)/i;
        const signNameRegex = /(sign|panneau|titre|title|kara|song|lyric|romaji|logo|credit)|(^|[\s_\-])(ts|op|ed|note)([\s_\-\d]|$)/i;
        const isSignStyleKey = (key) => key.startsWith(SIGNS_STYLE_PREFIX) || signNameRegex.test(key);
        let totalDialogues = 0;
        let topStyle = null;
        let topCount = 0;
        for (const [name, count] of usage) {
            if (isSignStyleKey(name)) continue;
            totalDialogues += count;
            if (count > topCount) { topStyle = name; topCount = count; }
        }
        const isDialogueStyle = (name) => {
            const key = name.trim().replace(/^\*/, '').toLowerCase();
            if (isSignStyleKey(key)) return false; // panneaux, karaokés, titres : jamais restylés
            const count = usage.get(key) || 0;
            if (key === topStyle) return true;
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

