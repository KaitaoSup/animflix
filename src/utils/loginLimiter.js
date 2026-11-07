/**
 * Limitation des tentatives de connexion (anti brute-force), en mémoire.
 *
 * Deux compteurs par tentative ratée : le nom d'utilisateur visé et l'adresse IP.
 *  - Quelques essais gratuits, puis blocage temporaire qui double à chaque nouvel échec (1, 2, 4, 8 min… plafonné).
 *  - Le compteur repart de zéro après une période sans échec (comptée depuis la fin du dernier blocage).
 *  - Pendant un blocage, même le bon mot de passe est refusé : sinon le blocage ne protégerait rien.
 *  - Une connexion réussie efface le compteur du compte (pas celui de l'IP, qui peut être partagée).
 * Seuil plus haut pour l'IP : plusieurs personnes peuvent passer par la même (box, proxy).
 */

export const LOGIN_LIMITS = {
  USER_FREE_ATTEMPTS: 5,
  IP_FREE_ATTEMPTS: 20,
  BASE_LOCK_MS: 60 * 1000,
  MAX_LOCK_MS: 15 * 60 * 1000,
  RESET_AFTER_MS: 15 * 60 * 1000,
  MAX_ENTRIES: 10000
};

export function createLoginLimiter({ now = () => Date.now(), limits = LOGIN_LIMITS } = {}) {
  const entries = new Map(); // clé -> { failures, lastAt, lockedUntil }

  const freeAttempts = (key) => key.startsWith('ip:') ? limits.IP_FREE_ATTEMPTS : limits.USER_FREE_ATTEMPTS;

  // Entrée encore valable (null si absente ou périmée)
  function live(key, t) {
    const e = entries.get(key);
    if (!e) return null;
    if (t > Math.max(e.lastAt, e.lockedUntil) + limits.RESET_AFTER_MS) {
      entries.delete(key);
      return null;
    }
    return e;
  }

  function prune(t) {
    if (entries.size <= limits.MAX_ENTRIES) return;
    for (const key of entries.keys()) live(key, t);
    // Toujours trop : on oublie les plus anciennes (ordre d'insertion de la Map)
    for (const key of entries.keys()) {
      if (entries.size <= limits.MAX_ENTRIES) break;
      entries.delete(key);
    }
  }

  return {
    /** { allowed: true } ou { allowed: false, retryAfterMs } si l'une des clés est bloquée */
    check(keys) {
      const t = now();
      let retryAfterMs = 0;
      for (const key of keys) {
        const e = live(key, t);
        if (e && e.lockedUntil > t) retryAfterMs = Math.max(retryAfterMs, e.lockedUntil - t);
      }
      return retryAfterMs > 0 ? { allowed: false, retryAfterMs } : { allowed: true };
    },

    /**
     * Enregistre un échec. Retourne { lockedMs } si un blocage commence, sinon { remaining } :
     * le nombre d'essais restants avant blocage (le plus petit parmi les clés).
     */
    recordFailure(keys) {
      const t = now();
      let lockedMs = 0;
      let remaining = Infinity;
      for (const key of keys) {
        let e = live(key, t);
        if (!e) {
          e = { failures: 0, lastAt: t, lockedUntil: 0 };
          entries.set(key, e);
        }
        e.failures++;
        e.lastAt = t;
        const free = freeAttempts(key);
        if (e.failures >= free) {
          const lock = Math.min(limits.BASE_LOCK_MS * 2 ** (e.failures - free), limits.MAX_LOCK_MS);
          e.lockedUntil = t + lock;
          lockedMs = Math.max(lockedMs, lock);
        } else {
          remaining = Math.min(remaining, free - e.failures);
        }
      }
      prune(t);
      return lockedMs > 0 ? { lockedMs } : { remaining };
    },

    recordSuccess(key) {
      entries.delete(key);
    },

    size() {
      return entries.size;
    }
  };
}

const LOOPBACK_RE = /^(?:127\.|::1$|::ffff:127\.)/;

/**
 * Adresse IP du client. X-Forwarded-For n'est lu que si la connexion vient de la machine elle-même
 * (proxy local : Tailscale Serve / Funnel, nginx…) ; sinon n'importe qui pourrait choisir son IP.
 * Le proxy ajoute l'IP qu'il voit en dernier : c'est la seule entrée fiable de la liste.
 */
export function getClientIp(req) {
  const socketIp = req.socket?.remoteAddress || req.ip || '';
  const forwarded = req.headers?.['x-forwarded-for'];
  if (LOOPBACK_RE.test(socketIp) && typeof forwarded === 'string' && forwarded.trim()) {
    const parts = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return socketIp.replace(/^::ffff:/, '') || 'inconnue';
}

export function formatLockDelay(ms) {
  const minutes = Math.ceil(ms / 60000);
  return minutes <= 1 ? '1 minute' : `${minutes} minutes`;
}
