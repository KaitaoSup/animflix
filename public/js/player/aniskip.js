    // --- ANISKIP (DÉTECTION ET SAUT INTELLIGENT DE L'OPENING & ENDING + MARQUEURS TIMELINE) ---
    let currentAniSkipIntervals = null;
    let isAniSkipLoading = false;
    let hasSkippedCurrentOp = false;
    let hasSkippedCurrentEd = false;
    // Identifie la requête AniSkip la plus récente et pour quoi les intervalles actuels ont été chargés
    let aniSkipRequestSeq = 0;
    let aniSkipLoadedFor = null; // { epKey, malId, ep }

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

        const addMarker = (interval, typeClass, label) => {
            if (!interval || typeof interval.startTime !== 'number' || typeof interval.endTime !== 'number') return;
            if (interval.endTime <= interval.startTime) return;
            const leftPct = Math.max(0, Math.min(100, (interval.startTime / totalDur) * 100));
            const widthPct = Math.max(0.5, Math.min(100 - leftPct, ((interval.endTime - interval.startTime) / totalDur) * 100));
            const div = document.createElement('div');
            div.className = `scrubber-chapter-marker ${typeClass}`;
            div.style.left = `${leftPct}%`;
            div.style.width = `${widthPct}%`;
            div.title = label;
            markersEl.appendChild(div);
        };

        if (currentAniSkipIntervals.op) {
            addMarker(currentAniSkipIntervals.op, 'scrubber-marker-op', 'Opening (AniSkip)');
        }
        if (currentAniSkipIntervals.ed) {
            addMarker(currentAniSkipIntervals.ed, 'scrubber-marker-ed', 'Ending (AniSkip)');
        }
    }
    window.renderAniSkipTimelineMarkers = renderAniSkipTimelineMarkers;

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
            const url = `https://api.aniskip.com/v2/skip-times/${malId}/${ep}?types[]=op&types[]=ed&episodeLength=${duration}`;
            const res = await fetch(url);
            if (!res.ok) return;
            const data = await res.json();
            if (isStale()) return;
            aniSkipLoadedFor = { epKey: epKeyAtStart, malId, ep };
            if (data && data.found && Array.isArray(data.results)) {
                const intervals = {};
                data.results.forEach(r => {
                    if (r.skipType === 'op' && r.interval) {
                        intervals.op = {
                            startTime: Math.max(0, parseFloat(r.interval.startTime) || 0),
                            endTime: parseFloat(r.interval.endTime) || 0
                        };
                    } else if (r.skipType === 'ed' && r.interval) {
                        intervals.ed = {
                            startTime: Math.max(0, parseFloat(r.interval.startTime) || 0),
                            endTime: parseFloat(r.interval.endTime) || 0
                        };
                    }
                });
                currentAniSkipIntervals = intervals;
                window.currentAniSkipIntervals = intervals;
                renderAniSkipTimelineMarkers();
                console.log(`[AniSkip] Intervalles trouvés pour MAL ${malId} Ép. ${ep} :`, intervals);
            }
        } catch(err) {
            console.warn("[AniSkip] Erreur skip-times:", err.message);
        } finally {
            isAniSkipLoading = false;
        }
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

        const op = currentAniSkipIntervals.op;
        const ed = currentAniSkipIntervals.ed;

        // Gestion Opening
        if (op && effectiveTime >= op.startTime && effectiveTime < op.endTime) {
            // Si l'opening a déjà été passé et que le flux commence sur le keyframe de fin (marge de 3.5s)
            if (hasSkippedCurrentOp && effectiveTime >= (op.endTime - 3.5)) {
                btn.style.display = 'none';
                return;
            }

            // Auto-skip uniquement la première fois qu'on entre dans l'opening en lecture normale
            if (!hasSkippedCurrentOp && skipPref === 'auto') {
                hasSkippedCurrentOp = true;
                hideAniSkipButton();
                seekVideoTo(op.endTime, true);
                showToast("⏭️ Opening passé automatiquement (AniSkip)");
                return;
            }

            const remaining = Math.max(1, Math.round(op.endTime - effectiveTime));
            const textSpan = document.getElementById('aniSkipText');
            if (textSpan) textSpan.textContent = `Passer l'Opening (${remaining}s)`;
            btn.style.display = 'inline-flex';
            btn.onclick = () => {
                hasSkippedCurrentOp = true;
                hideAniSkipButton();
                seekVideoTo(op.endTime, true);
                showToast("⏭️ Opening passé !");
            };
            return;
        }

        // Gestion Ending
        if (ed && effectiveTime >= ed.startTime && effectiveTime < ed.endTime) {
            // Si l'ending a déjà été passé et que le flux commence sur le keyframe de fin (marge de 3.5s)
            if (hasSkippedCurrentEd && effectiveTime >= (ed.endTime - 3.5)) {
                btn.style.display = 'none';
                return;
            }

            // Auto-skip uniquement la première fois qu'on entre dans l'ending en lecture normale
            if (!hasSkippedCurrentEd && skipPref === 'auto') {
                hasSkippedCurrentEd = true;
                hideAniSkipButton();
                seekVideoTo(ed.endTime, true);
                showToast("⏭️ Ending passé automatiquement (AniSkip)");
                return;
            }

            const remaining = Math.max(1, Math.round(ed.endTime - effectiveTime));
            const textSpan = document.getElementById('aniSkipText');
            if (textSpan) textSpan.textContent = `Passer l'Ending (${remaining}s)`;
            btn.style.display = 'inline-flex';
            btn.onclick = () => {
                hasSkippedCurrentEd = true;
                hideAniSkipButton();
                seekVideoTo(ed.endTime, true);
                showToast("⏭️ Ending passé !");
            };
            return;
        }

        btn.style.display = 'none';
    }

    function hideAniSkipButton() {
        const btn = document.getElementById('aniSkipOverlayBtn');
        if (btn) btn.style.display = 'none';
    }

