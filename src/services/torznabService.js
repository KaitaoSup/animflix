import Parser from 'rss-parser';
import { TORZNAB_DEFAULT_URL, TORZNAB_DEFAULT_API_KEY } from '../config/constants.js';
import { getServerSetting } from '../../database.js';

const torznabParser = new Parser({
  customFields: {
    item: [
      ['torznab:attr', 'torznabAttrs', { keepArray: true }],
      ['enclosure', 'enclosure'],
      ['size', 'size']
    ]
  }
});

/**
 * Formate un nombre d'octets en chaîne lisible (ex: 1.4 GiB)
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === '') return 'N/A';
  const num = typeof bytes === 'string' ? parseFloat(bytes) : bytes;
  if (isNaN(num) || num < 0) return 'N/A';
  if (num === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.floor(Math.log(num) / Math.log(k));
  return parseFloat((num / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Récupère l'URL et la clé API Torznab effectives (BDD prioritaire, sinon env)
 */
export function getTorznabConfig(overrides = {}) {
  const url = (overrides.url || getServerSetting('torznab_url') || TORZNAB_DEFAULT_URL || '').replace(/\/+$/, '');
  const apiKey = overrides.apiKey || getServerSetting('torznab_api_key') || TORZNAB_DEFAULT_API_KEY || '';
  const categories = overrides.categories || getServerSetting('torznab_categories') || '5070,5000';
  return { url, apiKey, categories, enabled: Boolean(url) };
}

/**
 * Recherche de torrents via l'API standard Torznab (Jackett / Prowlarr)
 * @param {string} searchQuery - Terme de recherche
 * @param {string} type - 'vostfr' | 'vf' | 'multisub' | 'sub'
 * @param {object} options - Options de configuration
 * @returns {Promise<Array>} Liste d'éléments torrents normalisés
 */
export async function fetchTorznab(searchQuery, type = 'vostfr', options = {}) {
  const { url, apiKey, categories, enabled } = getTorznabConfig(options);
  if (!enabled || !url) return [];

  let queryTerm = searchQuery;
  if (type === 'vostfr') {
    queryTerm = `${searchQuery} vostfr`;
  } else if (type === 'vf') {
    queryTerm = `${searchQuery} vf`;
  } else if (type === 'multisub') {
    queryTerm = `${searchQuery} multi`;
  }

  const items = await executeTorznabQuery({ url, apiKey, categories, term: queryTerm });

  // Si 0 résultat pour vostfr/multi, essayer le nom sans suffixe
  if (items.length === 0 && (type === 'vostfr' || type === 'multisub')) {
    return await executeTorznabQuery({ url, apiKey, categories, term: searchQuery });
  }

  return items;
}

async function executeTorznabQuery({ url, apiKey, categories, term }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  // Construction de l'URL Torznab conforme au standard Newznab/Torznab
  const queryParams = new URLSearchParams({
    t: 'search',
    q: term,
    offset: '0',
    limit: '30'
  });
  if (apiKey) queryParams.set('apikey', apiKey);
  if (categories) queryParams.set('cat', categories);

  const requestUrl = `${url}?${queryParams.toString()}`;

  try {
    const response = await fetch(requestUrl, {
      headers: {
        'User-Agent': 'Animflix/1.2 (Torznab Client)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} sur Torznab`);
    }

    const xmlText = await response.text();
    if (!xmlText || !xmlText.includes('<item')) {
      return [];
    }

    const feed = await torznabParser.parseString(xmlText);
    const rawItems = feed.items || [];

    const mapped = [];
    for (const item of rawItems) {
      const attrs = item.torznabAttrs || [];
      const attrMap = new Map();
      attrs.forEach(a => {
        if (a && a.$ && a.$.name) {
          attrMap.set(a.$.name.toLowerCase(), a.$.value);
        }
      });

      let seeders = 0;
      if (attrMap.has('seeders')) {
        seeders = parseInt(attrMap.get('seeders'), 10) || 0;
      }

      let infoHash = attrMap.get('infohash') || '';

      // Recherche du lien magnet (enclosure, magneturl ou lien)
      let magnet = attrMap.get('magneturl') || '';
      if (!magnet && item.enclosure && item.enclosure.url && item.enclosure.url.startsWith('magnet:')) {
        magnet = item.enclosure.url;
      }
      if (!magnet && item.link && item.link.startsWith('magnet:')) {
        magnet = item.link;
      }

      // Si pas de lien magnet direct mais qu'on a l'infoHash, reconstituer le magnet
      if (!magnet && infoHash) {
        magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(item.title || 'Torznab')}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`;
      } else if (!infoHash && magnet) {
        const hashMatch = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        if (hashMatch) infoHash = hashMatch[1];
      }

      // Calcul de la taille
      let sizeStr = 'N/A';
      if (item.size) {
        sizeStr = isNaN(item.size) ? item.size : formatBytes(item.size);
      } else if (item.enclosure && item.enclosure.length) {
        sizeStr = formatBytes(item.enclosure.length);
      } else if (attrMap.has('size')) {
        sizeStr = formatBytes(attrMap.get('size'));
      }

      if (!magnet && !item.link) continue;

      mapped.push({
        title: item.title ? item.title.trim() : 'Sans titre',
        link: item.link || magnet,
        magnetLink: magnet || item.link,
        infoHash,
        size: sizeStr,
        seeders,
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        source: 'torznab'
      });
    }

    return mapped.slice(0, 30);
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`⚠️ Échec recherche Torznab (${err.message})`);
    return [];
  }
}

/**
 * Teste la connexion à une instance Jackett / Prowlarr via Torznab
 */
export async function testTorznabConnection({ url, apiKey }) {
  if (!url) {
    return { success: false, message: 'URL Torznab non renseignée.' };
  }
  const cleanUrl = url.replace(/\/+$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);

  const capsParams = new URLSearchParams({ t: 'caps' });
  if (apiKey) capsParams.set('apikey', apiKey);

  const capsUrl = `${cleanUrl}?${capsParams.toString()}`;

  try {
    const res = await fetch(capsUrl, {
      headers: {
        'User-Agent': 'Animflix/1.2 (Torznab Tester)'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return { success: false, message: `Réponse serveur HTTP ${res.status}` };
    }

    const xml = await res.text();
    if (xml.includes('<caps') || xml.includes('<server') || xml.includes('<categories')) {
      const serverTitle = xml.match(/<server[^>]*title="([^"]+)"/i)?.[1] || 'Torznab Indexer';
      const version = xml.match(/<server[^>]*version="([^"]+)"/i)?.[1] || '';
      return {
        success: true,
        message: `Connecté avec succès à ${serverTitle} ${version}`.trim()
      };
    }

    // Essayer une recherche test si caps n'est pas implémenté
    const testParams = new URLSearchParams({ t: 'search', q: 'test', limit: '1' });
    if (apiKey) testParams.set('apikey', apiKey);
    const testRes = await fetch(`${cleanUrl}?${testParams.toString()}`);
    if (testRes.ok) {
      return { success: true, message: 'Connecté avec succès à Torznab (search validé).' };
    }

    return { success: false, message: 'Réponse XML Torznab inattendue.' };
  } catch (e) {
    clearTimeout(timeoutId);
    return { success: false, message: `Impossible de contacter Torznab : ${e.message}` };
  }
}
