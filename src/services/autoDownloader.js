/**
 * Téléchargement automatique des nouveaux épisodes (« Télécharger automatiquement » sur la fiche anime).
 *
 * Un compte active l'option pour un anime en cours de diffusion. Toutes les 15 minutes :
 *  1. épisodes de ces animes diffusés ces dernières 72 h (planning AniList) ;
 *  2. pour chaque épisode pas encore traité : meilleure source torrent publiée APRÈS la diffusion
 *     (même logique que la fiche : préférences de release, résolution, seeders, sources signalées après) ;
 *  3. ajout à la bibliothèque « Gardés sur le serveur » (file du gestionnaire de téléchargements).
 * Pas de source 48 h après la diffusion : l'épisode est abandonné (il reste lisible à la main).
 * Quand le téléchargement se termine, les comptes abonnés reçoivent une notification « Prêt ».
 *
 * Le store prend la base en paramètre (comme pushStore / syncStore) pour être testable en mémoire.
 */
import { anilistRequest, torrentTitleHasEpisode, searchTitlesForMedia } from './episodeNotifier.js';
import { searchAllTorrents } from './torrentAggregator.js';
import { PUSH_LANGS } from './pushStore.js';
import { logServerError } from './errorLog.js';

export const AUTO_DOWNLOAD_CONFIG = {
  INTERVAL_MS: 15 * 60 * 1000,
  FIRST_RUN_DELAY_MS: 3 * 60 * 1000,
  LOOKBACK_S: 72 * 60 * 60,
  // Un épisode diffusé peu avant l'activation est quand même récupéré
  BEFORE_ENABLE_TOLERANCE_S: 24 * 60 * 60,
  GIVE_UP_AFTER_S: 48 * 60 * 60,
  PUBLISHED_BEFORE_AIRING_TOLERANCE_MS: 2 * 60 * 60 * 1000,
  MAX_PER_USER: 50,
  MAX_AIRING_PAGES: 4,
  MAX_GROUPS: 10
};

const RESOLUTIONS = ['any', '2160p', '1080p', '720p', '480p'];

const RECENT_AIRINGS_QUERY = `
  query ($ids: [Int], $from: Int, $to: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        episode
        airingAt
        media {
          id
          title { english romaji userPreferred }
          coverImage { large medium }
        }
      }
    }
  }
`;

// --- PRÉFÉRENCES DE RELEASE (même logique que public/js/release-prefs.js) ---

export function extractReleaseGroup(title) {
  if (!title || typeof title !== 'string') return null;
  const bracket = title.trim().match(/^[[【(]([^\]】)]{1,60})[\]】)]/);
  if (bracket) return bracket[1].trim();
  const suffix = title.trim().replace(/\.(mkv|mp4|avi)$/i, '').match(/-([A-Za-z0-9][A-Za-z0-9_.]{1,30})$/);
  return suffix ? suffix[1] : null;
}

function normalizeGroupName(name) {
  return String(name || '').toLowerCase().replace(/[\s_.-]+/g, '');
}

export function detectResolution(t) {
  const text = `${t?.resolution || ''} ${t?.titre || t?.title || ''}`;
  if (/2160p|\b4k\b|uhd/i.test(text)) return '2160p';
  if (/1080[pi]/i.test(text)) return '1080p';
  if (/720p/i.test(text)) return '720p';
  if (/480p|576p/i.test(text)) return '480p';
  return null;
}

