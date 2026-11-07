import axios from 'axios';
import { pushStore, sendPushToUser } from './pushService.js';
import { searchAllTorrents } from './torrentAggregator.js';

/**
 * Notifications de nouveaux épisodes.
 *
 * Toutes les 15 minutes, pour chaque utilisateur abonné (appareil + compte AniList lié) :
 *  1. sa liste AniList « En cours » / « En revisionnage » et sa progression ;
 *  2. les épisodes de ces animes diffusés ces dernières 36 h (planning AniList) ;
 *  3. pour chaque épisode pas encore vu ni notifié : recherche d'une source torrent publiée après la diffusion.
 *     Source trouvée → « Épisode N disponible ». Toujours rien 6 h après la diffusion → « Épisode N sorti ».
 * Un épisode n'est notifié qu'une fois par utilisateur, et jamais s'il a été diffusé avant l'abonnement.
 */

export const NOTIFIER_CONFIG = {
  INTERVAL_MS: 15 * 60 * 1000,
  FIRST_RUN_DELAY_MS: 2 * 60 * 1000,
  LOOKBACK_S: 36 * 60 * 60,
  NO_SOURCE_GRACE_S: 6 * 60 * 60,
  // Un torrent publié un peu avant l'heure AniList reste valable (diffusions web en avance)
  PUBLISHED_BEFORE_AIRING_TOLERANCE_MS: 2 * 60 * 60 * 1000,
  MAX_AIRING_PAGES: 4
};

const ANILIST_URL = 'https://graphql.anilist.co';

const WATCHING_LIST_QUERY = `
  query ($userId: Int) {
    MediaListCollection(userId: $userId, type: ANIME, status_in: [CURRENT, REPEATING]) {
      lists {
        entries {
          progress
          media {
            id
            episodes
            title { english romaji userPreferred }
            coverImage { large medium }
          }
        }
      }
    }
  }
`;

const RECENT_AIRINGS_QUERY = `
  query ($ids: [Int], $from: Int, $to: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        mediaId
        episode
        airingAt
      }
    }
  }
`;

async function anilistRequest(query, variables, token) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Animflix/1.0' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await axios.post(ANILIST_URL, { query, variables }, { headers, timeout: 15000 });
  if (res.data?.errors?.length) throw new Error(res.data.errors[0].message || 'Erreur AniList');
  return res.data?.data;
}

// --- ANALYSE DES TORRENTS ---

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Le titre du torrent désigne-t-il cet épisode seul ? (« Titre - 05 », « S01E05 », « Episode 5 »)
 * Les packs (« 01 ~ 12 », « Batch ») ne comptent pas : on veut l'épisode qui vient de sortir.
 */
export function torrentTitleHasEpisode(title, episode) {
  if (!title || !Number.isInteger(episode) || episode < 1) return false;
  const isRange = /\bbatch\b/i.test(title)
    || /\b\d{1,4}\s*[~～]\s*\d{1,4}\b/.test(title)                  // « 01 ~ 12 »
    || /\s-\s\d{1,4}\s*[-–]\s*\d{1,4}\b/.test(title)                // « Titre - 01-12 »
    || /\b(?:E|EP|Episodes?)\s*\d{1,4}\s*[-–]\s*\d{1,4}\b/i.test(title) // « EP01-12 »
    || /[([]\d{1,4}\s*[-–]\s*\d{1,4}[)\]]/.test(title);             // « (01-12) »
  if (isRange) return false;
  const n = escapeRegExp(String(episode));
  const patterns = [
    new RegExp(`\\bS\\d{1,2}\\s*E0*${n}(?:v\\d+)?\\b`, 'i'),
    new RegExp(`\\b(?:E|EP|Episode|Épisode)\\s*0*${n}(?:v\\d+)?\\b`, 'i'),
    new RegExp(`\\s-\\s0*${n}(?:v\\d+)?(?:\\s|$|\\[|\\()`)
  ];
  return patterns.some(re => re.test(title));
}

