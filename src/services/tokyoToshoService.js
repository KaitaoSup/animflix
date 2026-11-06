import Parser from 'rss-parser';
import { TOKYO_TOSHO_URL } from '../config/constants.js';

const parser = new Parser();

/**
 * Recherche résiliente sur Tokyo Toshokan (indexeur anime historique et indépendant)
 * @param {string} searchQuery - Terme de recherche
 * @param {string} type - 'vostfr' | 'vf' | 'multisub' | 'sub'
 * @returns {Promise<Array>} Liste d'éléments torrents normalisés
 */
export async function fetchTokyoToshoRss(searchQuery, type = 'vostfr') {
  if (!searchQuery) return [];

  // Tokyo Toshokan : type 1 = Anime
  let term = searchQuery;
  if (type === 'vostfr') {
    term = `${searchQuery} vostfr`;
  } else if (type === 'vf') {
    term = `${searchQuery} vf`;
  } else if (type === 'multisub') {
    term = `${searchQuery} multi`;
  }

  const items = await executeTokyoToshoQuery(term);

  // Si aucun résultat pour "vostfr" ou "multi", tenter la recherche plus large sur le nom seul
  if (items.length === 0 && (type === 'vostfr' || type === 'multisub')) {
    const fallbackItems = await executeTokyoToshoQuery(searchQuery);
    return fallbackItems;
  }

  return items;
}

async function executeTokyoToshoQuery(term) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  const url = `${TOKYO_TOSHO_URL}/rss.php?terms=${encodeURIComponent(term)}&type=1`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} sur Tokyo Toshokan`);
    }

    const xmlText = await response.text();

    // Tokyo Toshokan renvoie littéralement "</channel>\n</rss>" quand il n'y a aucun résultat
    if (!xmlText || !xmlText.includes('<item>') || xmlText.trim().startsWith('</channel>')) {
      return [];
    }

    const feed = await parser.parseString(xmlText);
    const rawItems = feed.items || [];

    const mapped = [];
    for (const item of rawItems) {
      const content = item.content || item['content:encoded'] || '';
      
      // Extraction du lien magnet dans le corps HTML de TokyoTosho
      let magnet = null;
      const magnetMatch = content.match(/href="(magnet:[^"]+)"/i);
      if (magnetMatch) {
        magnet = magnetMatch[1].replace(/&amp;/g, '&');
      } else if (item.link && item.link.startsWith('magnet:')) {
        magnet = item.link;
      }

      // Extraction de l'infoHash
      let infoHash = '';
      if (magnet) {
        const hashMatch = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
        if (hashMatch) infoHash = hashMatch[1];
      }

      // Extraction de la taille
      const sizeMatch = content.match(/Size:\s*([0-9.]+\s*[KMGT]?B)/i);
      const size = sizeMatch ? sizeMatch[1].trim() : (item.size || 'N/A');

      if (!magnet && !item.link) continue;

      mapped.push({
        title: item.title ? item.title.trim() : 'Sans titre',
        link: item.link || magnet,
        magnetLink: magnet || item.link,
        infoHash,
        size,
        seeders: 5, // TokyoTosho ne publie pas le décompte live dans son RSS, valeur indicative active
        pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
        source: 'tokyotosho'
      });
    }

    return mapped.slice(0, 30);
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`⚠️ Échec recherche Tokyo Toshokan (${err.message})`);
    return [];
  }
}

/**
 * Test rapide de disponibilité de Tokyo Toshokan
 */
export async function testTokyoToshoConnection() {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${TOKYO_TOSHO_URL}/rss.php?filter=1`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - start;
    return { ok: res.ok, latencyMs, status: res.status };
  } catch (e) {
    clearTimeout(timeoutId);
    return { ok: false, error: e.message };
  }
}
