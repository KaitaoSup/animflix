// =========================================================================
// --- STATISTIQUES PERSONNELLES (TEMPS REGARDÉ, SÉRIES DE JOURS, GENRES) ---
// =========================================================================
//
// L'historique de lecture ne garde que les 50 derniers épisodes et des positions, pas un temps
// regardé : les statistiques ont donc leur propre journal, par profil :
//   une entrée par jour × appareil × anime -> { seconds, episodes, titre, affiche, genres }
// Chaque appareil n'écrit que ses propres entrées : la synchronisation (« dernier écrit gagne »,
// espace de noms stats:<profil>) ne perd donc jamais de temps regardé sur deux appareils le même jour.

const WATCH_STATS = {
    MAX_TICK_GAP_MS: 5000,      // au-delà, la lecture s'est arrêtée (pause, chargement, onglet en veille)
    FLUSH_EVERY_MS: 30000,
    COMPLETE_AT: 0.85,          // même seuil que le suivi AniList
    MAX_ENTRIES: 3000,          // ~ plusieurs années d'usage quotidien
    STREAK_MIN_SECONDS: 60,     // une journée compte dans la série à partir d'une minute regardée
    ACTIVITY_DAYS: 30
};
const STORAGE_KEY_DEVICE_ID = 'animflix_device_id';

// --- STOCKAGE ---

function statsStorageKeyFor(profileId) {
    return profileId === 'default' ? 'animflix_watch_stats' : `animflix_watch_stats_${profileId}`;
}

function currentStatsStorageKey() {
    const profileId = (typeof getActiveProfile === 'function' && getActiveProfile()?.id) || 'default';
    return statsStorageKeyFor(profileId);
}

function readWatchStats(storageKey = currentStatsStorageKey()) {
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(parsed) ? parsed.filter(e => e && typeof e.key === 'string') : [];
    } catch (e) {
        return [];
    }
}

// Les plus récentes d'abord ; au-delà de la limite, les plus anciennes journées sont oubliées
function trimWatchStats(list) {
    return list
        .sort((a, b) => (b.day || '').localeCompare(a.day || '') || (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, WATCH_STATS.MAX_ENTRIES);
}

function saveWatchStats(list, storageKey = currentStatsStorageKey()) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(trimWatchStats(list)));
    } catch (e) {}
}

function getDeviceId() {
    try {
        let id = localStorage.getItem(STORAGE_KEY_DEVICE_ID);
        if (!id || !/^[a-z0-9]{6,16}$/.test(id)) {
            id = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
            localStorage.setItem(STORAGE_KEY_DEVICE_ID, id);
        }
        return id;
    } catch (e) {
        return 'local';
    }
}

// --- DATES (jour local, AAAA-MM-JJ) ---

