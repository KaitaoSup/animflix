import { fetchNyaaRss, getAnimeMetadata, getCurrentNyaaUrl } from './nyaaService.js';
import { fetchTokyoToshoRss } from './tokyoToshoService.js';
import { fetchTorznab, getTorznabConfig } from './torznabService.js';
import { cleanAnimeTitle, parseAnimeDetails } from '../utils/animeParser.js';
import { searchCache } from '../utils/cache.js';
import { getServerSetting } from '../../database.js';
import { TORRENT_SOURCE_DEFAULT_MODE } from '../config/constants.js';

/**
 * Normalise un hash torrent pour comparaison insensible à la casse
 */
function normalizeHash(hash) {
  if (!hash) return '';
  return String(hash).trim().toLowerCase();
}

/**
 * Déduplication intelligente des torrents provenant de plusieurs sources
 */
export function deduplicateTorrents(rawItems) {
  const seenHashes = new Set();
  const titleMap = new Map();
  const results = [];

  for (const item of rawItems) {
    if (!item || !item.title) continue;

    // 1. Déduplication par infoHash (exacte)
    const hash = normalizeHash(item.infoHash);
    if (hash) {
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
    }

    // 2. Déduplication par signature de release (Titre nettoyé + Résolution)
    const normTitle = item.title
      .toLowerCase()
      .replace(/[\s\._\-+]+/g, ' ')
      .trim();

    if (titleMap.has(normTitle)) {
      const existing = titleMap.get(normTitle);
      // Garder celui avec le plus de seeders
      if ((item.seeders || 0) > (existing.seeders || 0)) {
        const idx = results.indexOf(existing);
        if (idx !== -1) results[idx] = item;
        titleMap.set(normTitle, item);
      }
      continue;
    }

    titleMap.set(normTitle, item);
    results.push(item);
  }

  return results;
}

/**
 * Recherche multi-sources avec cascade résiliente et déduplication
 * @param {string} query - Nom de l'anime recherché
 * @param {string} type - 'vostfr' | 'vf' | 'multisub' | 'sub'
 * @param {object} options - Options de recherche (mode, etc.)
 */
