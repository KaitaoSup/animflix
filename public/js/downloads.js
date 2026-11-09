// =========================================================================
// --- ÉPISODES GARDÉS SUR LE SERVEUR (BIBLIOTHÈQUE HORS LIGNE) ---
// =========================================================================
//
// « Garder sur le serveur » télécharge l'épisode en entier dans le dossier downloads/ du serveur.
// Ensuite, toute lecture de ce torrent lit le fichier local : plus besoin de seeders.
// Bibliothèque commune à tous les comptes du serveur (onglet « Sur le serveur »).

const serverDownloads = {
    items: [],
    disk: null,
    usedBytes: 0,
    loaded: false,
    loading: null,
    pollTimer: null
};

const DOWNLOAD_STATUS_LABELS = {
    queued: '⏳ En attente',
    downloading: '📥 Téléchargement',
    done: '💾 Disponible hors ligne',
    error: '⚠️ Échec'
};

function isDownloadsAccountReady() {
    return typeof currentAnimflixUser !== 'undefined' && !!currentAnimflixUser;
}

// Même identifiant que le serveur : `<infohash>_f<index>`
function serverDownloadId(magnet, fileIndex) {
    const m = /xt=urn:btih:([a-z0-9]+)/i.exec(magnet || '');
    if (!m) return null;
    return `${m[1].toLowerCase()}_f${parseInt(fileIndex, 10) || 1}`;
}

function getServerDownload(magnet, fileIndex) {
    const id = serverDownloadId(magnet, fileIndex);
    return id ? serverDownloads.items.find(i => i.id === id) || null : null;
}

// Fichier complet sur le serveur pour ce torrent / fichier
function getKeptServerDownload(magnet, fileIndex) {
    const item = getServerDownload(magnet, fileIndex);
    return item && item.status === 'done' ? item : null;
}

// Épisode d'un anime AniList gardé sur le serveur (fiche anime)
function getKeptEpisodeDownload(mediaId, ep) {
    if (!mediaId || !ep) return null;
    return serverDownloads.items.find(i => i.status === 'done' && i.mediaId === mediaId && i.episode === ep) || null;
}

function formatDownloadBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '—';
    const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toLocaleString('fr-FR', { maximumFractionDigits: v >= 100 || i === 0 ? 0 : 1 })} ${units[i]}`;
}

// --- SYNCHRONISATION AVEC LE SERVEUR ---

async function refreshServerDownloads() {
    if (!isDownloadsAccountReady()) {
        serverDownloads.items = [];
        serverDownloads.loaded = false;
        stopServerDownloadsPolling();
        onServerDownloadsChanged();
        return serverDownloads.items;
    }
    if (serverDownloads.loading) return serverDownloads.loading;
    serverDownloads.loading = (async () => {
        try {
            const res = await fetch('/api/downloads', { headers: getAuthHeaders(), credentials: 'include', cache: 'no-store' });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
            const data = await res.json();
            serverDownloads.items = Array.isArray(data.items) ? data.items : [];
            serverDownloads.disk = data.disk || null;
            serverDownloads.usedBytes = data.usedBytes || 0;
            serverDownloads.loaded = true;
            serverDownloads.error = null;
        } catch (err) {
            serverDownloads.error = err.message;
        } finally {
            serverDownloads.loading = null;
        }
        scheduleServerDownloadsPolling();
        onServerDownloadsChanged();
        return serverDownloads.items;
    })();
    return serverDownloads.loading;
}

// Sondage toutes les 3 s tant qu'un téléchargement est en cours (et que la page est visible)
function scheduleServerDownloadsPolling() {
    stopServerDownloadsPolling();
    const busy = serverDownloads.items.some(i => i.status === 'queued' || i.status === 'downloading');
    if (!busy) return;
    serverDownloads.pollTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') refreshServerDownloads();
        else scheduleServerDownloadsPolling();
    }, 3000);
}

function stopServerDownloadsPolling() {
    if (serverDownloads.pollTimer) clearTimeout(serverDownloads.pollTimer);
    serverDownloads.pollTimer = null;
}

function onServerDownloadsChanged() {
    updateKeepOnServerButtons();
    const content = document.getElementById('downloadsTabContent');
    if (content) content.innerHTML = renderDownloadsListHtml();
    // Badges 💾 des tuiles d'épisodes de la fiche ouverte
    if (typeof refreshAnimeEpisodeTiles === 'function' && typeof animePageState !== 'undefined' && animePageState.media
        && document.getElementById('animeEpGrid')) {
        const signature = serverDownloads.items.filter(i => i.status === 'done').map(i => i.id).join(',');
        if (signature !== serverDownloads.lastDoneSignature) {
            serverDownloads.lastDoneSignature = signature;
            refreshAnimeEpisodeTiles();
        }
    }
}

// --- ACTIONS ---

/**
 * Bouton « Garder sur le serveur » du lecteur : ajoute l'épisode en cours à la bibliothèque
 */
async function keepCurrentEpisodeOnServer() {
    if (!isDownloadsAccountReady()) {
        showToast('🔒 Connectez-vous à votre compte Animflix pour garder des épisodes sur le serveur');
        if (typeof openAnimflixAuthModal === 'function') openAnimflixAuthModal('login');
        return;
    }
    if (!currentActiveMagnet) {
        showToast('⚠️ Aucun épisode en cours');
        return;
    }
    const existing = getServerDownload(currentActiveMagnet, currentActiveFileIndex);
    if (existing && existing.status !== 'error') {
        showToast(existing.status === 'done'
            ? '💾 Cet épisode est déjà gardé sur le serveur'
            : '📥 Cet épisode est déjà en cours de téléchargement');
        return;
    }

    const parsed = currentAnimeItem && typeof getAnimeDetails === 'function' ? getAnimeDetails(currentAnimeItem) : {};
    const animeName = (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.title?.userPreferred)
        || currentAnimeItem?.animeName || parsed.animeName || currentAnimeItem?.titre || 'Anime';
    const episode = Number(currentDetectedEpisode) || Number(parsed.episode) || null;
    const mediaId = (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.id)
        || currentTargetNextEpisode?.mediaId || window._currentAnimePageId || null;
    const poster = currentAnimeItem?.poster
        || (typeof currentAnilistMedia !== 'undefined' && currentAnilistMedia?.coverImage?.large) || null;

    try {
        const res = await fetch('/api/downloads', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include',
            body: JSON.stringify({
                magnet: currentActiveMagnet,
                fileIndex: currentActiveFileIndex || 1,
                title: episode ? `${animeName} - Épisode ${episode}` : (currentAnimeItem?.titre || animeName),
                animeName,
                episode,
                mediaId,
                poster: poster && /^https?:\/\//i.test(poster) ? poster : null
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        showToast('📥 Téléchargement sur le serveur lancé : retrouvez-le dans « Sur le serveur »');
        await refreshServerDownloads();
    } catch (err) {
        showToast('⚠️ ' + err.message);
    }
}

async function deleteServerDownload(id) {
    const item = serverDownloads.items.find(i => i.id === id);
    if (!item) return;
    const ok = typeof openUiDialog === 'function'
        ? await openUiDialog({
            title: 'Supprimer du serveur ?',
            message: `« ${item.title} » sera effacé du disque du serveur${item.status === 'done' ? ` (${formatDownloadBytes(item.size)} libérés)` : ''}. Il restera regardable en streaming tant que le torrent a des seeders.`,
            okLabel: 'Supprimer', cancelLabel: 'Annuler', danger: true
        })
        : confirm(`Supprimer « ${item.title} » du serveur ?`);
    if (!ok) return;
    try {
        const res = await fetch('/api/downloads/' + encodeURIComponent(id), {
            method: 'DELETE', headers: getAuthHeaders(), credentials: 'include'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        showToast('🗑️ Épisode supprimé du serveur');
    } catch (err) {
        showToast('⚠️ ' + err.message);
    }
    refreshServerDownloads();
}

async function retryServerDownload(id) {
    try {
        const res = await fetch('/api/downloads/' + encodeURIComponent(id) + '/retry', {
            method: 'POST', headers: getAuthHeaders(), credentials: 'include'
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        showToast('🔁 Téléchargement relancé');
    } catch (err) {
        showToast('⚠️ ' + err.message);
    }
    refreshServerDownloads();
}

function playServerDownload(id) {
    const item = serverDownloads.items.find(i => i.id === id);
    if (!item || typeof openAnimeDetail !== 'function') return;
    // Associe le nom à la fiche AniList : suivi de progression et AniSkip sur le bon anime
    if (item.mediaId && item.animeName) {
        try { localStorage.setItem('anilist_map_' + item.animeName.toLowerCase(), item.mediaId); } catch (e) {}
    }
    openAnimeDetail({
        titre: item.fileName || item.title,
        animeName: item.animeName || item.title,
        episode: item.episode,
        lienMagnet: item.magnet,
        poster: item.poster,
        taille: formatDownloadBytes(item.size),
        seeders: 0
    }, item.fileIndex || 1, 0);
}

function downloadServerItemToDevice(id) {
    const item = serverDownloads.items.find(i => i.id === id);
    if (!item) return;
    const a = document.createElement('a');
    a.href = `/api/download?magnet=${encodeURIComponent(item.magnet)}&fileIndex=${encodeURIComponent(item.fileIndex || 1)}&title=${encodeURIComponent(item.title)}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
}

