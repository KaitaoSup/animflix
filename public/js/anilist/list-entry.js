// =========================================================================
// --- MA LISTE ANILIST : STATUT, NOTE ET RETRAIT (FICHE ANIME & LECTEUR) ---
// =========================================================================
//
// La note est envoyée sur 100 (scoreRaw) : AniList la convertit dans le format choisi par
// l'utilisateur (sur 10, sur 5, sur 100, smileys…). Ici, 5 étoiles notées par demi-étoile = une note sur 10.

    const ANILIST_LIST_STATUSES = [
        ['CURRENT', '📺 En cours'],
        ['PLANNING', '📋 À voir'],
        ['COMPLETED', '✅ Terminé'],
        ['REPEATING', '🔁 Je le revois'],
        ['PAUSED', '⏸️ En pause'],
        ['DROPPED', '❌ Abandonné']
    ];

    function anilistScoreLabel(scoreRaw) {
        if (!scoreRaw) return 'Pas de note';
        return `${(scoreRaw / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 })}/10`;
    }

    // --- ÉTOILES ---

    function anilistStarFill(halves, star) {
        if (halves >= star * 2) return 'is-full';
        if (halves === star * 2 - 1) return 'is-half';
        return 'is-empty';
    }

    /**
     * Widget 5 étoiles (10 demi-étoiles cliquables). `handler` est le nom d'une fonction globale
     * appelée avec la note sur 100 (10, 20… 100), ou 0 si on reclique sur la note actuelle.
     */
    function renderAnilistRatingStars(scoreRaw, handler) {
        const halves = Math.max(0, Math.min(10, Math.round((scoreRaw || 0) / 10)));
        let stars = '';
        for (let s = 1; s <= 5; s++) {
            const halfButtons = [s * 2 - 1, s * 2].map(h => {
                const raw = h * 10;
                const value = (h / 2).toLocaleString('fr-FR');
                const isCurrent = h === halves;
                return `<button type="button" class="al-star-hit ${h % 2 ? 'is-left' : 'is-right'}"
                    aria-label="${isCurrent ? 'Retirer la note' : `Noter ${value} sur 5`}" aria-pressed="${isCurrent}"
                    onclick="${handler}(${isCurrent ? 0 : raw})"
                    onmouseenter="paintAnilistRating(this.closest('.al-rating'), ${h})"
                    onfocus="paintAnilistRating(this.closest('.al-rating'), ${h})"
                    onblur="paintAnilistRating(this.closest('.al-rating'))"></button>`;
            }).join('');
            stars += `<span class="al-star ${anilistStarFill(halves, s)}" data-star="${s}">${halfButtons}</span>`;
        }
        return `<div class="al-rating" role="group" aria-label="Ma note" data-halves="${halves}" onmouseleave="paintAnilistRating(this)">
                ${stars}
                <span class="al-rating-value">${escapeHtml(anilistScoreLabel(scoreRaw))}</span>
            </div>`;
    }

    // Aperçu au survol / focus ; sans valeur, revient à la note enregistrée
    function paintAnilistRating(container, previewHalves) {
        if (!container) return;
        const halves = Number.isFinite(previewHalves) ? previewHalves : Number(container.dataset.halves) || 0;
        container.classList.toggle('is-previewing', Number.isFinite(previewHalves));
        container.querySelectorAll('.al-star').forEach(el => {
            const s = Number(el.dataset.star);
            el.classList.remove('is-full', 'is-half', 'is-empty');
            el.classList.add(anilistStarFill(halves, s));
        });
        const label = container.querySelector('.al-rating-value');
        if (label) label.textContent = anilistScoreLabel(halves * 10);
    }

    // --- APPELS ANILIST ---

    /**
     * Crée ou met à jour l'entrée de liste. `fields` : { status, scoreRaw, progress } (champs absents = inchangés).
     * Retourne l'entrée { id, status, progress, score } (score sur 100).
     */
    async function saveAnilistListEntry(mediaId, fields = {}) {
        const mutation = `
            mutation ($mediaId: Int, $status: MediaListStatus, $scoreRaw: Int, $progress: Int) {
                SaveMediaListEntry(mediaId: $mediaId, status: $status, scoreRaw: $scoreRaw, progress: $progress) {
                    id status progress score(format: POINT_100)
                }
            }
        `;
        const variables = { mediaId };
        for (const key of ['status', 'scoreRaw', 'progress']) {
            if (fields[key] !== undefined && fields[key] !== null) variables[key] = fields[key];
        }
        const data = await callAnilistGraphQL(mutation, variables);
        const entry = data?.SaveMediaListEntry;
        if (!entry) throw new Error('Réponse AniList vide');
        applyAnilistEntryUpdate(mediaId, entry);
        return entry;
    }

    async function deleteAnilistListEntry(mediaId, entryId) {
        const mutation = `mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`;
        const data = await callAnilistGraphQL(mutation, { id: entryId });
        if (!data?.DeleteMediaListEntry?.deleted) throw new Error('Suppression refusée par AniList');
        applyAnilistEntryUpdate(mediaId, null);
    }

    /**
     * Répercute une entrée modifiée (null = retirée de la liste) partout où le média est affiché :
     * fiche anime (et son cache), suivi du lecteur, liste « En cours » de l'accueil.
     */
    function applyAnilistEntryUpdate(mediaId, entry) {
        const targets = [];
        if (typeof animePageState !== 'undefined' && animePageState.media?.id === mediaId) targets.push(animePageState.media);
        if (typeof animeMediaCache !== 'undefined' && animeMediaCache.get(mediaId)) targets.push(animeMediaCache.get(mediaId).media);
        if (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.id === mediaId) targets.push(currentAnilistMedia);
        for (const media of new Set(targets)) {
            media.mediaListEntry = entry ? { ...(media.mediaListEntry || {}), ...entry } : null;
        }

        if (typeof anilistWatchingList === 'undefined' || !Array.isArray(anilistWatchingList)) return;
        const idx = anilistWatchingList.findIndex(e => e.media?.id === mediaId);
        const isWatching = entry && (entry.status === 'CURRENT' || entry.status === 'REPEATING');
        if (idx !== -1 && !isWatching) {
            anilistWatchingList.splice(idx, 1);
        } else if (idx !== -1) {
            Object.assign(anilistWatchingList[idx], { status: entry.status, progress: entry.progress, updatedAt: Math.floor(Date.now() / 1000) });
        } else if (isWatching) {
            // Nouvelle série « En cours » : la liste complète (avec les infos de diffusion) est rechargée
            if (typeof loadAnilistWatchingList === 'function') loadAnilistWatchingList(true).catch(() => {});
            return;
        }
        try { localStorage.setItem('anilist_watching_cache', JSON.stringify(anilistWatchingList)); } catch (e) {}
    }

    // --- INVITATION À NOTER EN FIN DE SÉRIE (LECTEUR) ---

    let playerRatingPromptTimer = null;

    /**
     * Après le dernier épisode (sans saison suivante) : propose de noter la série si elle n'a pas de note.
     */
    function maybePromptAnilistRating() {
        const media = typeof currentAnilistMedia !== 'undefined' ? currentAnilistMedia : null;
        if (!media || !localStorage.getItem('anilist_token')) return false;
        if (media.mediaListEntry?.score) return false;
        const anchor = document.getElementById('playerNextEpOverlay');
        if (!anchor?.parentElement) return false;

        dismissPlayerRatingPrompt();
        const title = media.title?.userPreferred || media.title?.romaji || media.title?.english || 'cet anime';
        const box = document.createElement('div');
        box.id = 'playerRatingPrompt';
        box.className = 'player-next-ep-overlay player-rating-prompt';
        box.dataset.mediaId = media.id;
        box.innerHTML = `
            <div class="next-ep-header">
                <span class="next-ep-title-badge">🏁 Série terminée</span>
                <button class="next-ep-dismiss-btn" onclick="dismissPlayerRatingPrompt()" aria-label="Fermer">&times;</button>
            </div>
            <div class="next-ep-label">${escapeHtml(title)}</div>
            <div class="next-ep-timer-text">Votre note sur AniList :</div>
            ${renderAnilistRatingStars(0, 'rateFromPlayerPrompt')}`;
        anchor.parentElement.appendChild(box);
        playerRatingPromptTimer = setTimeout(dismissPlayerRatingPrompt, 45000);
        return true;
    }

    function dismissPlayerRatingPrompt() {
        if (playerRatingPromptTimer) clearTimeout(playerRatingPromptTimer);
        playerRatingPromptTimer = null;
        document.getElementById('playerRatingPrompt')?.remove();
    }

    async function rateFromPlayerPrompt(scoreRaw) {
        const box = document.getElementById('playerRatingPrompt');
        const mediaId = Number(box?.dataset.mediaId);
        if (!mediaId) return;
        try {
            const status = currentAnilistMedia?.id === mediaId ? currentAnilistMedia.mediaListEntry?.status : null;
            await saveAnilistListEntry(mediaId, { scoreRaw, status: status || 'COMPLETED' });
            showToast(scoreRaw ? `⭐ Note enregistrée : ${anilistScoreLabel(scoreRaw)}` : '⭐ Note retirée');
            dismissPlayerRatingPrompt();
        } catch (err) {
            showToast('⚠️ Note non enregistrée : ' + err.message);
        }
    }
