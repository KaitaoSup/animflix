/**
 * Synchronisation multi-appareils des données du front (historique et position de lecture, favoris,
 * profils, préférences) pour les utilisateurs connectés.
 *
 * Modèle : chaque donnée est un élément (espace de noms + clé) au format JSON.
 *  - Arbitrage « dernier écrit gagne » sur l'horodatage client `updatedAt` (ms).
 *  - Une suppression est un élément sans données (pierre tombale), pour qu'elle se propage aux autres appareils.
 *  - Chaque écriture acceptée reçoit une révision serveur croissante : un appareil ne télécharge que les
 *    éléments modifiés depuis sa dernière révision connue.
 */

export const SYNC_LIMITS = {
  MAX_ITEMS_PER_PUSH: 500,
  MAX_ITEMS_PER_PULL: 2000,
  MAX_KEY_LENGTH: 256,
  MAX_DATA_BYTES: 16 * 1024,
  // Un appareil dont l'horloge avance ne doit pas gagner tous les arbitrages futurs
  MAX_CLOCK_AHEAD_MS: 5 * 60 * 1000,
  TOMBSTONE_MAX_AGE_MS: 90 * 24 * 60 * 60 * 1000
};

// 'profiles', 'prefs', 'history:<idProfil>', 'favorites:<idProfil>', 'stats:<idProfil>'
const NAMESPACE_RE = /^(?:profiles|prefs|(?:history|favorites|stats):[A-Za-z0-9_-]{1,64})$/;

export function isValidNamespace(ns) {
  return typeof ns === 'string' && NAMESPACE_RE.test(ns);
}

/**
 * Valide et normalise un élément envoyé par le client. Retourne null s'il est invalide.
 */
export function normalizeSyncItem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const { ns, key } = raw;
  if (!isValidNamespace(ns)) return null;
  if (typeof key !== 'string' || key.length === 0 || key.length > SYNC_LIMITS.MAX_KEY_LENGTH) return null;

  const updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return null;

  let data = null;
  if (!raw.deleted) {
    if (raw.data === undefined || raw.data === null || typeof raw.data !== 'object') return null;
    data = JSON.stringify(raw.data);
    if (Buffer.byteLength(data) > SYNC_LIMITS.MAX_DATA_BYTES) return null;
  }

  return {
    ns,
    key,
    data,
    updatedAt: Math.min(Math.round(updatedAt), now + SYNC_LIMITS.MAX_CLOCK_AHEAD_MS)
  };
}

function toClientItem(ns, key, rawData, updatedAt) {
  let data = null;
  if (rawData !== null && rawData !== undefined) {
    try { data = JSON.parse(rawData); } catch (e) { data = null; }
  }
  return { ns, key, data, deleted: data === null, updatedAt };
}

export function createSyncStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_items (
      user_id INTEGER NOT NULL,
      ns TEXT NOT NULL,
      item_key TEXT NOT NULL,
      data TEXT,
      updated_at INTEGER NOT NULL,
      rev INTEGER NOT NULL,
      PRIMARY KEY (user_id, ns, item_key),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_sync_items_user_rev ON sync_items(user_id, rev);
  `);

  const selectMaxRev = db.prepare('SELECT COALESCE(MAX(rev), 0) AS rev FROM sync_items WHERE user_id = ?');
  const selectItem = db.prepare('SELECT data, updated_at FROM sync_items WHERE user_id = ? AND ns = ? AND item_key = ?');
  const upsertItem = db.prepare(`
    INSERT INTO sync_items (user_id, ns, item_key, data, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, ns, item_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, rev = excluded.rev
  `);
  const selectSince = db.prepare(`
    SELECT ns, item_key, data, updated_at, rev FROM sync_items
    WHERE user_id = ? AND rev > ? ORDER BY rev ASC LIMIT ?
  `);

  /**
   * Enregistre les éléments reçus d'un appareil (dernier écrit gagne).
   * Retourne { rev, accepted, rejected, conflicts } : `rejected` compte les éléments invalides ou plus anciens que
   * le serveur, et `conflicts` donne la version (plus récente) que le serveur a gardée, pour que l'appareil s'aligne.
   */
  const push = db.transaction((userId, rawItems, now = Date.now()) => {
    let rev = selectMaxRev.get(userId).rev;
    let accepted = 0;
    let rejected = 0;
    const conflicts = [];
    for (const raw of rawItems) {
      const item = normalizeSyncItem(raw, now);
      if (!item) { rejected++; continue; }
      const existing = selectItem.get(userId, item.ns, item.key);
      // À égalité, l'écriture reçue l'emporte : renvoyer deux fois le même élément est sans effet visible
      if (existing && existing.updated_at > item.updatedAt) {
        rejected++;
        conflicts.push(toClientItem(item.ns, item.key, existing.data, existing.updated_at));
        continue;
      }
      rev++;
      upsertItem.run(userId, item.ns, item.key, item.data, item.updatedAt, rev);
      accepted++;
    }
    return { rev, accepted, rejected, conflicts };
  });

  /**
   * Éléments modifiés après la révision `sinceRev`. `more` indique qu'il faut redemander la suite.
   */
  function pull(userId, sinceRev = 0, limit = SYNC_LIMITS.MAX_ITEMS_PER_PULL) {
    const rows = selectSince.all(userId, Math.max(0, Math.floor(Number(sinceRev) || 0)), limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    const items = page.map(r => ({ ...toClientItem(r.ns, r.item_key, r.data, r.updated_at), rev: r.rev }));
    const rev = page.length > 0 ? page[page.length - 1].rev : selectMaxRev.get(userId).rev;
    return { rev, items, more };
  }

  const deleteOldTombstones = db.prepare('DELETE FROM sync_items WHERE data IS NULL AND updated_at < ?');

  /**
   * Supprime les pierres tombales plus vieilles que `maxAgeMs`. Un appareil resté hors ligne plus longtemps
   * garderait l'élément supprimé chez lui (sans le renvoyer tant qu'il n'y est pas modifié).
   */
  function pruneTombstones(maxAgeMs = SYNC_LIMITS.TOMBSTONE_MAX_AGE_MS, now = Date.now()) {
    return deleteOldTombstones.run(now - maxAgeMs).changes;
  }

  return { push, pull, pruneTombstones };
}