// --- BOUTONS DU LECTEUR ---

function updateKeepOnServerButtons() {
    const item = typeof currentActiveMagnet !== 'undefined' && currentActiveMagnet
        ? getServerDownload(currentActiveMagnet, currentActiveFileIndex) : null;
    let icon = '💾';
    let label = 'Garder sur le serveur';
    let title = "Télécharger l'épisode sur le serveur : il restera regardable même sans seeders";
    let state = '';
    if (item?.status === 'done') {
        icon = '✅'; label = 'Gardé sur le serveur'; state = 'is-done';
        title = `Épisode gardé sur le serveur (${formatDownloadBytes(item.size)}) : lecture depuis le disque`;
    } else if (item?.status === 'downloading' || item?.status === 'queued') {
        const pct = Math.round((item.progress || 0) * 100);
        icon = '📥'; label = item.status === 'queued' ? 'En attente…' : `Sur le serveur ${pct}%`; state = 'is-busy';
        title = item.status === 'queued' ? 'En attente : un autre téléchargement est en cours' : `Téléchargement sur le serveur : ${pct}%`;
    } else if (item?.status === 'error') {
        icon = '⚠️'; label = 'Réessayer'; state = 'is-error';
        title = `Échec : ${item.error || 'erreur inconnue'} (cliquer pour réessayer)`;
    }
    for (const id of ['playerKeepBtn', 'detailKeepBtn']) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        btn.classList.remove('is-done', 'is-busy', 'is-error');
        if (state) btn.classList.add(state);
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.innerHTML = id === 'playerKeepBtn'
            ? `<span>${icon}</span>`
            : `${icon} ${escapeHtml(label)}`;
    }
}

function onKeepOnServerClick() {
    const item = typeof currentActiveMagnet !== 'undefined' && currentActiveMagnet
        ? getServerDownload(currentActiveMagnet, currentActiveFileIndex) : null;
    if (item?.status === 'error') return retryServerDownload(item.id);
    return keepCurrentEpisodeOnServer();
}

// --- ONGLET « SUR LE SERVEUR » ---

