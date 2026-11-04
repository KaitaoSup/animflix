    // --- PISTE « PANNEAUX » COMPAGNON ---
    // Beaucoup de releases séparent les dialogues et les panneaux / textes à l'écran (typesetting)
    // dans deux pistes distinctes : « VOSTFR » + « VOSTFR (Panneaux / Forced / Signs) ».
    // Quand la piste choisie ne contient que les dialogues, la piste panneaux est chargée et fusionnée.
    const SIGNS_TRACK_REGEX = /(forced|forc[ée]s?|signs?\b|panneaux?|pancartes?|typeset|incrust|\bts\b|songs?\b|chansons?|karaok)/i;
    const FULL_TRACK_REGEX = /(full|complets?|int[ée]gral|\btout\b|\ball\b)/i;
    const SIGNS_STYLE_PREFIX = 'zsigns_';

    function isSignsTrack(t) {
        return !!t && (t.forced === true || SIGNS_TRACK_REGEX.test(t.label || ''));
    }

    // Renvoie l'index de la piste panneaux à fusionner avec `subIndex`, ou null
    function findCompanionSignsTrack(subIndex) {
        const tracks = currentSubTracks || [];
        const chosen = tracks.find(t => t.index === subIndex);
        if (!chosen || isSignsTrack(chosen) || FULL_TRACK_REGEX.test(chosen.label || '')) return null;
        const textCodecs = ['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text', ''];
        if (!textCodecs.includes(chosen.codec || '')) return null;

        const sameLang = (t) => t.lang === chosen.lang || t.lang === 'und' || chosen.lang === 'und'
            || (!!t.isFrench && !!chosen.isFrench);
        const candidates = tracks.filter(t => t.index !== subIndex && isSignsTrack(t)
            && textCodecs.includes(t.codec || '') && sameLang(t));
        if (candidates.length === 0) return null;
        // Préférer une piste ASS de même langue explicite
        candidates.sort((a, b) => {
            const score = (t) => (t.lang === chosen.lang ? 2 : 0) + ((t.codec === 'ass' || t.codec === 'ssa') ? 1 : 0);
            return score(b) - score(a);
        });
        return candidates[0].index;
    }

    // Découpe un fichier ASS : styles (avec leur Format), événements (avec leur Format), PlayRes
    function parseAssForMerge(assText) {
        const result = { styleFormat: null, styles: [], eventFormat: null, events: [], playResX: null, playResY: null };
        let section = '';
        for (const rawLine of assText.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            if (/^\[.*\]$/.test(line)) { section = line.toLowerCase(); continue; }
            if (section === '[script info]') {
                const m = line.match(/^PlayRes([XY])\s*:\s*(\d+)/i);
                if (m) result[m[1].toUpperCase() === 'X' ? 'playResX' : 'playResY'] = parseInt(m[2], 10);
            } else if (/^\[v4\+?\s*styles\]$/.test(section)) {
                if (/^format\s*:/i.test(line)) result.styleFormat = line.replace(/^format\s*:/i, '').split(',').map(f => f.trim().toLowerCase());
                else if (/^style\s*:/i.test(line)) result.styles.push(line.replace(/^style\s*:/i, '').split(',').map(v => v.trim()));
            } else if (section === '[events]') {
                if (/^format\s*:/i.test(line)) result.eventFormat = line.replace(/^format\s*:/i, '').split(',').map(f => f.trim().toLowerCase());
                else if (/^dialogue\s*:/i.test(line)) result.events.push(line.replace(/^dialogue\s*:\s*/i, ''));
            }
        }
        return result;
    }

    const DEFAULT_ASS_EVENT_FORMAT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];

    function splitAssEvent(rest, fieldCount) {
        const fields = [];
        let pos = 0;
        for (let i = 0; i < fieldCount - 1; i++) {
            const next = rest.indexOf(',', pos);
            if (next === -1) return null;
            fields.push(rest.substring(pos, next));
            pos = next + 1;
        }
        fields.push(rest.substring(pos));
        return fields;
    }

    // Clé de déduplication d'une réplique (début, fin, texte) indépendante du style
    function assEventKey(fields, format) {
        const get = (name) => (fields[format.indexOf(name)] || '').trim();
        return get('start') + '|' + get('end') + '|' + get('text');
    }

    // Fusionne les styles et répliques de la piste panneaux dans la piste de dialogues.
    // Les styles importés sont préfixés pour éviter toute collision (ex: deux styles "Default" différents)
    // et ne sont jamais touchés par le mode « style personnalisé ».
    function mergeSignsIntoAss(mainAss, signsAss) {
        if (!mainAss || !signsAss || !/^Dialogue\s*:/im.test(signsAss)) return mainAss;
        const signs = parseAssForMerge(signsAss);
        if (signs.events.length === 0) return mainAss;
        const main = parseAssForMerge(mainAss);

        if (signs.playResY && main.playResY && signs.playResY !== main.playResY && !mergeSignsIntoAss._warned) {
            mergeSignsIntoAss._warned = true;
            console.warn(`[Sous-titres] PlayResY différent entre dialogues (${main.playResY}) et panneaux (${signs.playResY}) : positions approximatives`);
        }

        // Styles : remappés sur le Format de la piste principale
        const mainStyleFormat = main.styleFormat || DEFAULT_ASS_STYLE_FORMAT.map(f => f.toLowerCase());
        const signsStyleFormat = signs.styleFormat || DEFAULT_ASS_STYLE_FORMAT.map(f => f.toLowerCase());
        const signsStyleNames = new Set();
        const styleLines = [];
        for (const values of signs.styles) {
            const nameIdx = signsStyleFormat.indexOf('name');
            const name = (values[nameIdx >= 0 ? nameIdx : 0] || 'Default').replace(/^\*/, '');
            signsStyleNames.add(name.toLowerCase());
            const mapped = mainStyleFormat.map(field => {
                if (field === 'name') return SIGNS_STYLE_PREFIX + name;
                const idx = signsStyleFormat.indexOf(field);
                return idx >= 0 && values[idx] !== undefined ? values[idx] : '0';
            });
            styleLines.push('Style: ' + mapped.join(','));
        }

        // Répliques : remappées sur le Format d'événements principal, sans doublons
        const mainEventFormat = main.eventFormat || DEFAULT_ASS_EVENT_FORMAT;
        const signsEventFormat = signs.eventFormat || DEFAULT_ASS_EVENT_FORMAT;
        const existing = new Set();
        for (const ev of main.events) {
            const f = splitAssEvent(ev, mainEventFormat.length);
            if (f) existing.add(assEventKey(f, mainEventFormat));
        }
        const eventLines = [];
        for (const ev of signs.events) {
            const f = splitAssEvent(ev, signsEventFormat.length);
            if (!f) continue;
            const key = assEventKey(f, signsEventFormat);
            if (existing.has(key)) continue;
            existing.add(key);
            const mapped = mainEventFormat.map(field => {
                const idx = signsEventFormat.indexOf(field);
                let val = idx >= 0 && f[idx] !== undefined ? f[idx] : (field === 'text' ? '' : '0');
                if (field === 'style') {
                    const styleName = val.trim().replace(/^\*/, '');
                    if (signsStyleNames.has(styleName.toLowerCase())) val = SIGNS_STYLE_PREFIX + styleName;
                } else if (field !== 'text') {
                    val = val.trim();
                }
                return val;
            });
            eventLines.push('Dialogue: ' + mapped.join(','));
        }
        if (eventLines.length === 0) return mainAss;

        // Insertion des styles à la fin de la section [V4+ Styles] (ou création de la section)
        let merged = mainAss;
        if (styleLines.length > 0) {
            const stylesHeader = merged.match(/^\[V4\+?\s*Styles\][^\n]*\n/im);
            if (stylesHeader) {
                const sectionStart = stylesHeader.index + stylesHeader[0].length;
                const nextSection = merged.slice(sectionStart).search(/^\[/m);
                let insertAt = nextSection === -1 ? merged.length : sectionStart + nextSection;
                // Reculer avant les lignes vides séparant les sections
                while (insertAt > sectionStart && /\s/.test(merged[insertAt - 1])) insertAt--;
                merged = merged.slice(0, insertAt) + '\n' + styleLines.join('\n') + merged.slice(insertAt);
            } else {
                const block = '[V4+ Styles]\nFormat: ' + DEFAULT_ASS_STYLE_FORMAT.join(', ') + '\n' + styleLines.join('\n') + '\n\n';
                const eventsIdx = merged.search(/^\[Events\]/im);
                merged = eventsIdx === -1 ? merged + '\n' + block : merged.slice(0, eventsIdx) + block + merged.slice(eventsIdx);
            }
        }

        // Ajout des répliques en fin de section [Events]
        if (!/^\[Events\]/im.test(merged)) {
            merged += '\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
        }
        if (!merged.endsWith('\n')) merged += '\n';
        return merged + eventLines.join('\n') + '\n';
    }