function statsDayKey(date = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function statsDayFromKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function statsShiftDay(key, delta) {
    const d = statsDayFromKey(key);
    d.setDate(d.getDate() + delta); // constructeur local : pas de décalage au changement d'heure
    return statsDayKey(d);
}

// --- ENREGISTREMENT PENDANT LA LECTURE ---

let watchStatsPending = null;   // { identity, seconds, episodes }
let watchStatsLastTickAt = 0;
let watchStatsLastFlushAt = 0;
const watchStatsCountedEpisodes = new Set();

function normalizeStatsName(name) {
    return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

// Anime en cours de lecture : fiche AniList si connue (ou mémorisée pour ce nom), sinon le nom du torrent
function currentWatchIdentity() {
    const media = (typeof currentAnilistMedia !== 'undefined') ? currentAnilistMedia : null;
    const item = (typeof currentAnimeItem !== 'undefined') ? currentAnimeItem : null;
    if (!media && !item) return null;

    let name = null;
    if (item) {
        const parsed = typeof getAnimeDetails === 'function' ? getAnimeDetails(item) : {};
        name = item.animeName || parsed.animeName || item.cleanTitle || null;
    }
    let mediaId = media?.id || null;
    if (!mediaId && name) {
        const mapped = parseInt(localStorage.getItem('anilist_map_' + name.toLowerCase()), 10);
        if (mapped > 0) mediaId = mapped;
    }
    const nameKey = normalizeStatsName(name);
    if (!mediaId && !nameKey) return null;

    const mediaMatches = media && media.id === mediaId;
    return {
        animeKey: mediaId ? 'a' + mediaId : 'n' + nameKey,
        mediaId,
        title: (mediaMatches && (media.title?.english || media.title?.userPreferred || media.title?.romaji)) || name || 'Anime',
        cover: (mediaMatches && (media.coverImage?.large || media.coverImage?.medium)) || item?.poster || null,
        genres: mediaMatches && Array.isArray(media.genres) ? media.genres.slice(0, 8) : []
    };
}

/**
 * Appelée à chaque timeupdate du lecteur (controls.js). Le temps compté est le temps réel de lecture
 * (horloge murale entre deux timeupdate rapprochés), pas la position : un saut ne compte pas.
 */
function recordWatchTick(effectiveTime, totalDur) {
    const video = document.getElementById('videoPlayer');
    const now = Date.now();
    const playing = !!(video && !video.paused && !video.ended && video.readyState >= 2);
    const identity = currentWatchIdentity();
    if (!identity) {
        watchStatsLastTickAt = 0;
        return;
    }
    // Changement d'anime : le temps déjà compté revient au précédent
    if (watchStatsPending && watchStatsPending.identity.animeKey !== identity.animeKey) flushWatchStats();

    if (playing && watchStatsLastTickAt && now - watchStatsLastTickAt <= WATCH_STATS.MAX_TICK_GAP_MS) {
        if (!watchStatsPending) watchStatsPending = { identity, seconds: 0, episodes: 0 };
        watchStatsPending.identity = identity;
        watchStatsPending.seconds += (now - watchStatsLastTickAt) / 1000;
    }
    watchStatsLastTickAt = playing ? now : 0;

    const epKey = window._currentPlayingEpisodeKey;
    if (epKey && totalDur > 60 && effectiveTime >= totalDur * WATCH_STATS.COMPLETE_AT && !watchStatsCountedEpisodes.has(epKey)) {
        watchStatsCountedEpisodes.add(epKey);
        if (!watchStatsPending) watchStatsPending = { identity, seconds: 0, episodes: 0 };
        watchStatsPending.episodes++;
        flushWatchStats();
        return;
    }
    if (now - watchStatsLastFlushAt >= WATCH_STATS.FLUSH_EVERY_MS) flushWatchStats();
}

function flushWatchStats() {
    watchStatsLastFlushAt = Date.now();
    const pending = watchStatsPending;
    watchStatsPending = null;
    if (!pending || (pending.seconds < 1 && !pending.episodes)) return;

    const { identity } = pending;
    const day = statsDayKey();
    const device = getDeviceId();
    const key = `${day}|${device}|${identity.animeKey}`;
    const list = readWatchStats();
    let entry = list.find(e => e.key === key);
    if (!entry) {
        entry = { key, day, device, animeKey: identity.animeKey, seconds: 0, episodes: 0 };
        list.push(entry);
    }
    entry.mediaId = identity.mediaId || entry.mediaId || null;
    entry.title = identity.title || entry.title;
    entry.cover = identity.cover || entry.cover || null;
    if (identity.genres.length) entry.genres = identity.genres;
    entry.seconds = Math.round((entry.seconds || 0) + pending.seconds);
    entry.episodes = (entry.episodes || 0) + pending.episodes;
    entry.updatedAt = Date.now();
    saveWatchStats(list);
    if (typeof scheduleCloudSync === 'function') scheduleCloudSync();
}

// Onglet masqué ou fermé : ne pas perdre les dernières secondes
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWatchStats();
});
window.addEventListener('pagehide', flushWatchStats);

// --- CALCUL DES STATISTIQUES ---

/**
 * Agrège le journal : totaux, activité des 30 derniers jours, séries de jours, animes et genres les plus regardés.
 */