function renderDownloadCard(item) {
    const pct = Math.round((item.progress || 0) * 100);
    const status = DOWNLOAD_STATUS_LABELS[item.status] || item.status;
    const cover = item.poster || (typeof posterFallback === 'function' ? posterFallback(item.animeName || item.title) : '');
    const sizeInfo = item.status === 'done'
        ? formatDownloadBytes(item.size)
        : item.size ? `${formatDownloadBytes(item.downloaded)} / ${formatDownloadBytes(item.size)}` : formatDownloadBytes(item.downloaded);
    const speed = item.status === 'downloading' && item.speed > 0 ? ` · ${formatDownloadBytes(item.speed)}/s` : '';
    const idArg = jsArg(item.id);
    return `
        <div class="dl-card dl-${escapeHtml(item.status)}">
            <img class="dl-cover" src="${escapeHtml(cover)}" alt="" loading="lazy" ${typeof posterOnErrorAttr === 'function' ? posterOnErrorAttr(item.animeName || item.title) : ''}>
            <div class="dl-body">
                <div class="dl-title">${escapeHtml(item.animeName || item.title)}</div>
                <div class="dl-sub">${item.episode ? `Épisode ${Number(item.episode)}` : escapeHtml(item.fileName || item.title)}</div>
                <div class="dl-status">${escapeHtml(status)}${item.status === 'downloading' || item.status === 'queued' ? ` · ${pct}%` : ''}</div>
                ${item.status !== 'done' ? `<div class="dl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div style="width: ${pct}%"></div></div>` : ''}
                <div class="dl-meta">${escapeHtml(sizeInfo + speed)}</div>
                ${item.status === 'error' && item.error ? `<div class="dl-error">${escapeHtml(item.error)}</div>` : ''}
                <div class="dl-actions">
                    ${item.status === 'done' ? `
                        <button type="button" class="btn-anime-play dl-btn-play" onclick="playServerDownload(${idArg})">▶ Regarder</button>
                        <button type="button" class="btn-secondary" onclick="downloadServerItemToDevice(${idArg})" title="Enregistrer le fichier sur cet appareil">📲 Sur l'appareil</button>
                    ` : ''}
                    ${item.status === 'error' ? `<button type="button" class="btn-secondary" onclick="retryServerDownload(${idArg})">🔁 Réessayer</button>` : ''}
                    ${item.mediaId ? `<button type="button" class="btn-secondary" onclick="openAnimePage(${Number(item.mediaId)})" title="Ouvrir la fiche de l'anime">📺 Fiche</button>` : ''}
                    <button type="button" class="btn-secondary dl-btn-delete" onclick="deleteServerDownload(${idArg})" title="Supprimer du serveur">🗑️</button>
                </div>
            </div>
        </div>`;
}

function renderDownloadsListHtml() {
    if (!isDownloadsAccountReady()) {
        return `<div class="empty-state">🔒 Connectez-vous à votre compte Animflix pour garder des épisodes sur le serveur.</div>`;
    }
    if (!serverDownloads.loaded) {
        return serverDownloads.error
            ? `<div class="empty-state">⚠️ ${escapeHtml(serverDownloads.error)}</div>`
            : `<div class="empty-state"><div class="spinner" style="margin: 0 auto 10px;"></div>Chargement…</div>`;
    }
    const disk = serverDownloads.disk;
    const header = `
        <div class="dl-header">
            <span>💾 <b>${formatDownloadBytes(serverDownloads.usedBytes)}</b> d'épisodes gardés</span>
            ${disk ? `<span>· ${formatDownloadBytes(disk.free)} libres sur le disque</span>` : ''}
        </div>`;
    if (serverDownloads.items.length === 0) {
        return header + `
            <div class="empty-state">
                Aucun épisode gardé sur le serveur.<br>
                <small>Pendant la lecture, le bouton <b>💾</b> télécharge l'épisode sur le serveur : il reste regardable même quand le torrent n'a plus de seeders.</small>
            </div>`;
    }
    const order = { downloading: 0, queued: 1, error: 2, done: 3 };
    const items = [...serverDownloads.items].sort((a, b) =>
        (order[a.status] ?? 9) - (order[b.status] ?? 9)
        || String(a.animeName || a.title).localeCompare(String(b.animeName || b.title), 'fr')
        || (a.episode || 0) - (b.episode || 0));
    return header + `<div class="dl-grid">${items.map(renderDownloadCard).join('')}</div>`;
}

function renderDownloadsTabHtml(container) {
    container.innerHTML = `<div id="downloadsTabContent">${renderDownloadsListHtml()}</div>`;
    refreshServerDownloads();
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && serverDownloads.items.some(i => i.status === 'queued' || i.status === 'downloading')) {
        refreshServerDownloads();
    }
});

window.refreshServerDownloads = refreshServerDownloads;
window.getKeptServerDownload = getKeptServerDownload;
window.getKeptEpisodeDownload = getKeptEpisodeDownload;

// =========================================================================
// --- TÉLÉCHARGEMENT AUTOMATIQUE DES NOUVEAUX ÉPISODES (FICHE ANIME) ---
// =========================================================================
//
// Interrupteur sur la fiche d'un anime en cours de diffusion : chaque nouvel épisode est gardé sur
// le serveur dès qu'une source sort (vérifié toutes les 15 min), avec la langue de recherche et les
// préférences de release de cet appareil. Compte Animflix requis.

const autoDownloadState = new Map(); // mediaId -> { enabled, loading }

function canAutoDownloadMedia(media) {
    return isDownloadsAccountReady() && !!media && (media.status === 'RELEASING' || media.status === 'NOT_YET_RELEASED');
}

function renderAutoDownloadToggle(media) {
    if (!canAutoDownloadMedia(media)) return '';
    const st = autoDownloadState.get(media.id);
    const on = !!st?.enabled;
    const busy = !st || st.loading;
    return `
        <button type="button" id="autoDownloadToggle" class="btn-favorite-toggle btn-auto-download ${on ? 'active' : ''}"
            onclick="toggleAutoDownload()" aria-pressed="${on}" ${busy ? 'aria-busy="true"' : ''}
            title="Garder automatiquement chaque nouvel épisode sur le serveur dès qu'une source sort">
            ${on ? '🤖 Téléchargement auto activé' : '🤖 Télécharger automatiquement'}
        </button>`;
}

function refreshAutoDownloadToggle(media) {
    const btn = document.getElementById('autoDownloadToggle');
    if (!btn) return;
    const hadFocus = document.activeElement === btn;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderAutoDownloadToggle(media);
    const fresh = tmp.firstElementChild;
    if (!fresh) return btn.remove();
    btn.replaceWith(fresh);
    if (hadFocus) fresh.focus({ preventScroll: true });
}

async function loadAutoDownloadState(media) {
    if (!canAutoDownloadMedia(media)) return;
    try {
        const res = await fetch('/api/auto-downloads/' + encodeURIComponent(media.id), {
            headers: getAuthHeaders(), credentials: 'include', cache: 'no-store'
        });
        if (!res.ok) return;
        const data = await res.json();
        autoDownloadState.set(media.id, { enabled: !!data.enabled, loading: false });
        if (window._currentAnimePageId === media.id) refreshAutoDownloadToggle(media);
    } catch (e) {}
}

async function toggleAutoDownload() {
    const media = typeof getCurrentAnimePageMedia === 'function' ? getCurrentAnimePageMedia() : null;
    if (!canAutoDownloadMedia(media)) return;
    const st = autoDownloadState.get(media.id) || { enabled: false };
    if (st.loading) return;
    const enabled = !st.enabled;
    autoDownloadState.set(media.id, { ...st, loading: true });
    refreshAutoDownloadToggle(media);

    const prefs = typeof getReleasePrefs === 'function' ? getReleasePrefs() : { groups: [], resolution: 'any' };
    const title = media.title?.english || media.title?.userPreferred || media.title?.romaji || 'Anime';
    try {
        const res = await fetch('/api/auto-downloads/' + encodeURIComponent(media.id), {
            method: 'PUT',
            headers: getAuthHeaders(),
            credentials: 'include',
            body: JSON.stringify({
                enabled,
                title,
                poster: media.coverImage?.large || null,
                lang: document.getElementById('searchType')?.value || 'vostfr',
                resolution: prefs.resolution,
                groups: prefs.groups
            })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        autoDownloadState.set(media.id, { enabled: !!data.enabled, loading: false });
        showToast(data.enabled
            ? `🤖 Les nouveaux épisodes de « ${title} » seront gardés sur le serveur dès leur sortie`
            : `🤖 Téléchargement automatique désactivé pour « ${title} »`);
    } catch (err) {
        autoDownloadState.set(media.id, { ...st, loading: false });
        showToast('⚠️ ' + err.message);
    }
    refreshAutoDownloadToggle(media);
}

window.renderAutoDownloadToggle = renderAutoDownloadToggle;
window.loadAutoDownloadState = loadAutoDownloadState;
window.toggleAutoDownload = toggleAutoDownload;
