import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { db, dbBackupDir } from '../../database.js';
import {
  ROOT_DIR, SUB_CACHE_DIR, THUMB_CACHE_DIR, HLS_CACHE_DIR, FONT_CACHE_DIR, DOWNLOADS_DIR, MAX_CONCURRENT_STREAMS
} from '../config/constants.js';
import { APP_VERSION } from '../utils/assetVersion.js';
import { isTorrserverOnline, listTorrents } from './torrserverService.js';
import { getCurrentNyaaUrl } from './nyaaService.js';
import { testTokyoToshoConnection } from './tokyoToshoService.js';
import { getTorznabConfig, testTorznabConnection } from './torznabService.js';
import { getTorrentSourcesStatus } from './torrentAggregator.js';
import { getEpisodeNotifierStatus } from './episodeNotifier.js';
import { getDetectedHwAccel } from './ffmpegService.js';
import { BACKUP_RETENTION } from './dbMaintenance.js';
import { countActiveStreams, activeHlsSessions } from '../utils/sessionManager.js';

/**
 * État de santé du serveur pour la page d'administration : services externes, disque, sauvegardes,
 * activité. Chaque vérification a un niveau : 'ok' | 'warn' | 'error' | 'off' (désactivé).
 */

export const HEALTH_THRESHOLDS = {
  CHECK_TIMEOUT_MS: 5000,
  SLOW_MS: 2500,
  DISK_WARN_FREE_RATIO: 0.10,
  DISK_WARN_FREE_BYTES: 5 * 1024 ** 3,
  DISK_ERROR_FREE_BYTES: 1 * 1024 ** 3,
  BACKUP_WARN_AGE_MS: 36 * 60 * 60 * 1000,   // sauvegarde quotidienne manquée
  BACKUP_ERROR_AGE_MS: 3 * 24 * 60 * 60 * 1000,
  CACHE_TTL_MS: 30 * 1000
};

const BACKUP_NAME_RE = /^animflix-(\d{4}-\d{2}-\d{2})\.db$/;
const LEVEL_ORDER = { ok: 0, off: 0, warn: 1, error: 2 };

export function worstLevel(levels) {
  return levels.reduce((worst, l) => (LEVEL_ORDER[l] > LEVEL_ORDER[worst] ? l : worst), 'ok');
}

