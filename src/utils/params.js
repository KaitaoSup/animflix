// --- NORMALISATION DES PARAMÈTRES DE REQUÊTE NUMÉRIQUES ---
// Une valeur absente ou illisible retombe sur la valeur par défaut, une valeur hors bornes est ramenée
// dans l'intervalle : on ne transmet jamais NaN, Infinity ou un nombre aberrant à FFmpeg.

const MAX_SEEK_SECONDS = 48 * 3600;   // 48 h : au-delà, aucun épisode/film réaliste
const MAX_AUDIO_OFFSET_SECONDS = 60;  // décalage manuel audio ±60 s
const MAX_TRACK_INDEX = 99;           // pistes audio / sous-titres
const MAX_FILE_INDEX = 100000;        // fichiers dans un pack torrent

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return NaN;
  return Number(value);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Entier borné ; `fallback` si absent ou illisible
 */
export function parseIntParam(value, { min, max, fallback }) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.trunc(n), min, max);
}

/**
 * Flottant borné ; `fallback` si absent ou illisible
 */
export function parseFloatParam(value, { min, max, fallback }) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, min, max);
}

export const parseFileIndex = (v) => parseIntParam(v, { min: 1, max: MAX_FILE_INDEX, fallback: 1 });
export const parseTrackIndex = (v) => parseIntParam(v, { min: 0, max: MAX_TRACK_INDEX, fallback: 0 });
/** Piste audio choisie, ou null (= piste par défaut) si absente/illisible */
export const parseAudioIndex = (v) => parseIntParam(v, { min: 0, max: MAX_TRACK_INDEX, fallback: null });
export const parseSeekSeconds = (v) => parseFloatParam(v, { min: 0, max: MAX_SEEK_SECONDS, fallback: 0 });
export const parseAudioOffset = (v) =>
  parseFloatParam(v, { min: -MAX_AUDIO_OFFSET_SECONDS, max: MAX_AUDIO_OFFSET_SECONDS, fallback: 0 });

/**
 * Paramètres communs aux routes de lecture (/play, HLS)
 */
export function parsePlaybackParams(query = {}) {
  return {
    fileIndex: parseFileIndex(query.fileIndex),
    audioIndex: parseAudioIndex(query.audioIndex),
    seekSeconds: parseSeekSeconds(query.ss),
    audioOffset: parseAudioOffset(query.audioOffset)
  };
}

/**
 * Un playId sert de nom de dossier (cache HLS) : uniquement alphanumérique, tirets et underscores.
 * Empêche toute traversée de répertoire (ex. "..%2F.." qui ferait supprimer la racine du projet).
 */
export function isValidPlayId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(value);
}
