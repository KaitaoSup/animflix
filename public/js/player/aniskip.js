    // --- ANISKIP (DÉTECTION ET SAUT DE L'OPENING, DU RÉCAP, DE L'ENDING ET DE L'APERÇU + MARQUEURS TIMELINE) ---
    let currentAniSkipIntervals = null; // { op?, ed?, recap?, preview? } : { startTime, endTime, source? }
    let isAniSkipLoading = false;
    // Passages déjà sautés dans l'épisode en cours (pas de second saut automatique après un retour en arrière)
    const skippedSegments = new Set();
    // Identifie la requête AniSkip la plus récente et pour quoi les intervalles actuels ont été chargés
    let aniSkipRequestSeq = 0;
    let aniSkipLoadedFor = null; // { epKey, malId, ep }
    // Passages lus dans les chapitres du fichier (réponse /api/streams) : { epKey, intervals }
    let chapterSkipFor = null;

    // Ordre chronologique habituel dans un épisode
    const SKIP_SEGMENTS = [
        { key: 'recap', button: 'Passer le récap', done: 'Récap passé', badge: '⏭️ RÉCAP', marker: 'Récap', color: 'rgba(167, 139, 250, 0.92)' },
        { key: 'op', button: "Passer l'opening", done: 'Opening passé', badge: '⏭️ OPENING', marker: 'Opening', color: 'rgba(245, 158, 11, 0.92)' },
        { key: 'ed', button: "Passer l'ending", done: 'Ending passé', badge: '⏭️ ENDING', marker: 'Ending', color: 'rgba(56, 189, 248, 0.92)' },
        { key: 'preview', button: "Passer l'aperçu", done: 'Aperçu passé', badge: '⏭️ APERÇU', marker: 'Aperçu du prochain épisode', color: 'rgba(52, 211, 153, 0.92)' }
    ];
    const SKIP_SEGMENT_KEYS = SKIP_SEGMENTS.map(s => s.key);

    function skipSourceLabel(interval) {
        return interval && interval.source === 'chapters' ? 'chapitres' : 'AniSkip';
    }

    function isValidSkipInterval(interval) {
        return !!interval && Number.isFinite(interval.startTime) && Number.isFinite(interval.endTime) && interval.endTime > interval.startTime;
    }

    // Passage contenant l'instant t (en secondes), ou null
    function getSkipSegmentAt(t) {
        if (!currentAniSkipIntervals) return null;
        for (const seg of SKIP_SEGMENTS) {
            const interval = currentAniSkipIntervals[seg.key];
            if (isValidSkipInterval(interval) && t >= interval.startTime && t < interval.endTime) return { ...seg, interval };
        }
        return null;
    }
    window.getSkipSegmentAt = getSkipSegmentAt;

    // Nouvel épisode ou reprise au début : les passages pourront de nouveau être sautés
    function resetSkippedSegments() {
        skippedSegments.clear();
    }

    // Les chapitres du fichier priment sur AniSkip : ils décrivent exactement cette release, alors
    // qu'AniSkip donne des temps communautaires qui peuvent être décalés d'une release à l'autre.
    function mergeChapterSkipIntervals() {
        if (!chapterSkipFor || chapterSkipFor.epKey !== window._currentPlayingEpisodeKey) return;
        const chapters = chapterSkipFor.intervals;
        const merged = { ...(currentAniSkipIntervals || {}) };
        for (const key of SKIP_SEGMENT_KEYS) {
            if (chapters[key]) merged[key] = { ...chapters[key], source: 'chapters' };
        }
        currentAniSkipIntervals = merged;
        window.currentAniSkipIntervals = merged;
        renderAniSkipTimelineMarkers();
    }

    // Appelée par subtitles/tracks.js dès que l'analyse du fichier est connue
    function setChapterSkipIntervals(epKey, intervals) {
        if (intervals && SKIP_SEGMENT_KEYS.some(k => intervals[k])) {
            chapterSkipFor = { epKey, intervals };
            mergeChapterSkipIntervals();
        } else if (chapterSkipFor && chapterSkipFor.epKey === epKey) {
            chapterSkipFor = null;
        }
    }
    window.setChapterSkipIntervals = setChapterSkipIntervals;

    // Vrai si les intervalles chargés ne correspondent pas (ou plus) à l'anime / épisode courant
    function aniSkipNeedsRefresh() {
        if (!aniSkipLoadedFor) return true;
        const malId = currentAnilistMedia?.idMal;
        return aniSkipLoadedFor.epKey !== window._currentPlayingEpisodeKey
            || (malId && aniSkipLoadedFor.malId !== malId)
            || aniSkipLoadedFor.ep !== (currentDetectedEpisode || 1);
    }
    window.aniSkipNeedsRefresh = aniSkipNeedsRefresh;

    function renderAniSkipTimelineMarkers() {
        const markersEl = document.getElementById('playerScrubberMarkers');
        if (!markersEl) return;
        markersEl.innerHTML = '';

        if (!currentAniSkipIntervals) return;
        const totalDur = currentTotalDuration > 0 ? currentTotalDuration : 1440;
        if (totalDur <= 0) return;

        for (const seg of SKIP_SEGMENTS) {
            const interval = currentAniSkipIntervals[seg.key];
            if (!isValidSkipInterval(interval)) continue;
            const leftPct = Math.max(0, Math.min(100, (interval.startTime / totalDur) * 100));
            const widthPct = Math.max(0.5, Math.min(100 - leftPct, ((interval.endTime - interval.startTime) / totalDur) * 100));
            const div = document.createElement('div');
            div.className = `scrubber-chapter-marker scrubber-marker-${seg.key}`;
            div.style.left = `${leftPct}%`;
            div.style.width = `${widthPct}%`;
            div.title = `${seg.marker} (${skipSourceLabel(interval)})`;
            markersEl.appendChild(div);
        }
    }
    window.renderAniSkipTimelineMarkers = renderAniSkipTimelineMarkers;

    // Réponse AniSkip v2 -> { op, ed, recap }. « mixed-op / mixed-ed » (générique sur des images de l'épisode)
    // ne servent que s'il n'y a pas de générique classique.
    function parseAniSkipResults(results) {
        const intervals = {};
        const mixed = {};
        for (const r of results || []) {
            if (!r || !r.interval) continue;
            const interval = {
                startTime: Math.max(0, parseFloat(r.interval.startTime) || 0),
                endTime: parseFloat(r.interval.endTime) || 0
            };
            if (!isValidSkipInterval(interval)) continue;
            if (r.skipType === 'op' || r.skipType === 'ed' || r.skipType === 'recap') intervals[r.skipType] = interval;
            else if (r.skipType === 'mixed-op') mixed.op = interval;
            else if (r.skipType === 'mixed-ed') mixed.ed = interval;
        }
        if (!intervals.op && mixed.op) intervals.op = mixed.op;
        if (!intervals.ed && mixed.ed) intervals.ed = mixed.ed;
        return intervals;
    }

    async function checkAniSkipForCurrentEpisode() {
        const seq = ++aniSkipRequestSeq;
        const epKeyAtStart = window._currentPlayingEpisodeKey;
        // Une réponse n'est appliquée que si aucune requête plus récente n'a été lancée et que l'épisode n'a pas changé
        const isStale = () => seq !== aniSkipRequestSeq || window._currentPlayingEpisodeKey !== epKeyAtStart;

        if (aniSkipNeedsRefresh()) {
            currentAniSkipIntervals = null;
            window.currentAniSkipIntervals = null;
            hideAniSkipButton();
            renderAniSkipTimelineMarkers();
        }
        // Chapitres déjà connus pour cet épisode : utilisables tout de suite, sans attendre AniSkip
        mergeChapterSkipIntervals();

        let malId = currentAnilistMedia?.idMal;
        const ep = currentDetectedEpisode || 1;
        const duration = currentTotalDuration || 1440;

        // Si pas encore d'idMal mais que l'on a le titre, tenter une résolution AniList
        if (!malId && currentAnimeItem) {
            const parsed = getAnimeDetails(currentAnimeItem);
            const name = currentAnimeItem.animeName || parsed.animeName || currentAnimeItem.cleanTitle;
            if (name && typeof callAnilistGraphQL === 'function') {
                try {
                    const query = `query ($search: String) { Media(search: $search, type: ANIME) { id idMal episodes } }`;
                    const data = await callAnilistGraphQL(query, { search: name });
                    if (data?.Media?.idMal) {
                        malId = data.Media.idMal;
                        if (currentAnilistMedia) {
                            currentAnilistMedia.idMal = malId;
                            if (!currentAnilistMedia.episodes) currentAnilistMedia.episodes = data.Media.episodes;
                        }
                    }
                } catch (e) {}
            }
        }

        if (!malId || isStale()) return;

        try {
            isAniSkipLoading = true;
            const types = ['op', 'ed', 'recap', 'mixed-op', 'mixed-ed'].map(t => `types[]=${t}`).join('&');
            const url = `https://api.aniskip.com/v2/skip-times/${malId}/${ep}?${types}&episodeLength=${duration}`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = await res.json();
            if (isStale()) return;
            aniSkipLoadedFor = { epKey: epKeyAtStart, malId, ep };
            if (data && data.found && Array.isArray(data.results)) {
                const intervals = parseAniSkipResults(data.results);
                currentAniSkipIntervals = intervals;
                window.currentAniSkipIntervals = intervals;
                renderAniSkipTimelineMarkers();
                mergeChapterSkipIntervals();
                console.log(`[AniSkip] Intervalles trouvés pour MAL ${malId} Ép. ${ep} :`, intervals);
            }
        } catch(err) {
            console.warn("[AniSkip] Erreur skip-times:", err.message);
        } finally {
            isAniSkipLoading = false;
        }
    }

    // Saute un passage. Un passage qui finit l'épisode (aperçu, ending final) mène à l'épisode suivant :
    // si le compte à rebours est déjà affiché, il est lancé tout de suite.
    function performSkip(seg, automatic) {
        skippedSegments.add(seg.key);
        hideAniSkipButton();
        const total = currentTotalDuration > 0 ? currentTotalDuration : 0;
        const endsEpisode = total > 0 && seg.interval.endTime >= total - 3;
        const overlay = document.getElementById('playerNextEpOverlay');
        if (endsEpisode && overlay && overlay.style.display !== 'none' && typeof playNextEpisodeNow === 'function') {
            playNextEpisodeNow();
            return;
        }
        // Pas de saut exactement sur la fin du fichier : FFmpeg n'aurait plus rien à lire
        const target = endsEpisode ? Math.max(seg.interval.startTime, total - 1) : seg.interval.endTime;
        seekVideoTo(target, true);
        showToast(automatic ? `⏭️ ${seg.done} automatiquement (${skipSourceLabel(seg.interval)})` : `⏭️ ${seg.done} !`);
    }

    function updateAniSkipButton(effectiveTime) {
        const btn = document.getElementById('aniSkipOverlayBtn');
        if (!btn) return;

        if (!currentAniSkipIntervals || isScrubbing) {
            btn.style.display = 'none';
            return;
        }

        const skipPref = localStorage.getItem('animflix_aniskip_mode') || 'button';
        if (skipPref === 'disabled') {
            btn.style.display = 'none';
            return;
        }

        const seg = getSkipSegmentAt(effectiveTime);
        if (!seg) {
            btn.style.display = 'none';
            return;
        }

        // Passage déjà sauté et flux repris sur le keyframe juste avant sa fin (marge de 3.5s)
        if (skippedSegments.has(seg.key) && effectiveTime >= (seg.interval.endTime - 3.5)) {
            btn.style.display = 'none';
            return;
        }

        // Saut automatique uniquement la première fois qu'on entre dans le passage en lecture normale
        if (!skippedSegments.has(seg.key) && skipPref === 'auto') {
            performSkip(seg, true);
            return;
        }

        const remaining = Math.max(1, Math.round(seg.interval.endTime - effectiveTime));
        const textSpan = document.getElementById('aniSkipText');
        if (textSpan) textSpan.textContent = `${seg.button} (${remaining}s)`;
        btn.style.display = 'inline-flex';
        btn.onclick = () => performSkip(seg, false);
    }

    function hideAniSkipButton() {
        const btn = document.getElementById('aniSkipOverlayBtn');
        if (btn) btn.style.display = 'none';
    }