function computeWatchStats(entries, today = statsDayKey()) {
    const byDay = new Map();
    const byAnime = new Map();
    const byGenre = new Map();
    let totalSeconds = 0;
    let totalEpisodes = 0;

    for (const e of entries) {
        const seconds = Math.max(0, Number(e.seconds) || 0);
        const episodes = Math.max(0, Number(e.episodes) || 0);
        if (!e.day || (!seconds && !episodes)) continue;
        totalSeconds += seconds;
        totalEpisodes += episodes;
        byDay.set(e.day, (byDay.get(e.day) || 0) + seconds);

        const a = byAnime.get(e.animeKey) || { animeKey: e.animeKey, mediaId: null, title: null, cover: null, seconds: 0, episodes: 0, lastDay: '', lastUpdate: 0 };
        a.seconds += seconds;
        a.episodes += episodes;
        // Métadonnées : celles de l'entrée la plus récente qui en a
        const newer = (e.updatedAt || 0) >= a.lastUpdate;
        if (e.mediaId && (newer || !a.mediaId)) a.mediaId = e.mediaId;
        if (e.title && (newer || !a.title)) a.title = e.title;
        if (e.cover && (newer || !a.cover)) a.cover = e.cover;
        if (newer) a.lastUpdate = e.updatedAt || 0;
        if (e.day > a.lastDay) a.lastDay = e.day;
        if (Array.isArray(e.genres) && e.genres.length) a.genres = e.genres;
        byAnime.set(e.animeKey, a);
    }

    // Genres pondérés par le temps regardé
    for (const a of byAnime.values()) {
        for (const g of a.genres || []) byGenre.set(g, (byGenre.get(g) || 0) + a.seconds);
    }
    const genreTotal = [...byAnime.values()].filter(a => (a.genres || []).length).reduce((s, a) => s + a.seconds, 0);

    const activity = [];
    for (let i = WATCH_STATS.ACTIVITY_DAYS - 1; i >= 0; i--) {
        const day = statsShiftDay(today, -i);
        activity.push({ day, seconds: byDay.get(day) || 0 });
    }
    const sumSince = (days) => {
        const from = statsShiftDay(today, -(days - 1));
        let s = 0;
        for (const [day, sec] of byDay) if (day >= from && day <= today) s += sec;
        return s;
    };

    // Séries de jours consécutifs (au moins une minute) : record, et série en cours (aujourd'hui ou hier)
    const activeDays = [...byDay].filter(([, s]) => s >= WATCH_STATS.STREAK_MIN_SECONDS).map(([d]) => d).sort();
    const activeSet = new Set(activeDays);
    let longestStreak = 0;
    let run = 0;
    let prev = null;
    for (const day of activeDays) {
        run = prev && statsShiftDay(prev, 1) === day ? run + 1 : 1;
        longestStreak = Math.max(longestStreak, run);
        prev = day;
    }
    let currentStreak = 0;
    let cursor = activeSet.has(today) ? today : statsShiftDay(today, -1);
    while (activeSet.has(cursor)) {
        currentStreak++;
        cursor = statsShiftDay(cursor, -1);
    }

    return {
        totalSeconds,
        totalEpisodes,
        weekSeconds: sumSince(7),
        monthSeconds: sumSince(30),
        activeDays: activeDays.length,
        currentStreak,
        longestStreak,
        activity,
        topAnime: [...byAnime.values()].sort((a, b) => b.seconds - a.seconds).slice(0, 8),
        topGenres: [...byGenre].map(([genre, seconds]) => ({ genre, seconds, share: genreTotal ? seconds / genreTotal : 0 }))
            .sort((a, b) => b.seconds - a.seconds).slice(0, 6),
        animeCount: byAnime.size
    };
}

