/**
 * Santé des sources torrent, partagée entre tous les comptes du serveur.
 *
 * Le lecteur signale un échec (aucun pair, flux bloqué, format illisible, signalement manuel) ou un succès
 * (la lecture a démarré). Une source est « signalée » quand au moins une personne a échoué depuis le
 * dernier succès : elle passe alors après les autres dans le choix automatique, sans être masquée.
 * Un seul signalement par personne et par source toutes les 6 h (pas de rafale depuis un même lecteur).
 */

export const SOURCE_HEALTH_CONFIG = {
  WINDOW_MS: 30 * 24 * 60 * 60 * 1000,
  DEDUPE_MS: 6 * 60 * 60 * 1000
};

export const FAIL_REASONS = {
  no_peers: 'Aucun pair',
  stalled: 'Ne démarre pas',
  unplayable: 'Illisible',
  manual: 'Signalée'
};

const HASH_RE = /^[a-z0-9]{32,40}$/;

export function hashFromMagnet(magnet) {
  const m = typeof magnet === 'string' ? /xt=urn:btih:([a-z0-9]+)/i.exec(magnet) : null;
  const hash = m ? m[1].toLowerCase() : null;
  return hash && HASH_RE.test(hash) ? hash : null;
}

export function createSourceHealthStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      file_index INTEGER NOT NULL DEFAULT 1,
      outcome TEXT NOT NULL,
      reason TEXT,
      reporter TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_source_reports_hash ON source_reports(hash, created_at);
  `);

  const stmts = {
    lastSame: db.prepare('SELECT created_at FROM source_reports WHERE hash = ? AND reporter = ? AND outcome = ? ORDER BY created_at DESC LIMIT 1'),
    insert: db.prepare('INSERT INTO source_reports (hash, file_index, outcome, reason, reporter, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    prune: db.prepare('DELETE FROM source_reports WHERE created_at < ?')
  };

  /**
   * Enregistre un signalement. Retourne false s'il fait doublon (même personne, même résultat, moins de 6 h).
   */
  function record({ hash, fileIndex = 1, outcome, reason = null, reporter }, now = Date.now()) {
    if (!HASH_RE.test(hash || '') || !reporter) return false;
    if (outcome !== 'fail' && outcome !== 'ok') return false;
    const last = stmts.lastSame.get(hash, reporter, outcome);
    if (last && now - last.created_at < SOURCE_HEALTH_CONFIG.DEDUPE_MS) return false;
    const r = outcome === 'fail' ? (FAIL_REASONS[reason] ? reason : 'manual') : null;
    stmts.insert.run(hash, Number.isInteger(fileIndex) ? fileIndex : 1, outcome, r, String(reporter).slice(0, 80), now);
    return true;
  }

  /**
   * État des sources demandées : Map hash -> { fails, reason, lastFailAt } pour celles signalées
   * (échecs de personnes différentes depuis le dernier succès, sur 30 jours).
   */
  function statusFor(hashes, now = Date.now()) {
    const wanted = [...new Set((hashes || []).filter(h => HASH_RE.test(h || '')))];
    const result = new Map();
    const since = now - SOURCE_HEALTH_CONFIG.WINDOW_MS;
    for (let i = 0; i < wanted.length; i += 400) {
      const chunk = wanted.slice(i, i + 400);
      const rows = db.prepare(
        `SELECT hash, outcome, reason, reporter, created_at FROM source_reports
         WHERE created_at >= ? AND hash IN (${chunk.map(() => '?').join(',')}) ORDER BY created_at ASC`
      ).all(since, ...chunk);
      const byHash = new Map();
      for (const row of rows) {
        if (!byHash.has(row.hash)) byHash.set(row.hash, []);
        byHash.get(row.hash).push(row);
      }
      for (const [hash, list] of byHash) {
        let lastOk = -1;
        list.forEach((r, idx) => { if (r.outcome === 'ok') lastOk = idx; });
        const fails = list.slice(lastOk + 1).filter(r => r.outcome === 'fail');
        if (!fails.length) continue;
        const last = fails[fails.length - 1];
        result.set(hash, {
          fails: new Set(fails.map(r => r.reporter)).size,
          reason: last.reason,
          reasonLabel: FAIL_REASONS[last.reason] || 'Signalée',
          lastFailAt: last.created_at
        });
      }
    }
    return result;
  }

  return {
    record,
    statusFor,
    prune: (now = Date.now()) => stmts.prune.run(now - SOURCE_HEALTH_CONFIG.WINDOW_MS).changes
  };
}

/**
 * Ajoute `reported: { fails, reason, reasonLabel, lastFailAt }` aux résultats de recherche signalés
 */
export function annotateTorrents(store, torrents, now = Date.now()) {
  if (!store || !Array.isArray(torrents) || torrents.length === 0) return torrents;
  const hashes = torrents.map(t => hashFromMagnet(t?.lienMagnet));
  const status = store.statusFor(hashes.filter(Boolean), now);
  if (status.size === 0) return torrents;
  return torrents.map((t, i) => (hashes[i] && status.has(hashes[i]) ? { ...t, reported: status.get(hashes[i]) } : t));
}
