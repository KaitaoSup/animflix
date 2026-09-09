import express from 'express';
import Parser from 'rss-parser';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const execPromise = promisify(exec);

// --- CONFIGURATION ---
const TORRSERVER_LOCAL_URL = "http://127.0.0.1:8090"; // Connexion interne ultra-rapide
const TMDB_API_KEY = "TMDB API KEY"; // Optionnel : clé TMDB (Kitsu est utilisé en fallback automatique sans clé)

// Dossier de cache persistant pour les sous-titres WebVTT
const SUB_CACHE_DIR = path.join(process.cwd(), 'cache', 'subtitles');
if (!fs.existsSync(SUB_CACHE_DIR)) {
  fs.mkdirSync(SUB_CACHE_DIR, { recursive: true });
}

// Extraction du hash SHA1 depuis un magnet link
function getTorrentHash(magnet) {
  if (!magnet) return 'unknown';
  const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  if (match) return match[1].toLowerCase();
  let hash = 0;
  for (let i = 0; i < magnet.length; i++) {
    hash = ((hash << 5) - hash) + magnet.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
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

// --- CACHES EN MÉMOIRE (HAUTE PERFORMANCE) ---
const metadataCache = new Map(); // key: cleanTitle, val: { poster, rating, timestamp }
const METADATA_TTL = 1000 * 60 * 60 * 24; // 24 heures

const searchCache = new Map(); // key: query+type, val: { results, timestamp }
const SEARCH_TTL = 1000 * 60 * 5; // 5 minutes

// Nettoyeur intelligent de titre d'anime pour un matching API précis
function cleanAnimeTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\[.*?\]/g, ' ') // Retire [Fansub], [1080p], etc.
    .replace(/\(.*?\)/g, ' ') // Retire (1080p), (TV), etc.
    .replace(/\b\d\s*[._]\s*\d\b/g, ' ') // Retire les canaux audio 2.0, 5.1
    .replace(/\b(1080p|720p|480p|2160p|4k|x264|x265|x\.265|x\.264|hevc|av1|aac|flac|web-dl|webrip|bdrip|bd|bluray|dvd|vostfr|vf|multi|multisubs?|sub|mkv|mp4|avi|cr|crunchyroll|10bit|8bit|remux|uncensored|dual audio|final)\b/gi, ' ')
    .replace(/\b(s\d+e\d+|s\d+|e\d+|ep\s*\d+|episode\s*\d+|saison\s*\d+|season\s*\d+)\b/gi, ' ')
    .replace(/\s*-\s*\d{1,4}\b/g, ' ')
    .replace(/\b\d{1,3}\b(?=\s*$)/g, ' ')
    .replace(/[._\-\+\/\\:~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Récupération métadonnées (Affiche & Note) avec mise en cache et double source (TMDB + Kitsu)
async function getAnimeMetadata(cleanTitle) {
  if (!cleanTitle) return { poster: null, rating: "N/A" };
  const key = cleanTitle.toLowerCase();

  const cached = metadataCache.get(key);
  if (cached && (Date.now() - cached.timestamp < METADATA_TTL)) {
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

// Échappement sécurisé pour les filtres FFmpeg
function escapeFfmpegPath(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "'\\''")
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- API RECHERCHE ULTRA-RAPIDE (CACHE + DÉDUPLICATION + POSTER PRIORITAIRE) ---
app.get('/api/search', async (req, res) => {
  let query = req.query.q?.trim();
  const type = req.query.type || 'vostfr';
  if (!query) return res.json([]);

  const cacheKey = `${query.toLowerCase()}_${type}`;
  const cached = searchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < SEARCH_TTL)) {
    return res.json(cached.results);
  }

  let searchQuery = query;
  let category = '1_0';
  if (type === 'vostfr') { searchQuery += ' vostfr'; category = '1_3'; } 
  else if (type === 'vf') { searchQuery += ' vf'; category = '1_3'; } 
  else if (type === 'multisub') { searchQuery += ' multi'; category = '1_2'; } 
  else if (type === 'sub') { category = '1_2'; }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    const response = await fetch(`https://nyaa.si/?page=rss&q=${encodeURIComponent(searchQuery)}&c=${category}`, {
      headers: { 
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' 
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    const xmlText = await response.text();
    const feed = await parser.parseString(xmlText);
    const items = feed.items?.slice(0, 25) || [];

    if (items.length === 0) {
      searchCache.set(cacheKey, { results: [], timestamp: Date.now() });
      return res.json([]);
    }

// Analyse détaillée des métadonnées Anime (Nom, Saison, Épisode, Résolution, Audio)
function parseAnimeDetails(rawTitle) {
  if (!rawTitle) {
    return {
      animeName: 'Anime',
      season: 'Saison 1',
      episode: 'Épisode 1',
      resolution: '1080p Full HD',
      audioLang: 'VOSTFR'
    };
  }

  // 1. Détection de la résolution
  let resolution = '1080p Full HD';
  if (/2160p|4k\b/i.test(rawTitle)) resolution = '4K Ultra HD';
  else if (/1080p/i.test(rawTitle)) resolution = '1080p Full HD';
  else if (/720p/i.test(rawTitle)) resolution = '720p HD';
  else if (/480p/i.test(rawTitle)) resolution = '480p SD';

  // 2. Détection de la langue / audio
  let audioLang = 'VOSTFR';
  if (/multi/i.test(rawTitle)) audioLang = 'MULTI (VF / VOSTFR)';
  else if (/\bvf\b/i.test(rawTitle)) audioLang = 'VF';
  else if (/vostfr/i.test(rawTitle)) audioLang = 'VOSTFR';
  else if (/vosta|sub\b/i.test(rawTitle)) audioLang = 'VOSTA';

  // 3. Détection de la Saison
  let season = null;
  const sMultiMatch = rawTitle.match(/S(\d{1,2})\s*[-+&]\s*S?(\d{1,2})/i) || 
                      rawTitle.match(/Saisons?\s*(\d{1,2})\s*[-+&]\s*(\d{1,2})/i);
  if (sMultiMatch) {
    const separator = /[-~]/.test(sMultiMatch[0]) ? ' à ' : ' & ';
    season = `Saisons ${parseInt(sMultiMatch[1], 10)}${separator}${parseInt(sMultiMatch[2], 10)}`;
  } else {
    const seMatch = rawTitle.match(/\bS0*(\d{1,2})E\d+/i);
    if (seMatch) {
      season = `Saison ${parseInt(seMatch[1], 10)}`;
    } else {
      const sMatch = rawTitle.match(/\bS(?:aison|eason)?\s*0*(\d{1,2})(?=[^\w]|$)/i) ||
                     rawTitle.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i) ||
                     rawTitle.match(/\bSeason\s*0*(\d{1,2})\b/i) ||
                     rawTitle.match(/\bSaison\s*0*(\d{1,2})\b/i);
      if (sMatch) {
        season = `Saison ${parseInt(sMatch[1], 10)}`;
      }
    }
  }
  if (!season) season = 'Saison 1';

  // 4. Détection de l'Épisode
  let episode = null;
  const epMultiMatch = rawTitle.match(/\b(?:E|EP|Episode|Épisode)\s*0*(\d{1,4})\s*[-~]\s*0*(\d{1,4})\b/i) ||
                       rawTitle.match(/[-_]\s*0*(\d{1,4})\s*[-~]\s*0*(\d{1,4})\b/);
  if (epMultiMatch) {
    episode = `Épisodes ${parseInt(epMultiMatch[1], 10)}-${parseInt(epMultiMatch[2], 10)}`;
  } else {
    const seMatch = rawTitle.match(/S\d{1,2}\s*E0*(\d{1,4})\b/i);
    if (seMatch) {
      episode = `Épisode ${parseInt(seMatch[1], 10)}`;
    } else {
      const epMatch = rawTitle.match(/\b(?:E|EP|Episode|Épisode)\s*0*(\d{1,4})\b/i) ||
                      rawTitle.match(/\s-\s0*(\d{1,4})(?:v\d+)?(?:\s|$|\[|\()/);
      if (epMatch) {
        episode = `Épisode ${parseInt(epMatch[1], 10)}`;
      }
    }
  }

  if (!episode) {
    if (/complete|intégrale|integrale|batch|s\d+[-+]s\d+/i.test(rawTitle)) {
      episode = 'Intégrale / Pack';
    } else if (/\bmovie\b|\bfilm\b/i.test(rawTitle)) {
      episode = 'Film';
    } else if (season && season !== 'Saison 1') {
      episode = 'Saison Complète';
    } else {
      episode = 'Épisode 1';
    }
  }

  // 5. Extraction du Nom de l'Anime
  let name = rawTitle.replace(/^\[.*?\]\s*/g, '');
  const cutPattern = /(\bS\d+|\bSeason\s*\d+|\bSaison\s*\d+|\b\d+(?:st|nd|rd|th)\s+Season|\s-\s\d+|\bE\d{1,4}\b|\bEP\s*\d+|\bEpisode\s*\d+|\bÉpisode\s*\d+|\b1080p\b|\b720p\b|\b4k\b|\b2160p\b|\bVOSTFR\b|\bVF\b|\bMULTI\b)/i;
  const matchCut = name.search(cutPattern);
  if (matchCut > 2) {
    name = name.substring(0, matchCut);
  }
  name = name
    .replace(/\(.*?\)/g, ' ')
    .replace(/\[.*?\]/g, ' ')
    .replace(/[-_.~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!name || name.length < 2) {
    name = cleanAnimeTitle(rawTitle) || 'Anime';
  }

  return { animeName: name, season, episode, resolution, audioLang };
}

    // 1. Récupération prioritaire et ultra-rapide de l'affiche de la franchise
    const queryClean = cleanAnimeTitle(query) || query;
    const defaultMeta = await getAnimeMetadata(queryClean);

    // 2. Déduplication des titres nettoyés
    const titleCleanMap = new Map();
    items.forEach(t => {
      const clean = cleanAnimeTitle(t.title);
      titleCleanMap.set(t.title, clean);
    });

    const uniqueCleanTitles = [...new Set(Array.from(titleCleanMap.values()))];
    const metaLookup = new Map();

    // Si defaultMeta a trouvé l'affiche, l'assigner directement pour éviter des dizaines d'appels API Kitsu inutiles
    if (defaultMeta && defaultMeta.poster) {
      uniqueCleanTitles.forEach(c => metaLookup.set(c, defaultMeta));
    } else {
      // Sinon, récupérer pour un maximum de 3 titres uniques pour ne pas bloquer la recherche
      const titlesToFetch = uniqueCleanTitles.slice(0, 4);
      await Promise.all(titlesToFetch.map(async (clean) => {
        const meta = await getAnimeMetadata(clean);
        metaLookup.set(clean, meta);
      }));
    }

    // 3. Construction des résultats avec métadonnées enrichies et lien magnet direct
    const videos = items.map(t => {
      const details = parseAnimeDetails(t.title);
      const clean = titleCleanMap.get(t.title) || details.animeName;
      const meta = metaLookup.get(clean) || metaLookup.get(details.animeName) || defaultMeta || { poster: null, rating: "N/A" };
      const infoHash = t.infoHash || '';
      const magnetLink = infoHash 
        ? `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(t.title)}&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce&tr=udp%3A%2F%2Fopen.stealth.si%3A80%2Fannounce&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`
        : t.link;

      return {
        titre: t.title,
        cleanTitle: clean,
        animeName: details.animeName,
        season: details.season,
        episode: details.episode,
        resolution: details.resolution,
        audioLang: details.audioLang,
        lienMagnet: magnetLink,
        taille: t.size,
        seeders: parseInt(t.seeders, 10) || 0,
        poster: meta.poster,
        rating: meta.rating
      };
    });

    searchCache.set(cacheKey, { results: videos, timestamp: Date.now() });
    res.json(videos);
  } catch (error) {
    console.error("⚠️ Erreur API Nyaa:", error.message);
    res.status(500).json([]);
  }
});

// --- ANALYSEUR FFPROBE RAPIDE (STREAMS SOUS-TITRES & AUDIO) AVEC CACHE ---
const streamsCache = new Map(); // key: hash, val: { data, timestamp }
const STREAMS_CACHE_TTL = 1000 * 60 * 60; // 1 heure

async function analyzeStreams(videoUrl) {
  try {
    console.log("🔍 FFPROBE: Analyse rapide des flux...");
    const cmd = `ffprobe -v error -probesize 4000000 -analyzeduration 4000000 -show_entries stream=index,codec_type,codec_name:stream_tags=language,title -of json "${videoUrl}"`;
    const { stdout } = await execPromise(cmd, { timeout: 12000 });
    const data = JSON.parse(stdout);
    const streams = data.streams || [];

    let subIndex = null;
    let relativeSubCount = 0;
    const subTracks = [];

    let frAudioIndex = null;
    let relativeAudioCount = 0;
    const audioTracks = [];

    for (const s of streams) {
      const lang = (s.tags?.language || '').toLowerCase();
      const title = s.tags?.title || '';

      if (s.codec_type === 'subtitle') {
        const isFrench = (lang === 'fre' || lang === 'fra' || title.toLowerCase().includes('french') || title.toLowerCase().includes('vostfr') || title.toLowerCase().includes('français') || title.toLowerCase().includes('vf'));
        let trackLabel = title;
        if (!trackLabel) {
          trackLabel = isFrench ? 'Français (VOSTFR)' : (lang ? `Sous-titre (${lang.toUpperCase()})` : `Piste ${relativeSubCount + 1}`);
        }

        subTracks.push({
          index: relativeSubCount,
          streamIndex: s.index,
          lang: lang || 'und',
          label: trackLabel,
          isFrench
        });

        if (subIndex === null && isFrench) {
          console.log(`✅ FFPROBE: Sous-titre FR trouvé (index relatif : ${relativeSubCount})`);
          subIndex = relativeSubCount;
        }
        relativeSubCount++;
      } else if (s.codec_type === 'audio') {
        const isFrench = (lang === 'fre' || lang === 'fra' || title.toLowerCase().includes('french') || title.toLowerCase().includes('vf'));
        audioTracks.push({
          index: relativeAudioCount,
          streamIndex: s.index,
          lang: lang || 'und',
          label: title || (isFrench ? 'Français (VF)' : (lang ? `Audio (${lang.toUpperCase()})` : `Audio ${relativeAudioCount + 1}`)),
          isFrench
        });

        if (frAudioIndex === null && isFrench) {
          console.log(`✅ FFPROBE: Audio Français trouvé (index relatif : ${relativeAudioCount})`);
          frAudioIndex = relativeAudioCount;
        }
        relativeAudioCount++;
      }
    }

    if (subIndex === null && subTracks.length > 0) {
      console.log("ℹ️ FFPROBE: Pas de piste FR explicite, sélection du premier sous-titre.");
      subIndex = 0;
    }

    return { subIndex, subTracks, frAudioIndex, audioTracks };
  } catch (e) {
    console.log("⚠️ FFPROBE: Analyse rapide streams terminée avec fallback.");
    return {
      subIndex: 0,
      subTracks: [{ index: 0, lang: 'fre', label: 'Français (VOSTFR)', isFrench: true }],
      frAudioIndex: null,
      audioTracks: []
    };
  }
}

async function getStreamInfo(magnet) {
  const hash = getTorrentHash(magnet);
  const cached = streamsCache.get(hash);
  if (cached && (Date.now() - cached.timestamp < STREAMS_CACHE_TTL)) {
    return cached.data;
  }
  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=1&play`;
  const data = await analyzeStreams(torrUrl);
  streamsCache.set(hash, { data, timestamp: Date.now() });
  return data;
}

// --- ROUTE API INFO FLUX (AUDIO & SOUS-TITRES) ---
app.get('/api/streams', async (req, res) => {
  const { magnet } = req.query;
  if (!magnet) return res.status(400).json({ error: "Lien magnet manquant" });
  try {
    const info = await getStreamInfo(magnet);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROUTE API STREAMING SOUS-TITRES WEBVTT DIRECTS DANS LE SITE ---
app.get('/api/subtitles', async (req, res) => {
  const { magnet, subIndex = 0 } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");

  const hash = getTorrentHash(magnet);
  const parsedIndex = parseInt(subIndex, 10) || 0;
  const cacheKey = `${hash}_${parsedIndex}`;
  const vttFile = path.join(SUB_CACHE_DIR, `${cacheKey}.vtt`);
  const tmpFile = path.join(SUB_CACHE_DIR, `${cacheKey}.tmp`);

  // 1. Si déjà entièrement extrait et mis en cache, servir instantanément (< 1ms)
  if (fs.existsSync(vttFile)) {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(vttFile).pipe(res);
  }

  // 2. Sinon, streamer en temps réel avec FFmpeg (flush_packets pour affichage immédiat)
  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=1&play`;

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const ffmpegArgs = [
    '-v', 'error',
    '-i', torrUrl,
    '-map', `0:s:${parsedIndex}`,
    '-flush_packets', '1',
    '-f', 'webvtt',
    'pipe:1'
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  const fileOut = fs.createWriteStream(tmpFile);

  ffmpeg.stdout.pipe(res);
  ffmpeg.stdout.pipe(fileOut);

  let finishedCleanly = false;
  ffmpeg.on('close', (code) => {
    fileOut.end();
    if (code === 0) {
      finishedCleanly = true;
      if (fs.existsSync(tmpFile)) {
        try { fs.renameSync(tmpFile, vttFile); } catch(e) {}
      }
    } else {
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch(e) {}
      }
    }
  });

  req.on('close', () => {
    if (!finishedCleanly) {
      ffmpeg.kill('SIGKILL');
      fileOut.end();
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch(e) {}
      }
    }
  });
});

// --- TRANSCODEUR FFMPEG OPTIMISÉ (ZÉRO LATENCE & MULTITHREAD) ---
app.get('/play', async (req, res) => {
  const { magnet, mode, type } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");

  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=1&play`;

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'none');

  // MODE 1 : LECTURE DIRECTE (0% CPU, STREAM ULTRA-RAPIDE SANS RÉENCODAGE VIDÉO)
  if (mode === 'direct') {
    console.log("⚡ Lancement FFmpeg en Mode Direct (Copie vidéo, 0% CPU)");
    const directArgs = [
      '-threads', '0',
      '-i', torrUrl,
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-map', '0:a:0?',
      '-c:a', 'aac',
      '-ac', '2',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    ];

    const ffmpeg = spawn('ffmpeg', directArgs);
    ffmpeg.stdout.pipe(res);

    req.on('close', () => {
      console.log("🛑 Client déconnecté (Mode Direct).");
      ffmpeg.kill('SIGKILL');
    });
    return;
  }

  // MODE 2 : TRANSCODAGE VIDÉO H.264 (POUR NAVIGATEURS OU APPAREILS SANS HEVC)
  console.log("🔄 Lancement FFmpeg en Mode Transcodage H.264 (Compatibilité standard)");
  const streamInfo = await getStreamInfo(magnet);

  const ffmpegArgs = [
    '-threads', '0', // Utilise tous les coeurs CPU disponibles
    '-i', torrUrl
  ];

  // Sélection intelligente de la piste audio
  if (type === 'vf' && streamInfo.frAudioIndex !== null) {
    ffmpegArgs.push('-map', `0:a:${streamInfo.frAudioIndex}`);
  } else {
    ffmpegArgs.push('-map', '0:a:0?');
  }

  // Encodage H.264 universel ultra-rapide
  ffmpegArgs.push(
    '-map', '0:v:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-crf', '25',
    '-c:a', 'aac',
    '-ac', '2',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  );

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);

  ffmpeg.stderr.on('data', (data) => {
    const msg = data.toString();
    if (msg.includes('Error') && !msg.includes('broken pipe')) {
      console.log("⚠️ FFmpeg Log:", msg.trim());
    }
  });

  ffmpeg.stdout.pipe(res);

  req.on('close', () => {
    console.log("🛑 Client déconnecté, arrêt de FFmpeg.");
    ffmpeg.kill('SIGKILL');
  });
});

app.listen(3000, () => {
  console.log('✅ Serveur Animflix optimisé prêt sur http://localhost:3000 !');
});