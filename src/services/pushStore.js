/**
 * Stockage des abonnements Web Push et des épisodes déjà notifiés.
 * Prend la base en paramètre (comme syncStore) pour être testable avec une base en mémoire.
 */

export const PUSH_LIMITS = {
  MAX_ENDPOINT_LENGTH: 1024,
  MAX_KEY_LENGTH: 256,
  MAX_SUBSCRIPTIONS_PER_USER: 10,
  // Les épisodes notifiés plus vieux que ça ne servent plus (la fenêtre de recherche est bien plus courte)
  NOTIFIED_MAX_AGE_MS: 60 * 24 * 60 * 60 * 1000
};

export const PUSH_LANGS = ['vostfr', 'vf', 'multisub', 'sub'];

// Services de push des navigateurs : le serveur n'envoie des requêtes qu'à eux (pas d'URL arbitraire)
const DEFAULT_PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',        // Chrome, Edge (Android), Opera, Samsung Internet
  'push.services.mozilla.com', // Firefox
  'push.apple.com',            // Safari (macOS, iOS 16.4+ en PWA)
  'notify.windows.com'         // Edge (Windows)
];

function allowedPushHosts() {
  const extra = (process.env.PUSH_ALLOWED_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_PUSH_HOST_SUFFIXES, ...extra];
}

export function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > PUSH_LIMITS.MAX_ENDPOINT_LENGTH) return false;
  let url;
  try { url = new URL(endpoint); } catch (e) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return allowedPushHosts().some(suffix => host === suffix || host.endsWith('.' + suffix));
}

/**
 * Valide un abonnement PushSubscription envoyé par le navigateur. Retourne null s'il est invalide.
 */
export function normalizeSubscription(raw, lang) {
  if (!raw || typeof raw !== 'object') return null;
  const { endpoint } = raw;
  const p256dh = raw.keys?.p256dh;
  const auth = raw.keys?.auth;
  if (!isAllowedPushEndpoint(endpoint)) return null;
  const isKey = (k) => typeof k === 'string' && k.length > 0 && k.length <= PUSH_LIMITS.MAX_KEY_LENGTH && /^[A-Za-z0-9_=-]+$/.test(k);
  if (!isKey(p256dh) || !isKey(auth)) return null;
  return { endpoint, p256dh, auth, lang: PUSH_LANGS.includes(lang) ? lang : 'vostfr' };
}

export function createPushStore(db) {
  db.exec(`
    -- Abonnements Web Push (un par navigateur / appareil)
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'vostfr',
      created_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

    -- Épisodes déjà notifiés (une seule notification par utilisateur et par épisode)
    CREATE TABLE IF NOT EXISTS episode_notifications (
      user_id INTEGER NOT NULL,
      media_id INTEGER NOT NULL,
      episode INTEGER NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, media_id, episode)
    );
  `);

  const stmts = {
    upsert: db.prepare(`
      INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, lang, created_at)
      VALUES (@endpoint, @userId, @p256dh, @auth, @lang, @now)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        lang = excluded.lang,
        -- Même appareil passé à un autre compte : il repart de zéro (pas de rattrapage des épisodes passés)
        created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id
                          THEN push_subscriptions.created_at ELSE excluded.created_at END
    `),
    deleteForUser: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'),
    deleteEndpoint: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    countForUser: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?'),
    oldestForUser: db.prepare(`
      SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at ASC LIMIT ?
    `),
    listForUser: db.prepare('SELECT endpoint, p256dh, auth, lang, created_at FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC'),
    hasEndpoint: db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?'),
    usersToNotify: db.prepare(`
      SELECT u.id, u.anilist_id, u.anilist_token,
             MIN(s.created_at) AS since,
             (SELECT lang FROM push_subscriptions WHERE user_id = u.id ORDER BY created_at DESC LIMIT 1) AS lang
      FROM users u
      JOIN push_subscriptions s ON s.user_id = u.id
      WHERE u.anilist_id IS NOT NULL AND u.anilist_token IS NOT NULL
      GROUP BY u.id
    `),
    wasNotified: db.prepare('SELECT 1 FROM episode_notifications WHERE user_id = ? AND media_id = ? AND episode = ?'),
    markNotified: db.prepare(`
      INSERT OR IGNORE INTO episode_notifications (user_id, media_id, episode, sent_at) VALUES (?, ?, ?, ?)
    `),
    pruneNotified: db.prepare('DELETE FROM episode_notifications WHERE sent_at < ?')
  };

  return {
    /** Enregistre (ou réattribue) l'abonnement d'un appareil ; au-delà de la limite, les plus anciens sont retirés */
    subscribe(userId, sub, now = Date.now()) {
      db.transaction(() => {
        stmts.upsert.run({ ...sub, userId, now });
        const { n } = stmts.countForUser.get(userId);
        const excess = n - PUSH_LIMITS.MAX_SUBSCRIPTIONS_PER_USER;
        if (excess > 0) {
          stmts.oldestForUser.all(userId, excess).forEach(r => stmts.deleteEndpoint.run(r.endpoint));
        }
      })();
    },

    unsubscribe(userId, endpoint) {
      return stmts.deleteForUser.run(endpoint, userId).changes > 0;
    },

    /** Abonnement expiré ou révoqué (réponse 404 / 410 du service de push) */
    removeEndpoint(endpoint) {
      stmts.deleteEndpoint.run(endpoint);
    },

    isSubscribed(userId, endpoint) {
      return !!stmts.hasEndpoint.get(endpoint, userId);
    },

    listForUser(userId) {
      return stmts.listForUser.all(userId);
    },

    /** Utilisateurs avec au moins un appareil abonné et un compte AniList lié */
    usersToNotify() {
      return stmts.usersToNotify.all();
    },

    wasNotified(userId, mediaId, episode) {
      return !!stmts.wasNotified.get(userId, mediaId, episode);
    },

    markNotified(userId, mediaId, episode, now = Date.now()) {
      stmts.markNotified.run(userId, mediaId, episode, now);
    },

    pruneNotified(now = Date.now()) {
      return stmts.pruneNotified.run(now - PUSH_LIMITS.NOTIFIED_MAX_AGE_MS).changes;
    }
  };
}
