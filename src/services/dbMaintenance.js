import fs from 'fs';
import path from 'path';
import { createSyncStore } from './syncStore.js';

/**
 * Entretien quotidien de la base Animflix (comptes, sessions, historique synchronisé) :
 * sauvegarde datée, purge des sessions expirées et des suppressions de synchro trop anciennes.
 */

export const BACKUP_KEEP = 7;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const BACKUP_NAME_RE = /^animflix-\d{4}-\d{2}-\d{2}\.db$/;

function localDateStamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Copie cohérente de la base (API de sauvegarde SQLite, sûre pendant les écritures) : une par jour,
 * les `keep` plus récentes sont conservées. Retourne le chemin créé, ou null si celle du jour existe déjà.
 */
export async function backupDatabase(db, { backupDir, keep = BACKUP_KEEP, now = new Date() }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `animflix-${localDateStamp(now)}.db`);
  let created = null;
  if (!fs.existsSync(target)) {
    // Écriture dans un fichier temporaire puis renommage : jamais de sauvegarde à moitié écrite
    const tmp = `${target}.tmp`;
    try {
      await db.backup(tmp);
      fs.renameSync(tmp, target);
      created = target;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const backups = fs.readdirSync(backupDir).filter(f => BACKUP_NAME_RE.test(f)).sort();
  backups.slice(0, Math.max(0, backups.length - keep)).forEach(f => fs.rmSync(path.join(backupDir, f), { force: true }));
  return created;
}

export async function runDbMaintenance({ db, backupDir, cleanupExpiredSessions }) {
  try {
    const created = await backupDatabase(db, { backupDir });
    if (created) console.log(`💾 Sauvegarde de la base : ${created}`);
  } catch (err) {
    console.error('⚠️ Sauvegarde de la base impossible :', err.message);
  }
  try {
    cleanupExpiredSessions?.();
    const pruned = createSyncStore(db).pruneTombstones();
    if (pruned > 0) console.log(`🧹 Synchro : ${pruned} suppression(s) de plus de 90 jours purgée(s)`);
  } catch (err) {
    console.error('⚠️ Entretien de la base impossible :', err.message);
  }
}

export function startDbMaintenance(options) {
  const run = () => runDbMaintenance(options);
  setTimeout(run, FIRST_RUN_DELAY_MS).unref();
  setInterval(run, CHECK_INTERVAL_MS).unref();
}
