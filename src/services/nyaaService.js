import Parser from 'rss-parser';
import axios from 'axios';
import { NYAA_PRIMARY_URL, NYAA_FALLBACK_URLS, TMDB_API_KEY } from '../config/constants.js';
import { metadataCache, searchCache } from '../utils/cache.js';
import { cleanAnimeTitle, parseAnimeDetails } from '../utils/animeParser.js';
import { searchAllTorrents } from './torrentAggregator.js';

let currentWorkingNyaaUrl = NYAA_PRIMARY_URL;

export function getCurrentNyaaUrl() {
  return currentWorkingNyaaUrl;
}

export function setWorkingNyaaUrl(url) {
  if (url) {
    currentWorkingNyaaUrl = url.replace(/\/+$/, '');
  }
}

/**
 * Teste la latence et l'accessibilité de chaque miroir Nyaa
 */
export async function testNyaaMirrors() {
  const results = [];
  for (const mirror of NYAA_FALLBACK_URLS) {
    const start = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(`${mirror}/?page=rss`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        },
        signal: controller.signal
      });
      // Un miroir qui redirige vers une page HTML (ou un challenge Cloudflare) n'est pas exploitable
      const body = res.ok ? await res.text() : '';
      clearTimeout(timeoutId);
      const latencyMs = Date.now() - start;
      const isRss = body.includes('<rss');
      results.push({
        url: mirror,
        ok: res.ok && isRss,
        ...(res.ok && !isRss ? { error: 'Pas de flux RSS' } : {}),
        status: res.status,
        latencyMs,
        isCurrent: mirror === currentWorkingNyaaUrl
      });
    } catch (e) {
      clearTimeout(timeoutId);
      results.push({
        url: mirror,
        ok: false,
        status: 0,
        latencyMs: Date.now() - start,
        error: e.message,
        isCurrent: mirror === currentWorkingNyaaUrl
      });
    }
  }
  return results;
}

const parser = new Parser({
  customFields: {
    item: [
      ['nyaa:seeders', 'seeders'],
      ['nyaa:size', 'size'],
      ['nyaa:infoHash', 'infoHash']
    ],
  },
});

/**
 * Récupération RSS Nyaa résiliente avec cascade de miroirs
 */
export async function fetchNyaaRss(searchQuery, category) {
  const mirrors = [currentWorkingNyaaUrl, ...NYAA_FALLBACK_URLS].filter((v, i, a) => a.indexOf(v) === i);
  let lastError = null;

  for (const mirror of mirrors) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const url = `${mirror}/?page=rss&q=${encodeURIComponent(searchQuery)}&c=${category}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
        },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} sur ${mirror}`);
      }

      const xmlText = await response.text();
      const feed = await parser.parseString(xmlText);
      currentWorkingNyaaUrl = mirror;
      return feed.items?.slice(0, 25) || [];
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Échec Nyaa sur ${mirror} (${err.message}), essai miroir suivant...`);
    }
  }

  throw lastError || new Error("Impossible de joindre les serveurs Nyaa");
}

/**
 * Récupération métadonnées (Affiche & Note) avec mise en cache et multi-sources (TMDB + TVMaze + Kitsu)
 */
export async function getAnimeMetadata(cleanTitle) {
  if (!cleanTitle) return { poster: null, rating: "N/A" };
  const key = cleanTitle.toLowerCase();

  const cached = metadataCache.get(key);
  if (cached) {
    return { poster: cached.poster, rating: cached.rating };
  }

  let poster = null;
  let rating = "N/A";

  // 1. Essai TMDB si la clé est valide (32 caractères hex)
  if (TMDB_API_KEY && TMDB_API_KEY.length === 32) {
    try {
      const tmdbRes = await axios.get('https://api.themoviedb.org/3/search/multi', {
        params: { api_key: TMDB_API_KEY, query: cleanTitle, language: 'fr-FR' },
        timeout: 2500
      });
      if (tmdbRes.data?.results?.length > 0) {
        const info = tmdbRes.data.results[0];
        if (info.poster_path) poster = `https://image.tmdb.org/t/p/w500${info.poster_path}`;
        if (info.vote_average) rating = info.vote_average.toFixed(1);
      }
    } catch (e) {}
  }

  // 2. TVMaze API (100% gratuit, ultra-rapide <50ms, sans clé requise)
  if (!poster) {
    try {
      const tvRes = await axios.get('https://api.tvmaze.com/singlesearch/shows', {
        params: { q: cleanTitle },
        timeout: 1500
      });
      if (tvRes.data) {
        poster = tvRes.data.image?.medium || tvRes.data.image?.original || null;
        if (tvRes.data.rating?.average) rating = tvRes.data.rating.average.toFixed(1);
      }
    } catch (e) {}
  }

  // 3. Fallback automatique Kitsu API (spécialisée anime, sans clé requise)
  if (!poster) {
    const fetchKitsu = async (queryText) => {
      try {
        const kitsuRes = await axios.get('https://kitsu.io/api/edge/anime', {
          params: { 'filter[text]': queryText, 'page[limit]': 1 },
          timeout: 2500
        });
        return kitsuRes.data?.data?.[0]?.attributes;
      } catch (e) {
        return null;
      }
    };

    let item = await fetchKitsu(cleanTitle);
    if (!item && cleanTitle.split(' ').length > 2) {
      const shortTitle = cleanTitle.split(' ').slice(0, 3).join(' ');
      item = await fetchKitsu(shortTitle);
    }

    if (item) {
      poster = item.posterImage?.medium || item.posterImage?.small || null;
      if (item.averageRating) rating = (parseFloat(item.averageRating) / 10).toFixed(1);
    }
  }

  const result = { poster, rating, timestamp: Date.now() };
  metadataCache.set(key, result);
  return { poster, rating };
}

/**
 * Recherche complète d'animes multi-sources (Nyaa + Tokyo Toshokan + Torznab)
 */
export async function searchAnime(query, type = 'vostfr', options = {}) {
  return searchAllTorrents(query, type, options);
}
