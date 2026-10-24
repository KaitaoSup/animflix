import path from 'path';

/**
 * Nettoyeur intelligent de titre d'anime pour un matching API précis (TMDB, TVMaze, Kitsu)
 * Retire les tags de fansub ([SubsPlease], [Erai-raws]), résolutions, codecs, etc.
 */
export function cleanAnimeTitle(raw) {
  if (!raw) return '';
  return raw
    .replace(/\[.*?\]/g, ' ') // Retire [Fansub], [1080p], etc.
    .replace(/\(.*?\)/g, ' ') // Retire (1080p), (TV), etc.
    .replace(/\b\d\s*[._]\s*\d\b/g, ' ') // Retire les canaux audio 2.0, 5.1
    .replace(/\b(1080p|720p|480p|2160p|4k|x264|x265|x\.265|x\.264|hevc|av1|aac|flac|web-dl|webrip|bdrip|bd|bluray|dvd|vostfr|vf|multi|multisubs?|sub|mkv|mp4|avi|cr|crunchyroll|10bit|8bit|remux|uncensored|dual audio|final)\b/gi, ' ')
    .replace(/\b\d+(?:st|nd|rd|th)\s+season\b/gi, ' ')
    .replace(/\b(s\d+e\d+|s\d+|e\d+|ep\s*\d+|episode\s*\d+|saison\s*\d+|season\s*\d+)\b/gi, ' ')
    .replace(/\s*-\s*\d{1,4}\b/g, ' ')
    .replace(/\b\d{1,3}\b(?=\s*$)/g, ' ')
    .replace(/[._\-\+\/\\:~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Analyse détaillée des métadonnées Anime (Nom, Saison, Épisode, Résolution, Audio)
 */
export function parseAnimeDetails(rawTitle) {
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

/**
 * Détection du numéro d'épisode dans le nom de fichier d'un pack de torrent
 */
export function extractFileEpisodeNumber(filePath) {
  if (!filePath) return null;
  const base = path.basename(filePath);

  // 1. Détection format S01E05, S1_E5, etc.
  const mSe = base.match(/(?:^|[_\s\W])S\d{1,2}[_\s\W]*E0*(\d{1,4})(?:[_\s\W]|$)/i);
  if (mSe) return parseInt(mSe[1], 10);

  // 2. Détection format EP 05, Episode 1071, etc.
  const mEp = base.match(/(?:^|[_\s\W])(?:E|EP|Episode|Épisode)[_\s\W]*0*(\d{1,4})(?:[_\s\W]|$)/i) ||
              base.match(/\s-\s0*(\d{1,4})(?:v\d+)?(?:\s|\.|$|\[|\()/);
  if (mEp) return parseInt(mEp[1], 10);

  // 3. Détection d'un nombre isolé d'épisode
  const mNum = base.match(/(?:^|[_\s\W])0*(\d{1,3})(?:[_\s\W]|$)/);
  if (mNum) return parseInt(mNum[1], 10);
  return null;
}
