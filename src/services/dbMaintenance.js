import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createSyncStore } from './syncStore.js';
import { logServerError } from './errorLog.js';

/**
 * Entretien quotidien de la base Animflix (comptes, sessions, historique synchronisé) :
 * sauvegarde datée et vérifiée, purge des sessions expirées et des suppressions de synchro trop anciennes.
 */

// Rétention par paliers : les 7 derniers jours, puis une sauvegarde par semaine (4 semaines)
// et une par mois (6 mois). Un problème remarqué tard (données effacées il y a 3 semaines) reste réparable.
function envInt(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
export const BACKUP_RETENTION = {
  daily: Math.max(1, envInt('DATABASE_BACKUP_KEEP_DAILY', 7)),
  weekly: envInt('DATABASE_BACKUP_KEEP_WEEKLY', 4),
  monthly: envInt('DATABASE_BACKUP_KEEP_MONTHLY', 6)
};
export const BACKUP_KEEP = BACKUP_RETENTION.daily;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 60 * 1000;
export const BACKUP_NAME_RE = /^animflix-\d{4}-\d{2}-\d{2}\.db$/;

function localDateStamp(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Semaine ISO (lundi → dimanche) d'une date AAAA-MM-JJ
function isoWeekKey(stamp) {
  const [y, m, d] = stamp.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${week}`;
}

/**
 * Sauvegardes à conserver parmi `names` (animflix-AAAA-MM-JJ.db) : les `daily` plus récentes, plus la plus
 * récente de chacune des `weekly` dernières semaines et des `monthly` derniers mois.
 */
export function selectBackupsToKeep(names, { daily = 7, weekly = 0, monthly = 0 } = {}) {
  const sorted = names.filter(n => BACKUP_NAME_RE.test(n)).sort().reverse(); // plus récente d'abord
  const keep = new Set(sorted.slice(0, daily));
  const stamp = n => n.slice('animflix-'.length, -'.db'.length);
  const keepNewestPerPeriod = (periodOf, count) => {
    const seen = new Set();
    for (const n of sorted) {
      const period = periodOf(stamp(n));
      if (seen.has(period)) continue;
      if (seen.size >= count) break;
      seen.add(period);
      keep.add(n);
    }
  };
  if (weekly > 0) keepNewestPerPeriod(isoWeekKey, weekly);
  if (monthly > 0) keepNewestPerPeriod(s => s.slice(0, 7), monthly);
  return keep;
}

// Relit la copie : une sauvegarde illisible ne doit jamais remplacer les bonnes
function verifyBackupFile(file) {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const result = copy.pragma('quick_check', { simple: true });
    if (result !== 'ok') throw new Error(`copie corrompue (${result})`);
  } finally {
    copy.close();
  }
}

/**
 * Copie cohérente de la base (API de sauvegarde SQLite, sûre pendant les écritures) : une par jour,
 * vérifiée avant d'être gardée, avec rotation par paliers. `keep` (nombre) = ancienne rotation simple.
 * Retourne le chemin créé, ou null si celle du jour existe déjà.
 */
export async function backupDatabase(db, { backupDir, keep = null, retention = BACKUP_RETENTION, now = new Date() }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `animflix-${localDateStamp(now)}.db`);
  let created = null;
  if (!fs.existsSync(target)) {
    // Écriture dans un fichier temporaire puis renommage : jamais de sauvegarde à moitié écrite
    const tmp = `${target}.tmp`;
    try {
      await db.backup(tmp);
      verifyBackupFile(tmp);
      fs.renameSync(tmp, target);
      created = target;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const policy = Number.isInteger(keep) ? { daily: keep, weekly: 0, monthly: 0 } : retention;
  const names = fs.readdirSync(backupDir).filter(f => BACKUP_NAME_RE.test(f));
  const toKeep = selectBackupsToKeep(names, policy);
  names.filter(n => !toKeep.has(n)).forEach(f => fs.rmSync(path.join(backupDir, f), { force: true }));
  return created;
}

export async function runDbMaintenance({ db, backupDir, cleanupExpiredSessions }) {
  try {
    const created = await backupDatabase(db, { backupDir });
    if (created) console.log(`💾 Sauvegarde de la base : ${created}`);
  } catch (err) {
    console.error('⚠️ Sauvegarde de la base impossible :', err.message);
    logServerError('sauvegarde', `Sauvegarde de la base impossible : ${err.message}`);
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
