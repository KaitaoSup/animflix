import fs from 'fs';
import path from 'path';
import { SUB_CACHE_DIR, THUMB_CACHE_DIR } from '../config/constants.js';

// --- NETTOYAGE AUTOMATIQUE DU CACHE DISQUE (SOUS-TITRES & MINIATURES) ---
// La date de modification (mtime) sert de "dernière utilisation" : elle est
// rafraîchie à chaque lecture depuis le cache via touchCacheFile().

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_AGE_MS = (parseFloat(process.env.CACHE_MAX_AGE_DAYS) || 7) * DAY_MS;
const MAX_SIZE_BYTES = (parseFloat(process.env.CACHE_MAX_SIZE_MB) || 200) * 1024 * 1024; // par dossier
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h
// Les .tmp récents appartiennent à une extraction FFmpeg en cours : ne jamais y toucher
const TMP_GRACE_MS = 60 * 60 * 1000;

export const MANAGED_CACHE_DIRS = [SUB_CACHE_DIR, THUMB_CACHE_DIR];

/**
 * Marque un fichier du cache comme utilisé (repousse son expiration)
 */
export function touchCacheFile(filePath) {
  const now = new Date();
  fs.promises.utimes(filePath, now, now).catch(() => {});
}

async function listFiles(dir) {
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch (e) {
    return [];
  }
  const files = [];
  for (const name of names) {
    const fullPath = path.join(dir, name);
    try {
      const st = await fs.promises.stat(fullPath);
      if (st.isFile()) files.push({ path: fullPath, name, size: st.size, mtime: st.mtimeMs });
    } catch (e) {}
  }
  return files;
}

async function removeFile(file) {
  try {
    await fs.promises.unlink(file.path);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Nettoie un dossier de cache.
 * - mode normal : supprime les fichiers inutilisés depuis maxAgeMs, puis les plus anciens
 *   tant que le dossier dépasse maxSizeBytes
 * - mode "all" : supprime tout (hors .tmp en cours d'écriture)
 */
export async function cleanCacheDir(dir, { maxAgeMs = MAX_AGE_MS, maxSizeBytes = MAX_SIZE_BYTES, all = false, now = Date.now() } = {}) {
  const files = await listFiles(dir);
  let removed = 0;
  let freed = 0;
  const kept = [];

  for (const file of files) {
    const age = now - file.mtime;
    const isTmp = file.name.endsWith('.tmp');
    const expired = isTmp ? age > TMP_GRACE_MS : (all || age > maxAgeMs);
    if (expired && await removeFile(file)) {
      removed++;
      freed += file.size;
    } else if (!isTmp) {
      kept.push(file);
    }
  }

  // Limite de taille : éviction des moins récemment utilisés
  let total = kept.reduce((sum, f) => sum + f.size, 0);
  if (total > maxSizeBytes) {
    kept.sort((a, b) => a.mtime - b.mtime);
    for (const file of kept) {
      if (total <= maxSizeBytes) break;
      if (await removeFile(file)) {
        removed++;
        freed += file.size;
        total -= file.size;
      }
    }
  }

  return { removed, freed };
}

/**
 * Nettoie tous les dossiers de cache gérés
 */
export async function cleanDiskCaches(options = {}) {
  let removed = 0;
  let freed = 0;
  for (const dir of MANAGED_CACHE_DIRS) {
    const r = await cleanCacheDir(dir, options);
    removed += r.removed;
    freed += r.freed;
  }
  if (removed > 0) {
    console.log(`🧹 Cache disque : ${removed} fichier(s) supprimé(s) (${(freed / 1024 / 1024).toFixed(1)} Mo libérés)`);
  }
  return { removed, freed };
}

let sweepTimer = null;

/**
 * Lance le nettoyage au démarrage puis toutes les heures
 */
export function startDiskCacheCleaner() {
  if (sweepTimer) return;
  cleanDiskCaches().catch((e) => console.warn('⚠️ Nettoyage cache disque échoué :', e.message));
  sweepTimer = setInterval(() => {
    cleanDiskCaches().catch((e) => console.warn('⚠️ Nettoyage cache disque échoué :', e.message));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}
