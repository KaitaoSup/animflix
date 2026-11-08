/**
 * Agenda des prochains épisodes (.ics) : les diffusions des animes de la liste AniList « En cours »
 * (et « À voir » en option), à ajouter dans Google Agenda, Apple Calendrier, Outlook, Thunderbird…
 *
 * Les applications d'agenda relisent l'URL régulièrement sans session : l'accès se fait par un jeton
 * secret propre à chaque compte (révocable). Le store prend la base en paramètre pour être testable.
 */
import crypto from 'crypto';

export const CALENDAR_CONFIG = {
  PAST_WINDOW_S: 7 * 24 * 3600,      // épisodes récents gardés (ils ne disparaissent pas de l'agenda le lendemain)
  FUTURE_WINDOW_S: 35 * 24 * 3600,
  MAX_AIRING_PAGES: 8,
  CACHE_TTL_MS: 30 * 60 * 1000,
  DEFAULT_EPISODE_MINUTES: 24
};

const TOKEN_RE = /^[a-f0-9]{48}$/;

export function isValidCalendarToken(token) {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

export function createCalendarStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendar_tokens (
      user_id INTEGER PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  const stmts = {
    byUser: db.prepare('SELECT token FROM calendar_tokens WHERE user_id = ?'),
    byToken: db.prepare('SELECT user_id FROM calendar_tokens WHERE token = ?'),
    upsert: db.prepare(`
      INSERT INTO calendar_tokens (user_id, token, created_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET token = excluded.token, created_at = excluded.created_at
    `)
  };
  const newToken = () => crypto.randomBytes(24).toString('hex');
  return {
    getOrCreateToken(userId) {
      const row = stmts.byUser.get(userId);
      if (row) return row.token;
      const token = newToken();
      stmts.upsert.run(userId, token, Date.now());
      return token;
    },
    resetToken(userId) {
      const token = newToken();
      stmts.upsert.run(userId, token, Date.now());
      return token;
    },
    userIdForToken(token) {
      if (!isValidCalendarToken(token)) return null;
      return stmts.byToken.get(token)?.user_id ?? null;
    }
  };
}

// --- FORMAT ICALENDAR (RFC 5545) ---

export function escapeIcsText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/[;,]/g, m => '\\' + m);
}

// Lignes de 75 octets au plus, continuées par un espace ; sans couper un caractère UTF-8
export function foldIcsLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const parts = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch, 'utf8');
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      limit = 74; // l'espace de continuation compte
    }
    current += ch;
    currentBytes += bytes;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function icsDate(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function mediaTitle(media) {
  return media?.title?.userPreferred || media?.title?.romaji || media?.title?.english || 'Anime';
}

/**
 * @param {Array<{id, episode, airingAt, media}>} airings  planning AniList (airingAt en secondes)
 * @param {{ baseUrl, now, calName }} opts
 */
export function buildCalendarIcs(airings, { baseUrl = '', now = Date.now(), calName = 'Animflix — mes animes' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Animflix//Planning des episodes//FR',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
    'X-WR-CALDESC:Prochains épisodes de votre liste AniList',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];
  const sorted = [...airings].sort((a, b) => a.airingAt - b.airingAt);
  for (const a of sorted) {
    const media = a.media || {};
    const title = mediaTitle(media);
    const total = Number(media.episodes) || null;
    const isFinal = total && a.episode === total;
    const minutes = Number(media.duration) > 0 ? Number(media.duration) : CALENDAR_CONFIG.DEFAULT_EPISODE_MINUTES;
    const start = a.airingAt * 1000;
    const link = baseUrl ? `${baseUrl}/#/anime/${media.id}?ep=${a.episode}` : '';
    const description = [
      `Épisode ${a.episode}${total ? ` sur ${total}` : ''} de ${title}${isFinal ? ' (dernier épisode)' : ''}.`,
      link ? `Regarder sur Animflix : ${link}` : ''
    ].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:anilist-airing-${a.id || `${media.id}-${a.episode}`}@animflix`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(start)}`,
      `DTEND:${icsDate(start + minutes * 60000)}`,
      `SUMMARY:${escapeIcsText(`${title} · Ép. ${a.episode}${isFinal ? ' (final)' : ''}`)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      ...(link ? [`URL:${link}`] : []),
      'CATEGORIES:Anime',
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}

// --- DONNÉES ANILIST ---

const LIST_QUERY = `
  query ($userId: Int, $statuses: [MediaListStatus]) {
    MediaListCollection(userId: $userId, type: ANIME, status_in: $statuses) {
      lists { entries { media { id status } } }
    }
  }
`;

const AIRINGS_QUERY = `
  query ($ids: [Int], $from: Int, $to: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage }
      airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
        id
        episode
        airingAt
        media { id episodes duration title { userPreferred romaji english } }
      }
    }
  }
`;

/**
 * Diffusions récentes et à venir des animes de la liste de l'utilisateur
 */
export async function fetchUserAirings(user, { fetchAnilist, includePlanning = false, now = Date.now() }) {
  const statuses = includePlanning ? ['CURRENT', 'REPEATING', 'PLANNING'] : ['CURRENT', 'REPEATING'];
  const data = await fetchAnilist(LIST_QUERY, { userId: Number(user.anilist_id), statuses }, user.anilist_token);
  const ids = new Set();
  for (const list of data?.MediaListCollection?.lists || []) {
    for (const e of list.entries || []) {
      // Seuls les animes en diffusion ou à venir ont un planning
      if (e?.media?.id && (e.media.status === 'RELEASING' || e.media.status === 'NOT_YET_RELEASED')) ids.add(e.media.id);
    }
  }
  if (ids.size === 0) return [];

  const nowS = Math.floor(now / 1000);
  const from = nowS - CALENDAR_CONFIG.PAST_WINDOW_S;
  const to = nowS + CALENDAR_CONFIG.FUTURE_WINDOW_S;
  const airings = [];
  for (let page = 1; page <= CALENDAR_CONFIG.MAX_AIRING_PAGES; page++) {
    const res = await fetchAnilist(AIRINGS_QUERY, { ids: [...ids], from, to, page }, user.anilist_token);
    airings.push(...(res?.Page?.airingSchedules || []));
    if (!res?.Page?.pageInfo?.hasNextPage) break;
  }
  return airings.filter(a => a?.media?.id && Number.isFinite(a.airingAt) && Number.isFinite(a.episode));
}

/**
 * Agenda d'un utilisateur, mis en cache 30 min. En cas d'échec AniList, la dernière version connue est servie.
 */
export function createCalendarBuilder({ fetchAnilist, now = () => Date.now() }) {
  const cache = new Map(); // `${userId}|${planning}` -> { at, ics }
  return async function calendarForUser(user, { includePlanning = false, baseUrl = '' } = {}) {
    const key = `${user.id}|${includePlanning ? 1 : 0}|${baseUrl}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < CALENDAR_CONFIG.CACHE_TTL_MS) return cached.ics;
    try {
      const airings = await fetchUserAirings(user, { fetchAnilist, includePlanning, now: now() });
      const ics = buildCalendarIcs(airings, {
        baseUrl,
        now: now(),
        calName: includePlanning ? 'Animflix — en cours & à voir' : 'Animflix — mes animes en cours'
      });
      cache.set(key, { at: now(), ics });
      return ics;
    } catch (err) {
      if (cached) return cached.ics;
      throw err;
    }
  };
}