export function normalizePrefs(raw = {}) {
  const lang = PUSH_LANGS.includes(raw.lang) ? raw.lang : 'vostfr';
  const resolution = RESOLUTIONS.includes(raw.resolution) ? raw.resolution : 'any';
  const list = Array.isArray(raw.groups) ? raw.groups : String(raw.groups || '').split(/[,;\n]+/);
  const seen = new Set();
  const groups = list
    .map(g => String(g).trim().replace(/^\[|\]$/g, '').trim().slice(0, 40))
    .filter(g => {
      const n = normalizeGroupName(g);
      if (!n || seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .slice(0, AUTO_DOWNLOAD_CONFIG.MAX_GROUPS);
  return { lang, resolution, groups };
}

/**
 * Meilleure source pour cet épisode, ou null : épisode seul (pas de pack), publiée après la diffusion,
 * avec des seeders ; puis sources non signalées, groupe préféré, résolution voulue, seeders.
 */
export function pickBestTorrent(torrents, { episode, airingAtS, prefs = {} }) {
  const minPublished = airingAtS * 1000 - AUTO_DOWNLOAD_CONFIG.PUBLISHED_BEFORE_AIRING_TOLERANCE_MS;
  const groups = (prefs.groups || []).map(normalizeGroupName);
  const groupRank = (t) => {
    const i = groups.indexOf(normalizeGroupName(extractReleaseGroup(t.titre || t.title)));
    return i === -1 ? Infinity : i;
  };
  const wantedRes = prefs.resolution && prefs.resolution !== 'any' ? prefs.resolution : null;

  const candidates = (torrents || []).filter(t => {
    if (!t || !(t.lienMagnet || t.magnetLink)) return false;
    if ((Number(t.seeders) || 0) <= 0) return false;
    if (!torrentTitleHasEpisode(t.titre || t.title || '', episode)) return false;
    // Sans date, impossible d'écarter l'épisode homonyme d'une ancienne saison : on refuse
    const published = t.pubDate ? Date.parse(t.pubDate) : NaN;
    return !Number.isNaN(published) && published >= minPublished;
  });

  candidates.sort((a, b) => {
    const repA = a.reported ? 1 : 0;
    const repB = b.reported ? 1 : 0;
    if (repA !== repB) return repA - repB;
    const gA = groupRank(a);
    const gB = groupRank(b);
    if (gA !== gB) return gA < gB ? -1 : 1;
    if (wantedRes) {
      const rA = detectResolution(a) === wantedRes ? 1 : 0;
      const rB = detectResolution(b) === wantedRes ? 1 : 0;
      if (rA !== rB) return rB - rA;
    }
    return (Number(b.seeders) || 0) - (Number(a.seeders) || 0);
  });
  return candidates[0] || null;
}

/** Fichier vidéo de l'épisode dans le torrent : celui qui porte son numéro, sinon le plus gros */
export function pickEpisodeFile(files, episode) {
  const list = (files || []).filter(f => Number.isInteger(f?.id));
  if (!list.length) return 1;
  const exact = list.filter(f => f.episode === episode);
  const pool = exact.length ? exact : list;
  return pool.reduce((best, f) => ((f.length || 0) > (best.length || 0) ? f : best)).id;
}

function displayTitle(media) {
  return media?.title?.english || media?.title?.userPreferred || media?.title?.romaji || 'Anime';
}

// --- STOCKAGE ---

export function createAutoDownloadStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS auto_download_subscriptions (
      user_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      title TEXT,
      poster TEXT,
      lang TEXT NOT NULL DEFAULT 'vostfr',
      resolution TEXT NOT NULL DEFAULT 'any',
      groups_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, media_id)
    );
    CREATE INDEX IF NOT EXISTS idx_auto_dl_media ON auto_download_subscriptions(media_id);
    CREATE TABLE IF NOT EXISTS auto_download_episodes (
      media_id INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      lang TEXT NOT NULL,
      download_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (media_id, episode, lang)
    );
  `);

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO auto_download_subscriptions (user_id, media_id, title, poster, lang, resolution, groups_json, created_at)
      VALUES (@userId, @mediaId, @title, @poster, @lang, @resolution, @groups, @now)
      ON CONFLICT(user_id, media_id) DO UPDATE SET
        title = excluded.title, poster = excluded.poster, lang = excluded.lang,
        resolution = excluded.resolution, groups_json = excluded.groups_json
    `),
    remove: db.prepare('DELETE FROM auto_download_subscriptions WHERE user_id = ? AND media_id = ?'),
    get: db.prepare('SELECT * FROM auto_download_subscriptions WHERE user_id = ? AND media_id = ?'),
    listForUser: db.prepare('SELECT * FROM auto_download_subscriptions WHERE user_id = ? ORDER BY created_at DESC'),
    countForUser: db.prepare('SELECT COUNT(*) AS n FROM auto_download_subscriptions WHERE user_id = ?'),
    all: db.prepare('SELECT * FROM auto_download_subscriptions ORDER BY created_at ASC'),
    usersForMedia: db.prepare('SELECT DISTINCT user_id FROM auto_download_subscriptions WHERE media_id = ?'),
    handled: db.prepare('SELECT 1 FROM auto_download_episodes WHERE media_id = ? AND episode = ? AND lang = ?'),
    markHandled: db.prepare(`
      INSERT OR REPLACE INTO auto_download_episodes (media_id, episode, lang, download_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    byDownload: db.prepare('SELECT * FROM auto_download_episodes WHERE download_id = ? LIMIT 1'),
    prune: db.prepare('DELETE FROM auto_download_episodes WHERE created_at < ?')
  };

  const toSub = (row) => row && {
    userId: row.user_id,
    mediaId: row.media_id,
    title: row.title,
    poster: row.poster,
    lang: row.lang,
    resolution: row.resolution,
    groups: (() => { try { return JSON.parse(row.groups_json) || []; } catch (e) { return []; } })(),
    createdAt: row.created_at
  };

  return {
    set(userId, mediaId, { title = null, poster = null, ...prefs } = {}, now = Date.now()) {
      const p = normalizePrefs(prefs);
      stmts.upsert.run({
        userId, mediaId,
        title: typeof title === 'string' ? title.slice(0, 300) : null,
        poster: typeof poster === 'string' && /^https?:\/\//i.test(poster) ? poster.slice(0, 2048) : null,
        lang: p.lang, resolution: p.resolution, groups: JSON.stringify(p.groups), now
      });
      return toSub(stmts.get.get(userId, mediaId));
    },
    remove: (userId, mediaId) => stmts.remove.run(userId, mediaId).changes > 0,
    get: (userId, mediaId) => toSub(stmts.get.get(userId, mediaId)) || null,
    listForUser: (userId) => stmts.listForUser.all(userId).map(toSub),
    countForUser: (userId) => stmts.countForUser.get(userId).n,
    all: () => stmts.all.all().map(toSub),
    usersForMedia: (mediaId) => stmts.usersForMedia.all(mediaId).map(r => r.user_id),
    wasHandled: (mediaId, episode, lang) => !!stmts.handled.get(mediaId, episode, lang),
    markHandled: (mediaId, episode, lang, downloadId, status, now = Date.now()) =>
      stmts.markHandled.run(mediaId, episode, lang, downloadId ?? null, status, now),
    episodeForDownload: (downloadId) => stmts.byDownload.get(downloadId) || null,
    prune: (now = Date.now()) => stmts.prune.run(now - 60 * 24 * 60 * 60 * 1000).changes
  };
}

// --- CYCLE DE VÉRIFICATION ---

export function createAutoDownloader({
  store,
  enqueue,                       // (request, userId) => { item, created } | { error }
  isAlreadyKept = () => false,   // (mediaId, episode) => boolean : épisode déjà gardé (ajout manuel)
  getFiles = null,               // (magnet) => { files: [{ id, episode, length }] }
  annotate = (list) => list,     // ajoute `reported` aux sources signalées
  fetchAnilist = anilistRequest,
  searchTorrents = searchAllTorrents,
  now = () => Date.now(),
  log = console
}) {
  let running = false;

  async function fetchRecentAirings(mediaIds, from, to) {
    const airings = [];
    for (let page = 1; page <= AUTO_DOWNLOAD_CONFIG.MAX_AIRING_PAGES; page++) {
      const data = await fetchAnilist(RECENT_AIRINGS_QUERY, { ids: mediaIds, from, to, page });
      airings.push(...(data?.Page?.airingSchedules || []));
      if (!data?.Page?.pageInfo?.hasNextPage) break;
    }
    return airings;
  }

  async function findSource(media, episode, airingAtS, prefs) {
    const all = [];
    for (const title of searchTitlesForMedia(media)) {
      try {
        all.push(...((await searchTorrents(title, prefs.lang)) || []));
      } catch (e) {
        // Source de recherche indisponible : on essaie le titre suivant, puis le prochain passage
      }
      const best = pickBestTorrent(annotate(all), { episode, airingAtS, prefs });
      if (best) return best;
    }
    return null;
  }

  async function runOnce() {
    if (running) return { queued: 0, skipped: true };
    running = true;
    let queued = 0;
    try {
      const subs = store.all();
      if (!subs.length) return { queued: 0 };

      // Un anime suivi par plusieurs comptes dans la même langue n'est téléchargé qu'une fois
      // (préférences du premier compte à l'avoir activé).
      const groups = new Map(); // `${mediaId}|${lang}` -> { mediaId, prefs, userId, sinceS }
      for (const s of subs) {
        const key = `${s.mediaId}|${s.lang}`;
        const sinceS = Math.floor(s.createdAt / 1000) - AUTO_DOWNLOAD_CONFIG.BEFORE_ENABLE_TOLERANCE_S;
        const g = groups.get(key);
        if (!g) groups.set(key, { mediaId: s.mediaId, userId: s.userId, sinceS, prefs: { lang: s.lang, resolution: s.resolution, groups: s.groups } });
        else g.sinceS = Math.min(g.sinceS, sinceS);
      }

      const nowS = Math.floor(now() / 1000);
      const mediaIds = [...new Set(subs.map(s => s.mediaId))];
      const airings = await fetchRecentAirings(mediaIds, nowS - AUTO_DOWNLOAD_CONFIG.LOOKBACK_S, nowS);

      for (const airing of airings) {
        const media = airing.media;
        const episode = Number(airing.episode);
        if (!media?.id || !episode) continue;
        for (const g of groups.values()) {
          if (g.mediaId !== media.id || airing.airingAt < g.sinceS) continue;
          const { lang } = g.prefs;
          if (store.wasHandled(media.id, episode, lang)) continue;
          if (isAlreadyKept(media.id, episode)) {
            store.markHandled(media.id, episode, lang, null, 'kept', now());
            continue;
          }

          const torrent = await findSource(media, episode, airing.airingAt, g.prefs);
          if (!torrent) {
            if (nowS - airing.airingAt > AUTO_DOWNLOAD_CONFIG.GIVE_UP_AFTER_S) {
              store.markHandled(media.id, episode, lang, null, 'nosource', now());
              logServerError('autodl', `Aucune source pour l'épisode ${episode} après 48 h`, `${displayTitle(media)} (${lang})`);
            }
            continue;
          }

          const magnet = torrent.lienMagnet || torrent.magnetLink;
          let fileIndex = 1;
          if (getFiles) {
            try { fileIndex = pickEpisodeFile((await getFiles(magnet))?.files, episode); } catch (e) {}
          }

          const result = enqueue({
            magnet,
            fileIndex,
            title: `${displayTitle(media)} - Épisode ${episode}`,
            animeName: displayTitle(media),
            episode,
            mediaId: media.id,
            poster: media.coverImage?.large || media.coverImage?.medium || null
          }, g.userId);
          if (result?.error) {
            log.warn?.(`⚠️ Téléchargement auto refusé (${displayTitle(media)} ép. ${episode}) : ${result.error}`);
            continue; // nouvelle tentative au prochain passage (ex. disque plein, bibliothèque pleine)
          }
          store.markHandled(media.id, episode, lang, result.item?.id, 'queued', now());
          queued++;
          log.log?.(`🤖 Téléchargement auto : ${displayTitle(media)} ép. ${episode} (${torrent.titre || torrent.title})`);
        }
      }
      return { queued };
    } catch (err) {
      log.warn?.('⚠️ Téléchargement automatique impossible :', err.message);
      return { queued, error: err.message };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

/** Payload de la notification « épisode prêt » d'un téléchargement automatique terminé, ou null */
export function buildReadyPayload(store, item) {
  if (!item?.id || !item.mediaId) return null;
  const ep = store.episodeForDownload(item.id);
  if (!ep) return null;
  const users = store.usersForMedia(item.mediaId);
  if (!users.length) return null;
  return {
    users,
    payload: {
      title: `💾 ${item.animeName || 'Anime'}`,
      body: `L'épisode ${item.episode} est téléchargé sur le serveur : lecture instantanée, sans attendre les pairs.`,
      icon: item.poster || '/icons/icon-192.png',
      url: `/#/anime/${item.mediaId}?ep=${item.episode}`,
      tag: `animflix-ready-${item.mediaId}-${item.episode}`,
      mediaId: item.mediaId,
      episode: item.episode
    }
  };
}

// --- INSTANCE DU SERVEUR ---

const status = { enabled: false, lastRunAt: null, lastQueued: 0, totalQueued: 0, lastError: null, nextRunAt: null, subscriptions: 0 };

export function getAutoDownloaderStatus() {
  return { ...status };
}

export function startAutoDownloader(deps) {
  if ((process.env.AUTO_DOWNLOAD || '').toLowerCase() === 'off') return null;
  const downloader = createAutoDownloader(deps);
  status.enabled = true;
  status.nextRunAt = Date.now() + AUTO_DOWNLOAD_CONFIG.FIRST_RUN_DELAY_MS;
  const tick = async () => {
    const { queued, error } = await downloader.runOnce();
    status.lastRunAt = Date.now();
    status.nextRunAt = Date.now() + AUTO_DOWNLOAD_CONFIG.INTERVAL_MS;
    status.lastQueued = queued;
    status.totalQueued += queued;
    status.lastError = error || null;
    try { status.subscriptions = deps.store.all().length; } catch (e) {}
    if (error) logServerError('autodl', `Téléchargement automatique : ${error}`);
    try { deps.store.prune(); } catch (e) {}
  };
  try { status.subscriptions = deps.store.all().length; } catch (e) {}
  setTimeout(tick, AUTO_DOWNLOAD_CONFIG.FIRST_RUN_DELAY_MS).unref();
  setInterval(tick, AUTO_DOWNLOAD_CONFIG.INTERVAL_MS).unref();
  return downloader;
}
