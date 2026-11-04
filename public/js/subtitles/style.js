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