/** Titres utilisés pour chercher l'anime sur Nyaa (rōmaji d'abord : c'est ce qu'utilisent la plupart des groupes) */
export function searchTitlesForMedia(media) {
  const seen = new Set();
  return [media?.title?.romaji, media?.title?.english, media?.title?.userPreferred]
    .filter(Boolean)
    .map(t => t.replace(/[’‘`´]/g, "'").replace(/:/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => {
      const key = t.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);
}

function displayTitle(media) {
  return media?.title?.english || media?.title?.userPreferred || media?.title?.romaji || 'Anime';
}

export function buildEpisodePayload(media, episode, available) {
  const title = displayTitle(media);
  return {
    title: available ? `🍿 ${title}` : `📺 ${title}`,
    body: available
      ? `L'épisode ${episode} est disponible, prêt à regarder !`
      : `L'épisode ${episode} est sorti (pas encore de source torrent trouvée).`,
    icon: media?.coverImage?.large || media?.coverImage?.medium || '/icons/icon-192.png',
    url: `/#/anime/${media.id}?ep=${episode}`,
    tag: `animflix-ep-${media.id}-${episode}`,
    mediaId: media.id,
    episode
  };
}

// --- CYCLE DE VÉRIFICATION ---

export function createEpisodeNotifier({
  store = pushStore,
  fetchAnilist = anilistRequest,
  searchTorrents = searchAllTorrents,
  sendPush = sendPushToUser,
  now = () => Date.now(),
  log = console
} = {}) {
  let running = false;

  async function fetchWatchingEntries(user) {
    const data = await fetchAnilist(WATCHING_LIST_QUERY, { userId: Number(user.anilist_id) }, user.anilist_token);
    const entries = new Map(); // mediaId -> { media, progress }
    for (const list of data?.MediaListCollection?.lists || []) {
      for (const e of list.entries || []) {
        if (e?.media?.id) entries.set(e.media.id, { media: e.media, progress: Number(e.progress) || 0 });
      }
    }
    return entries;
  }

  async function fetchRecentAirings(mediaIds, from, to) {
    const airings = [];
    for (let page = 1; page <= NOTIFIER_CONFIG.MAX_AIRING_PAGES; page++) {
      const data = await fetchAnilist(RECENT_AIRINGS_QUERY, { ids: mediaIds, from, to, page });
      airings.push(...(data?.Page?.airingSchedules || []));
      if (!data?.Page?.pageInfo?.hasNextPage) break;
    }
    return airings;
  }

  // Source torrent publiée pour cet épisode depuis sa diffusion ?
  async function hasTorrentForEpisode(media, episode, airingAtS, lang) {
    const minPublished = airingAtS * 1000 - NOTIFIER_CONFIG.PUBLISHED_BEFORE_AIRING_TOLERANCE_MS;
    for (const title of searchTitlesForMedia(media)) {
      let results = [];
      try {
        results = await searchTorrents(title, lang);
      } catch (e) {
        continue;
      }
      const found = (results || []).some(t => {
        const name = t.title || t.titre || '';
        if (!torrentTitleHasEpisode(name, episode)) return false;
        // Écarte un ancien torrent du même numéro (autre saison au titre identique)
        const published = t.pubDate ? Date.parse(t.pubDate) : NaN;
        return Number.isNaN(published) || published >= minPublished;
      });
      if (found) return true;
    }
    return false;
  }

  async function runOnce() {
    if (running) return { sent: 0, skipped: true };
    running = true;
    let sent = 0;
    try {
      const users = store.usersToNotify();
      if (!users.length) return { sent: 0 };

      const nowS = Math.floor(now() / 1000);
      const watching = [];
      for (const user of users) {
        try {
          watching.push({ user, entries: await fetchWatchingEntries(user) });
        } catch (err) {
          log.warn?.(`⚠️ Notifications : liste AniList de l'utilisateur ${user.id} illisible :`, err.message);
        }
      }

      const mediaIds = [...new Set(watching.flatMap(w => [...w.entries.keys()]))];
      if (!mediaIds.length) return { sent: 0 };
      const airings = await fetchRecentAirings(mediaIds, nowS - NOTIFIER_CONFIG.LOOKBACK_S, nowS);
      if (!airings.length) return { sent: 0 };

      const availability = new Map(); // `${mediaId}|${episode}|${lang}` -> Promise<boolean>

      for (const { user, entries } of watching) {
        const lang = user.lang || 'vostfr';
        const sinceS = Math.floor((Number(user.since) || 0) / 1000);
        for (const airing of airings) {
          const entry = entries.get(airing.mediaId);
          if (!entry) continue;
          const { media, progress } = entry;
          const episode = Number(airing.episode);
          if (!episode || episode <= progress) continue;   // déjà vu
          if (airing.airingAt < sinceS) continue;           // diffusé avant l'activation des notifications
          if (store.wasNotified(user.id, media.id, episode)) continue;

          const key = `${media.id}|${episode}|${lang}`;
          if (!availability.has(key)) {
            availability.set(key, hasTorrentForEpisode(media, episode, airing.airingAt, lang).catch(() => false));
          }
          const available = await availability.get(key);
          if (!available && nowS - airing.airingAt < NOTIFIER_CONFIG.NO_SOURCE_GRACE_S) continue; // on attend une source

          const delivered = await sendPush(user.id, buildEpisodePayload(media, episode, available));
          if (delivered > 0) {
            store.markNotified(user.id, media.id, episode, now());
            sent++;
          }
        }
      }
      return { sent };
    } catch (err) {
      log.warn?.('⚠️ Vérification des nouveaux épisodes impossible :', err.message);
      return { sent, error: err.message };
    } finally {
      running = false;
    }
  }

  return { runOnce };
}

export function startEpisodeNotifier() {
  if ((process.env.EPISODE_NOTIFIER || '').toLowerCase() === 'off') return null;
  const notifier = createEpisodeNotifier();
  const tick = async () => {
    const { sent } = await notifier.runOnce();
    if (sent > 0) console.log(`🔔 ${sent} notification(s) de nouvel épisode envoyée(s)`);
    try { pushStore.pruneNotified(); } catch (e) {}
  };
  setTimeout(tick, NOTIFIER_CONFIG.FIRST_RUN_DELAY_MS).unref();
  setInterval(tick, NOTIFIER_CONFIG.INTERVAL_MS).unref();
  return notifier;
}
