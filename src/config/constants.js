import path from 'path';
import fs from 'fs';

// --- PORTS & ADRESSES DE SERVICE ---
export const PORT = parseInt(process.env.PORT, 10) || 3000;
export const TORRSERVER_LOCAL_URL = (process.env.TORRSERVER_URL || "http://127.0.0.1:8090").replace(/\/+$/, '');
export const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

// --- MIROIRS NYAA.SI AVEC RESILIENCE ET REPLI AUTO ---
export const NYAA_PRIMARY_URL = (process.env.NYAA_URL || 'https://nyaa.si').replace(/\/+$/, '');
export const NYAA_FALLBACK_URLS = [
  NYAA_PRIMARY_URL,
  'https://nyaa.si',
  'https://nyaa.land'
].filter((v, i, a) => a.indexOf(v) === i);

// --- SOURCES TORRENT ALTERNATIVES & TORZNAB (JACKETT / PROWLARR) ---
export const TOKYO_TOSHO_URL = (process.env.TOKYO_TOSHO_URL || 'https://www.tokyotosho.info').replace(/\/+$/, '');
export const TORZNAB_DEFAULT_URL = (process.env.TORZNAB_URL || '').replace(/\/+$/, '');
export const TORZNAB_DEFAULT_API_KEY = process.env.TORZNAB_API_KEY || '';
export const TORRENT_SOURCE_DEFAULT_MODE = process.env.TORRENT_SOURCE_MODE || 'resilient'; // 'resilient' | 'aggregate' | 'nyaa_only'

// --- ACCELERATION MATERIELLE VAAPI ---
export const VAAPI_DEVICE = process.env.VAAPI_DEVICE || '/dev/dri/renderD128';
export const FFMPEG_HWACCEL_PREF = (process.env.FFMPEG_HWACCEL || 'auto').toLowerCase();

// --- LIMITE DE FLUX FFMPEG SIMULTANÉS (lecture directe, transcodage, HLS) ---
// Chaque flux est un processus FFmpeg (transcodage = CPU/GPU intensif) : au-delà, réponse 503.
export const MAX_CONCURRENT_STREAMS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_STREAMS, 10) || 4);

// --- REPERTOIRES DE CACHE DISQUE ---
export const ROOT_DIR = process.cwd();
export const SUB_CACHE_DIR = path.join(ROOT_DIR, 'cache', 'subtitles');
export const THUMB_CACHE_DIR = path.join(ROOT_DIR, 'cache', 'thumbnails');
export const HLS_CACHE_DIR = path.join(ROOT_DIR, 'cache', 'hls');
export const FONT_CACHE_DIR = path.join(ROOT_DIR, 'cache', 'fonts');

// Initialisation automatique des répertoires de cache nécessaires
for (const dir of [SUB_CACHE_DIR, THUMB_CACHE_DIR, HLS_CACHE_DIR, FONT_CACHE_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