export async function searchAllTorrents(query, type = 'vostfr', options = {}) {
  if (!query) return [];

  const mode = options.mode || getServerSetting('torrent_source_mode') || TORRENT_SOURCE_DEFAULT_MODE;
  const cacheKey = `${query.toLowerCase()}_${type}_${mode}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const torznabConfig = getTorznabConfig();
  let collectedItems = [];

  if (mode === 'nyaa_only') {
    // Mode Nyaa pur (sans fallback externe)
    try {
      const nyaaCategory = (type === 'vostfr' || type === 'vf') ? '1_3' : '1_2';
      let nyaaQuery = query;
      if (type === 'vostfr') nyaaQuery += ' vostfr';
      else if (type === 'vf') nyaaQuery += ' vf';
      else if (type === 'multisub') nyaaQuery += ' multi';

      const items = await fetchNyaaRss(nyaaQuery, nyaaCategory);
      collectedItems = items.map(t => ({
        title: t.title,
        link: t.link,
        magnetLink: t.infoHash 
          ? `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(t.title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`
          : t.link,
        infoHash: t.infoHash || '',
        size: t.size || 'N/A',
        seeders: parseInt(t.seeders, 10) || 0,
        pubDate: t.pubDate,
        source: 'nyaa'
      }));
    } catch (e) {
      console.warn('⚠️ Échec recherche Nyaa seule:', e.message);
    }
  } else if (mode === 'aggregate') {
    // Mode Agrégation : recherche simultanée sur toutes les sources configurées
    const tasks = [];

    // Source 1 : Nyaa
    tasks.push(
      (async () => {
        const nyaaCategory = (type === 'vostfr' || type === 'vf') ? '1_3' : '1_2';
        let nyaaQuery = query;
        if (type === 'vostfr') nyaaQuery += ' vostfr';
        else if (type === 'vf') nyaaQuery += ' vf';
        else if (type === 'multisub') nyaaQuery += ' multi';
        const items = await fetchNyaaRss(nyaaQuery, nyaaCategory);
        return items.map(t => ({
          title: t.title,
          link: t.link,
          magnetLink: t.infoHash 
            ? `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(t.title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`
            : t.link,
          infoHash: t.infoHash || '',
          size: t.size || 'N/A',
          seeders: parseInt(t.seeders, 10) || 0,
          pubDate: t.pubDate,
          source: 'nyaa'
        }));
      })().catch(err => {
        console.warn('⚠️ Source Nyaa (agrégation) en échec:', err.message);
        return [];
      })
    );

    // Source 2 : Tokyo Toshokan
    tasks.push(fetchTokyoToshoRss(query, type).catch(() => []));

    // Source 3 : Torznab (Jackett / Prowlarr)
    if (torznabConfig.enabled) {
      tasks.push(fetchTorznab(query, type).catch(() => []));
    }

    const settled = await Promise.allSettled(tasks);
    settled.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        collectedItems.push(...r.value);
      }
    });
  } else {
    // Mode Résilient par défaut (Cascade intelligente)
    // 1. Essai prioritaire sur Nyaa (avec sa propre cascade de miroirs)
    let nyaaWorked = false;
    try {
      const nyaaCategory = (type === 'vostfr' || type === 'vf') ? '1_3' : '1_2';
      let nyaaQuery = query;
      if (type === 'vostfr') nyaaQuery += ' vostfr';
      else if (type === 'vf') nyaaQuery += ' vf';
      else if (type === 'multisub') nyaaQuery += ' multi';

      const items = await fetchNyaaRss(nyaaQuery, nyaaCategory);
      if (items.length > 0) {
        nyaaWorked = true;
        collectedItems.push(...items.map(t => ({
          title: t.title,
          link: t.link,
          magnetLink: t.infoHash 
            ? `magnet:?xt=urn:btih:${t.infoHash}&dn=${encodeURIComponent(t.title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`
            : t.link,
          infoHash: t.infoHash || '',
          size: t.size || 'N/A',
          seeders: parseInt(t.seeders, 10) || 0,
          pubDate: t.pubDate,
          source: 'nyaa'
        })));
      }
    } catch (err) {
      console.warn(`⚠️ Échec cascade Nyaa (${err.message}), déclenchement du repli multi-sources...`);
    }

    // Si recherche VF et Torznab configuré, interroger aussi Torznab (les animes VF sont rares sur Nyaa)
    if (type === 'vf' && torznabConfig.enabled) {
      try {
        const torznabItems = await fetchTorznab(query, 'vf');
        if (torznabItems.length > 0) {
          collectedItems.push(...torznabItems);
        }
      } catch (e) {}
    }

    // 2. Si Nyaa a échoué ou n'a renvoyé aucun résultat, repli automatique sur Tokyo Toshokan & Torznab
    if (!nyaaWorked || collectedItems.length === 0) {
      console.log(`ℹ️ Repli multi-sources activé pour "${query}" (Tokyo Toshokan + Torznab)`);
      const fallbackTasks = [
        fetchTokyoToshoRss(query, type).catch(() => [])
      ];
      if (torznabConfig.enabled && type !== 'vf') {
        fallbackTasks.push(fetchTorznab(query, type).catch(() => []));
      }
      const settled = await Promise.allSettled(fallbackTasks);
      settled.forEach(r => {
        if (r.status === 'fulfilled' && Array.isArray(r.value)) {
          collectedItems.push(...r.value);
        }
      });
    }
  }

  // Déduplication
  const uniqueItems = deduplicateTorrents(collectedItems);

  if (uniqueItems.length === 0) {
    searchCache.set(cacheKey, []);
    return [];
  }

  // Récupération métadonnées franchise (affiche + note)
  const queryClean = cleanAnimeTitle(query) || query;
  const defaultMeta = await getAnimeMetadata(queryClean);

  const titleCleanMap = new Map();
  uniqueItems.forEach(t => {
    const clean = cleanAnimeTitle(t.title);
    titleCleanMap.set(t.title, clean);
  });

  const uniqueCleanTitles = [...new Set(Array.from(titleCleanMap.values()))];
  const metaLookup = new Map();

  if (defaultMeta && defaultMeta.poster) {
    uniqueCleanTitles.forEach(c => metaLookup.set(c, defaultMeta));
  } else {
    const titlesToFetch = uniqueCleanTitles.slice(0, 4);
    await Promise.all(titlesToFetch.map(async (clean) => {
      const meta = await getAnimeMetadata(clean);
      metaLookup.set(clean, meta);
    }));
  }

  // Construction des résultats finaux enrichis
  const videos = uniqueItems.map(t => {
    const details = parseAnimeDetails(t.title);
    const clean = titleCleanMap.get(t.title) || details.animeName;
    const meta = metaLookup.get(clean) || metaLookup.get(details.animeName) || defaultMeta || { poster: null, rating: "N/A" };

    return {
      titre: t.title,
      cleanTitle: clean,
      animeName: details.animeName,
      season: details.season,
      episode: details.episode,
      resolution: details.resolution,
      audioLang: details.audioLang,
      lienMagnet: t.magnetLink || t.link,
      taille: t.size || 'N/A',
      seeders: parseInt(t.seeders, 10) || 0,
      poster: meta.poster,
      rating: meta.rating,
      source: t.source || 'nyaa'
    };
  });

  searchCache.set(cacheKey, videos);
  return videos;
}

/**
 * Récupère le statut complet des sources torrent
 */
export function getTorrentSourcesStatus() {
  const mode = getServerSetting('torrent_source_mode') || TORRENT_SOURCE_DEFAULT_MODE;
  const torznabConfig = getTorznabConfig();

  return {
    mode,
    sources: {
      nyaa: {
        id: 'nyaa',
        name: 'Nyaa.si',
        activeUrl: getCurrentNyaaUrl(),
        enabled: true
      },
      tokyoTosho: {
        id: 'tokyotosho',
        name: 'Tokyo Toshokan',
        url: 'https://www.tokyotosho.info',
        enabled: mode !== 'nyaa_only'
      },
      torznab: {
        id: 'torznab',
        name: 'Torznab (Jackett / Prowlarr)',
        configured: torznabConfig.enabled,
        url: torznabConfig.url,
        hasApiKey: Boolean(torznabConfig.apiKey)
      }
    }
  };
}