function formatWatchDuration(seconds) {
    const totalMin = Math.round((seconds || 0) / 60);
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

// --- RENDU DE L'ONGLET « STATS » ---

const STATS_DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const STATS_SHORT_DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

function renderStatsTile(label, value, sub = '') {
    return `
        <div class="stats-tile">
            <div class="stats-tile-label">${escapeHtml(label)}</div>
            <div class="stats-tile-value">${escapeHtml(value)}</div>
            ${sub ? `<div class="stats-tile-sub">${escapeHtml(sub)}</div>` : ''}
        </div>`;
}

function renderActivityChart(activity) {
    const max = Math.max(...activity.map(a => a.seconds), 60);
    const columns = activity.map(a => {
        const pct = a.seconds > 0 ? Math.max(3, (a.seconds / max) * 100) : 0;
        const label = `${STATS_DAY_FORMAT.format(statsDayFromKey(a.day))} : ${a.seconds ? formatWatchDuration(a.seconds) : 'rien'}`;
        return `
            <div class="stats-col" tabindex="0" data-tip="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
                ${pct ? `<div class="stats-bar" style="height: ${pct.toFixed(1)}%"></div>` : ''}
            </div>`;
    }).join('');
    const first = statsDayFromKey(activity[0].day);
    const mid = statsDayFromKey(activity[Math.floor(activity.length / 2)].day);
    const rows = activity.slice().reverse().filter(a => a.seconds > 0)
        .map(a => `<tr><td>${escapeHtml(STATS_DAY_FORMAT.format(statsDayFromKey(a.day)))}</td><td>${escapeHtml(formatWatchDuration(a.seconds))}</td></tr>`).join('');
    return `
        <div class="stats-chart" role="img" aria-label="Temps regardé par jour sur les 30 derniers jours">
            <div class="stats-chart-max">${escapeHtml(formatWatchDuration(max))}</div>
            <div class="stats-chart-plot">${columns}</div>
            <div class="stats-chart-axis">
                <span>${escapeHtml(STATS_SHORT_DAY_FORMAT.format(first))}</span>
                <span>${escapeHtml(STATS_SHORT_DAY_FORMAT.format(mid))}</span>
                <span>Aujourd'hui</span>
            </div>
        </div>
        ${rows ? `
            <details class="stats-table-details">
                <summary>Détail jour par jour</summary>
                <table class="stats-table"><thead><tr><th>Jour</th><th>Temps regardé</th></tr></thead><tbody>${rows}</tbody></table>
            </details>` : ''}`;
}

function renderStatsBarRow({ label, value, ratio, onclick = '', cover = null }) {
    const tag = onclick ? 'button' : 'div';
    return `
        <${tag} ${onclick ? `type="button" onclick="${onclick}"` : ''} class="stats-row ${onclick ? 'is-link' : ''}">
            ${cover !== null ? `<img class="stats-row-cover" src="${escapeHtml(cover || posterFallback(label))}" alt="" loading="lazy" ${posterOnErrorAttr(label)}>` : ''}
            <span class="stats-row-main">
                <span class="stats-row-head">
                    <span class="stats-row-label">${escapeHtml(label)}</span>
                    <span class="stats-row-value">${escapeHtml(value)}</span>
                </span>
                <span class="stats-row-track"><span class="stats-row-fill" style="width: ${Math.max(2, ratio * 100).toFixed(1)}%"></span></span>
            </span>
        </${tag}>`;
}

function renderStatsTabHtml(container) {
    flushWatchStats(); // inclure la lecture en cours
    const stats = computeWatchStats(readWatchStats());
    const profile = typeof getActiveProfile === 'function' ? getActiveProfile() : null;
    const hasData = stats.totalSeconds > 0 || stats.totalEpisodes > 0;

    const topMax = stats.topAnime[0]?.seconds || 1;
    const animeRows = stats.topAnime.map(a => renderStatsBarRow({
        label: a.title || 'Anime',
        value: `${formatWatchDuration(a.seconds)}${a.episodes ? ` · ${a.episodes} ép.` : ''}`,
        ratio: a.seconds / topMax,
        cover: a.cover || '',
        onclick: a.mediaId ? `openAnimePage(${Number(a.mediaId)})` : `searchFavoriteAnime(${jsArg(a.title || '')})`
    })).join('');
    const genreMax = stats.topGenres[0]?.seconds || 1;
    const genreRows = stats.topGenres.map(g => renderStatsBarRow({
        label: g.genre,
        value: `${Math.round(g.share * 100)} %`,
        ratio: g.seconds / genreMax
    })).join('');

    container.innerHTML = `
        <div class="home-watching-section stats-page">
            <div class="home-watching-header">
                <div class="home-watching-title-group">
                    <h2 class="home-watching-title"><span style="font-size: 24px;">📊</span> Mes statistiques</h2>
                    ${profile ? `<span class="home-watching-badge">${escapeHtml(profile.avatar || '')} ${escapeHtml(profile.name || '')}</span>` : ''}
                </div>
            </div>

            ${hasData ? `
                <div class="stats-tiles">
                    ${renderStatsTile('Temps regardé', formatWatchDuration(stats.totalSeconds), `${stats.animeCount} anime${stats.animeCount > 1 ? 's' : ''} · ${stats.activeDays} jour${stats.activeDays > 1 ? 's' : ''} actif${stats.activeDays > 1 ? 's' : ''}`)}
                    ${renderStatsTile('7 derniers jours', formatWatchDuration(stats.weekSeconds), `30 jours : ${formatWatchDuration(stats.monthSeconds)}`)}
                    ${renderStatsTile('Épisodes terminés', String(stats.totalEpisodes))}
                    ${renderStatsTile('Série en cours', `${stats.currentStreak} jour${stats.currentStreak > 1 ? 's' : ''}`, `Record : ${stats.longestStreak} jour${stats.longestStreak > 1 ? 's' : ''}`)}
                </div>

                <section class="stats-section">
                    <h3 class="stats-section-title">Activité des 30 derniers jours</h3>
                    ${renderActivityChart(stats.activity)}
                </section>

                <div class="stats-columns">
                    <section class="stats-section">
                        <h3 class="stats-section-title">Animes les plus regardés</h3>
                        <div class="stats-rows">${animeRows}</div>
                    </section>
                    ${genreRows ? `
                        <section class="stats-section">
                            <h3 class="stats-section-title">Genres préférés <small>(part du temps regardé)</small></h3>
                            <div class="stats-rows">${genreRows}</div>
                        </section>` : ''}
                </div>
            ` : `
                <div class="empty-state" style="padding: 40px 20px;">
                    <div style="font-size: 42px; margin-bottom: 14px;">📊</div>
                    <div style="font-size: 17px; font-weight: bold; color: #fff; margin-bottom: 8px;">Pas encore de statistiques</div>
                    <div style="font-size: 13.5px; color: #aaa; max-width: 480px; margin: 0 auto; line-height: 1.5;">
                        Le temps passé devant vos animes est compté à partir de maintenant : lancez un épisode et revenez ici !
                    </div>
                </div>
            `}

            <div id="statsAnilistSection"></div>
        </div>`;

    renderAnilistStatsSection();
}

// --- STATISTIQUES ANILIST (tout l'historique du compte, y compris hors Animflix) ---

let anilistStatsCache = null; // { userId, fetchedAt, data }
const ANILIST_STATS_TTL_MS = 30 * 60 * 1000;

async function fetchAnilistStats(userId) {
    if (anilistStatsCache && anilistStatsCache.userId === userId && Date.now() - anilistStatsCache.fetchedAt < ANILIST_STATS_TTL_MS) {
        return anilistStatsCache.data;
    }
    const query = `
        query ($id: Int) {
            User(id: $id) {
                statistics {
                    anime {
                        count
                        episodesWatched
                        minutesWatched
                        meanScore
                        genres(limit: 6, sort: COUNT_DESC) { genre count }
                    }
                }
            }
        }
    `;
    const data = await callAnilistGraphQL(query, { id: userId });
    const stats = data?.User?.statistics?.anime || null;
    anilistStatsCache = { userId, fetchedAt: Date.now(), data: stats };
    return stats;
}

async function renderAnilistStatsSection() {
    const el = document.getElementById('statsAnilistSection');
    if (!el) return;
    const user = (typeof currentAnilistUser !== 'undefined' && currentAnilistUser) || null;
    if (!user?.id || !localStorage.getItem('anilist_token') || typeof callAnilistGraphQL !== 'function') {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `<section class="stats-section"><h3 class="stats-section-title">Sur AniList</h3><div class="stats-tile-sub">Chargement…</div></section>`;
    try {
        const s = await fetchAnilistStats(user.id);
        if (!document.body.contains(el)) return;
        if (!s || !s.count) {
            el.innerHTML = '';
            return;
        }
        const days = s.minutesWatched / 1440;
        const genreMax = s.genres?.[0]?.count || 1;
        el.innerHTML = `
            <section class="stats-section">
                <h3 class="stats-section-title">Sur AniList <small>(tout votre historique, ${escapeHtml(user.name || '')})</small></h3>
                <div class="stats-tiles">
                    ${renderStatsTile('Animes', String(s.count))}
                    ${renderStatsTile('Épisodes vus', s.episodesWatched.toLocaleString('fr-FR'))}
                    ${renderStatsTile('Temps total', `${days.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} jours`, formatWatchDuration(s.minutesWatched * 60))}
                    ${s.meanScore ? renderStatsTile('Note moyenne', `${(s.meanScore / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} / 10`) : ''}
                </div>
                ${(s.genres || []).length ? `
                    <h4 class="stats-subtitle">Genres les plus vus <small>(nombre d'animes)</small></h4>
                    <div class="stats-rows">
                        ${s.genres.map(g => renderStatsBarRow({ label: g.genre, value: `${g.count} anime${g.count > 1 ? 's' : ''}`, ratio: g.count / genreMax })).join('')}
                    </div>` : ''}
            </section>`;
    } catch (err) {
        el.innerHTML = `<section class="stats-section"><h3 class="stats-section-title">Sur AniList</h3><div class="stats-tile-sub">⚠️ Statistiques AniList indisponibles (${escapeHtml(err.message)})</div></section>`;
    }
}

window.recordWatchTick = recordWatchTick;
window.flushWatchStats = flushWatchStats;
window.renderStatsTabHtml = renderStatsTabHtml;
window.computeWatchStats = computeWatchStats;