/** Sauvegardes quotidiennes (dbMaintenance) : la plus récente et son âge */
export function summarizeBackups(files, now = Date.now()) {
  const backups = files
    .filter(f => BACKUP_NAME_RE.test(f.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  const totalBytes = backups.reduce((s, f) => s + (f.size || 0), 0);
  if (!backups.length) {
    return { level: 'error', count: 0, totalBytes: 0, latest: null, message: 'Aucune sauvegarde' };
  }
  const latest = backups[0];
  const ageMs = Math.max(0, now - latest.mtimeMs);
  const level = ageMs > HEALTH_THRESHOLDS.BACKUP_ERROR_AGE_MS ? 'error'
    : ageMs > HEALTH_THRESHOLDS.BACKUP_WARN_AGE_MS ? 'warn' : 'ok';
  return {
    level,
    count: backups.length,
    totalBytes,
    latest: { name: latest.name, day: latest.name.match(BACKUP_NAME_RE)[1], size: latest.size, at: latest.mtimeMs, ageMs },
    list: backups.map(f => ({ name: f.name, size: f.size, at: f.mtimeMs }))
  };
}

/** Espace disque libre de la partition du serveur */
export function diskLevel({ free, total }) {
  if (!total) return 'warn';
  if (free < HEALTH_THRESHOLDS.DISK_ERROR_FREE_BYTES) return 'error';
  if (free < HEALTH_THRESHOLDS.DISK_WARN_FREE_BYTES || free / total < HEALTH_THRESHOLDS.DISK_WARN_FREE_RATIO) return 'warn';
  return 'ok';
}

/** Résultat d'un test de service -> niveau (lent = avertissement) */
export function serviceLevel(result) {
  if (!result || result.enabled === false) return 'off';
  if (!result.ok) return 'error';
  return result.latencyMs > HEALTH_THRESHOLDS.SLOW_MS ? 'warn' : 'ok';
}

// --- MESURES ---

async function timed(fn) {
  const start = Date.now();
  try {
    const extra = await fn();
    return { ok: true, latencyMs: Date.now() - start, ...(extra || {}) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, error: err.message };
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} : pas de réponse en ${ms / 1000} s`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function dirUsage(dir) {
  let bytes = 0;
  let files = 0;
  const walk = async (d, depth) => {
    let entries;
    try { entries = await fs.promises.readdir(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < 3) await walk(full, depth + 1);
      } else if (e.isFile()) {
        try {
          bytes += (await fs.promises.stat(full)).size;
          files++;
        } catch (err) {}
      }
    }
  };
  await walk(dir, 0);
  return { bytes, files };
}

async function listBackupFiles() {
  try {
    const names = await fs.promises.readdir(dbBackupDir);
    const files = [];
    for (const name of names) {
      try {
        const st = await fs.promises.stat(path.join(dbBackupDir, name));
        if (st.isFile()) files.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      } catch (e) {}
    }
    return files;
  } catch (e) {
    return [];
  }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

async function checkServices() {
  const sources = getTorrentSourcesStatus();
  const torznab = getTorznabConfig();
  const T = HEALTH_THRESHOLDS.CHECK_TIMEOUT_MS;

  const [torrserver, nyaa, tokyoTosho, torznabRes, anilist] = await Promise.all([
    timed(async () => {
      if (!await isTorrserverOnline()) throw new Error('Injoignable');
      const list = await listTorrents().catch(() => ({ data: [] }));
      return { torrents: Array.isArray(list.data) ? list.data.length : 0 };
    }),
    timed(async () => {
      const url = getCurrentNyaaUrl();
      const res = await withTimeout(fetch(`${url}/?page=rss`, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }), T, 'Nyaa');
      const body = res.ok ? await res.text() : '';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!body.includes('<rss')) throw new Error('Pas de flux RSS (protection Cloudflare ?)');
      return { url };
    }),
    sources.sources.tokyoTosho.enabled
      ? testTokyoToshoConnection().then(r => ({ ok: !!r.ok, latencyMs: r.latencyMs || 0, error: r.ok ? undefined : (r.error || `HTTP ${r.status}`) }))
      : Promise.resolve({ enabled: false }),
    torznab.enabled
      ? timed(async () => {
          const r = await withTimeout(testTorznabConnection({ url: torznab.url, apiKey: torznab.apiKey }), T + 2000, 'Torznab');
          if (!r.success) throw new Error(r.message);
          return { message: r.message };
        })
      : Promise.resolve({ enabled: false }),
    timed(async () => {
      const res = await axios.post('https://graphql.anilist.co', { query: '{ Media(id: 1) { id } }' },
        { headers: { 'Content-Type': 'application/json', 'User-Agent': 'Animflix/1.0' }, timeout: T });
      if (!res.data?.data?.Media) throw new Error('Réponse inattendue');
    })
  ]);

  const entry = (id, name, result, extra = {}) => ({ id, name, ...result, ...extra, level: serviceLevel(result) });
  return [
    entry('torrserver', 'TorrServer (moteur P2P)', torrserver),
    entry('nyaa', 'Nyaa.si', nyaa, { url: getCurrentNyaaUrl() }),
    entry('tokyotosho', 'Tokyo Toshokan', tokyoTosho),
    entry('torznab', 'Torznab (Jackett / Prowlarr)', torznabRes),
    entry('anilist', 'API AniList', anilist)
  ];
}

async function checkStorage() {
  let disk = null;
  try {
    const st = await fs.promises.statfs(ROOT_DIR);
    disk = { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
    disk.level = diskLevel(disk);
  } catch (e) {
    disk = { error: e.message, level: 'warn' };
  }
  const dbPath = db.name;
  const caches = await Promise.all([
    ['subtitles', 'sous-titres', SUB_CACHE_DIR],
    ['thumbnails', 'miniatures', THUMB_CACHE_DIR],
    ['fonts', 'polices', FONT_CACHE_DIR],
    ['hls', 'transcodage HLS', HLS_CACHE_DIR]
  ].map(async ([id, name, dir]) => ({ id, name, ...(await dirUsage(dir)) })));
  return {
    disk,
    database: { bytes: fileSize(dbPath) + fileSize(dbPath + '-wal') },
    caches,
    downloads: await dirUsage(DOWNLOADS_DIR),
    level: disk.level
  };
}

function countRows(sql) {
  try { return db.prepare(sql).get().n; } catch (e) { return null; }
}

function checkActivity() {
  const mem = process.memoryUsage();
  return {
    version: APP_VERSION,
    node: process.version,
    uptimeS: Math.round(process.uptime()),
    memoryBytes: mem.rss,
    hwAccel: getDetectedHwAccel(),
    streams: { active: countActiveStreams(), max: MAX_CONCURRENT_STREAMS, hls: activeHlsSessions.size },
    users: countRows('SELECT COUNT(*) AS n FROM users'),
    sessions: countRows(`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ${Date.now()}`),
    pushDevices: countRows('SELECT COUNT(*) AS n FROM push_subscriptions'),
    syncItems: countRows('SELECT COUNT(*) AS n FROM sync_items WHERE data IS NOT NULL')
  };
}

let cached = null; // { at, promise }

/**
 * Rapport complet. Les tests réseau sont mis en cache 30 s (page rafraîchie, plusieurs onglets).
 */
export function getHealthReport({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < HEALTH_THRESHOLDS.CACHE_TTL_MS) return cached.promise;
  const promise = (async () => {
    const [services, storage, backupFiles] = await Promise.all([checkServices(), checkStorage(), listBackupFiles()]);
    const backups = summarizeBackups(backupFiles);
    backups.retention = BACKUP_RETENTION;
    const notifier = getEpisodeNotifierStatus();
    notifier.level = !notifier.enabled ? 'off' : notifier.lastError ? 'warn' : 'ok';
    const activity = checkActivity();
    const levels = [...services.map(s => s.level), storage.level, backups.level, notifier.level];
    return {
      generatedAt: Date.now(),
      level: worstLevel(levels),
      problems: levels.filter(l => l === 'warn' || l === 'error').length,
      services,
      storage,
      backups,
      notifier,
      activity
    };
  })();
  cached = { at: Date.now(), promise };
  promise.catch(() => { cached = null; });
  return promise;
}

export function invalidateHealthCache() {
  cached = null;
}
