/**
 * Journal des erreurs du serveur (page « Serveur » de l'administrateur) : échecs FFmpeg / ffprobe,
 * TorrServer injoignable, téléchargements, notifications, agenda, lectures échouées signalées par le lecteur.
 *
 * Une même erreur répétée (même source, même message) dans les 10 minutes incrémente un compteur au lieu
 * d'ajouter une ligne. Seules les 500 dernières entrées sont gardées.
 */

export const ERROR_LOG_LIMITS = {
  MAX_ROWS: 500,
  MERGE_WINDOW_MS: 10 * 60 * 1000,
  MAX_MESSAGE: 300,
  MAX_DETAILS: 2000
};

export const ERROR_SOURCES = {
  ffmpeg: 'FFmpeg',
  ffprobe: 'Analyse (ffprobe)',
  torrserver: 'TorrServer',
  lecture: 'Lecture',
  download: 'Téléchargement',
  notifier: 'Notifications',
  agenda: 'Agenda',
  sauvegarde: 'Sauvegarde',
  serveur: 'Serveur'
};

function clip(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\u0000/g, '').trim();
  return s ? s.slice(0, max) : null;
}

export function createErrorLogStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      details TEXT,
      count INTEGER NOT NULL DEFAULT 1,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_server_errors_last ON server_errors(last_at);
  `);

  const stmts = {
    recent: db.prepare('SELECT id, last_at FROM server_errors WHERE source = ? AND message = ? ORDER BY last_at DESC LIMIT 1'),
    bump: db.prepare('UPDATE server_errors SET count = count + 1, last_at = ?, details = COALESCE(?, details) WHERE id = ?'),
    insert: db.prepare('INSERT INTO server_errors (source, message, details, first_at, last_at) VALUES (?, ?, ?, ?, ?)'),
    trim: db.prepare(`DELETE FROM server_errors WHERE id NOT IN (SELECT id FROM server_errors ORDER BY last_at DESC, id DESC LIMIT ${ERROR_LOG_LIMITS.MAX_ROWS})`),
    list: db.prepare('SELECT * FROM server_errors ORDER BY last_at DESC, id DESC LIMIT ?'),
    listBySource: db.prepare('SELECT * FROM server_errors WHERE source = ? ORDER BY last_at DESC, id DESC LIMIT ?'),
    countsSince: db.prepare('SELECT source, SUM(count) AS n FROM server_errors WHERE last_at >= ? GROUP BY source'),
    clear: db.prepare('DELETE FROM server_errors')
  };

  let inserts = 0;

  return {
    add({ source, message, details = null }, now = Date.now()) {
      const src = ERROR_SOURCES[source] ? source : 'serveur';
      const msg = clip(message, ERROR_LOG_LIMITS.MAX_MESSAGE) || 'Erreur inconnue';
      const det = clip(details, ERROR_LOG_LIMITS.MAX_DETAILS);
      const recent = stmts.recent.get(src, msg);
      if (recent && now - recent.last_at < ERROR_LOG_LIMITS.MERGE_WINDOW_MS) {
        stmts.bump.run(now, det, recent.id);
        return recent.id;
      }
      const id = stmts.insert.run(src, msg, det, now, now).lastInsertRowid;
      if (++inserts % 25 === 0) stmts.trim.run();
      return Number(id);
    },
    list({ limit = 100, source = null } = {}) {
      const n = Math.max(1, Math.min(ERROR_LOG_LIMITS.MAX_ROWS, Number(limit) || 100));
      const rows = source && ERROR_SOURCES[source] ? stmts.listBySource.all(source, n) : stmts.list.all(n);
      return rows.map(r => ({
        id: r.id, source: r.source, sourceLabel: ERROR_SOURCES[r.source] || r.source,
        message: r.message, details: r.details, count: r.count, firstAt: r.first_at, lastAt: r.last_at
      }));
    },
    countsSince(since) {
      const out = {};
      for (const r of stmts.countsSince.all(since)) out[r.source] = r.n;
      return out;
    },
    trim: () => stmts.trim.run(),
    clear: () => stmts.clear.run().changes
  };
}

// --- INSTANCE DU SERVEUR ---

let store = null;

export function initErrorLog(db) {
  store = createErrorLogStore(db);
  store.trim();
  return store;
}

export function getErrorLog() {
  return store;
}

/**
 * Ajoute une entrée au journal. Ne lève jamais d'exception (sans effet tant que le journal n'est pas initialisé).
 */
export function logServerError(source, message, details = null) {
  if (!store) return;
  try {
    store.add({ source, message, details });
  } catch (e) {
    // Le journal ne doit jamais faire échouer l'opération qui le remplit
  }
}
