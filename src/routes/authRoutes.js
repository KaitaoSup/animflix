import { Router } from 'express';
import axios from 'axios';
import {
  createUser,
  getUserByUsername,
  verifyPassword,
  createSession,
  getSessionUser,
  deleteSession,
  updateUserAnilist,
  unlinkUserAnilist,
  sanitizeUser
} from '../../database.js';
import { createLoginLimiter, getClientIp, formatLockDelay } from '../utils/loginLimiter.js';

const router = Router();

// Anti brute-force sur /api/auth/login (par compte visé et par adresse IP)
export const loginLimiter = createLoginLimiter();

function sendTooManyAttempts(res, retryAfterMs) {
  res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
  return res.status(429).json({
    error: `Trop de tentatives de connexion. Réessayez dans ${formatLockDelay(retryAfterMs)}.`,
    retryAfter: Math.ceil(retryAfterMs / 1000)
  });
}

/**
 * Extraction des cookies depuis les en-têtes HTTP
 */
export function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const name = parts.shift().trim();
      const value = parts.join('=');
      if (name) {
        try {
          list[name] = decodeURIComponent(value);
        } catch (e) {
          list[name] = value;
        }
      }
    });
  }
  return list;
}

/**
 * Récupère le jeton de session depuis les cookies ou en-têtes
 */
export function extractSessionToken(req) {
  const cookies = parseCookies(req);
  let token = cookies.animflix_session;
  if (!token && req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.slice(7).trim();
  }
  if (!token && req.headers['x-session-token']) {
    token = req.headers['x-session-token'];
  }
  if (!token && req.query?.token) {
    token = req.query.token;
  }
  return token || null;
}

/**
 * Configure le cookie de session Animflix (90 jours)
 */
export function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `animflix_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000`);
}

/**
 * Supprime le cookie de session Animflix
 */
export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `animflix_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/**
 * Valide un jeton AniList auprès de l'API GraphQL AniList
 */
async function verifyAnilistTokenWithApi(token) {
  if (!token) return null;
  const query = `
    query {
      Viewer {
        id
        name
        avatar { large medium }
        siteUrl
        options {
          displayAdultContent
        }
      }
    }
  `;
  const response = await axios.post('https://graphql.anilist.co', { query }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Animflix/1.0'
    },
    timeout: 10000
  });

  if (response.data?.data?.Viewer) {
    const viewer = response.data.data.Viewer;
    return {
      token,
      id: viewer.id,
      name: viewer.name,
      avatar: viewer.avatar?.medium || viewer.avatar?.large || null,
      options: viewer.options || {}
    };
  }
  return null;
}

/**
 * Middleware d'extraction de l'utilisateur authentifié
 */
export function authMiddleware(req, res, next) {
  const token = extractSessionToken(req);
  if (token) {
    const user = getSessionUser(token);
    if (user) {
      req.user = user;
      req.token = token;
    }
  }
  next();
}

/**
 * Vérifier l'état de la session utilisateur actuelle
 */
router.get('/api/auth/me', (req, res) => {
  if (!req.user) {
    return res.json({ loggedIn: false });
  }
  res.json({
    loggedIn: true,
    user: sanitizeUser(req.user)
  });
});

/**
 * Inscription d'un nouvel utilisateur
 */
router.post('/api/auth/register', async (req, res) => {
  const { username, password, anilistToken } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Nom d'utilisateur et mot de passe requis." });
  }

  try {
    let anilistData = null;
    if (anilistToken) {
      try {
        anilistData = await verifyAnilistTokenWithApi(anilistToken);
      } catch (e) {
        console.warn("⚠️ Liaison AniList optionnelle échouée à l'inscription:", e.message);
      }
    }

    const user = createUser(username, password, anilistData);
    const session = createSession(user.id);
    setSessionCookie(res, session.token);

    return res.json({
      success: true,
      user: sanitizeUser(user),
      sessionToken: session.token,
      token: session.token
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

/**
 * Connexion d'un utilisateur existant
 */
router.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: "Nom d'utilisateur et mot de passe requis." });
  }

  // Les noms d'utilisateur ne tiennent pas compte de la casse (COLLATE NOCASE) : le compteur non plus
  const userKey = 'user:' + username.trim().toLowerCase();
  const limiterKeys = [userKey, 'ip:' + getClientIp(req)];
  const gate = loginLimiter.check(limiterKeys);
  if (!gate.allowed) {
    return sendTooManyAttempts(res, gate.retryAfterMs);
  }

  const user = getUserByUsername(username);
  const failure = !user ? { error: "Utilisateur introuvable.", field: 'username' }
    : !verifyPassword(password, user.password_hash, user.salt) ? { error: "Mot de passe erroné.", field: 'password' }
    : null;

  if (failure) {
    const result = loginLimiter.recordFailure(limiterKeys);
    if (result.lockedMs) {
      console.warn(`🔒 Connexion bloquée ${formatLockDelay(result.lockedMs)} (compte « ${username.trim().slice(0, 64)} », IP ${getClientIp(req)})`);
      return sendTooManyAttempts(res, result.lockedMs);
    }
    if (result.remaining <= 2) {
      const s = result.remaining > 1 ? 's' : '';
      failure.error += ` Encore ${result.remaining} essai${s} avant un blocage temporaire.`;
    }
    return res.status(401).json(failure);
  }

  loginLimiter.recordSuccess(userKey);
  const session = createSession(user.id);
  setSessionCookie(res, session.token);

  return res.json({
    success: true,
    user: sanitizeUser(user),
    sessionToken: session.token,
    token: session.token
  });
});

/**
 * Déconnexion
 */
router.post('/api/auth/logout', (req, res) => {
  const token = req.token || extractSessionToken(req) || req.body?.token;
  if (token) {
    deleteSession(token);
  }
  clearSessionCookie(res);
  res.json({ success: true });
});

/**
 * Associer un compte AniList au compte Animflix connecté
 */
router.post('/api/auth/anilist/link', async (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Vous devez être connecté à Animflix pour lier AniList." });
  }
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: "Jeton AniList requis." });
  }

  try {
    const anilistData = await verifyAnilistTokenWithApi(token);
    if (!anilistData) {
      return res.status(400).json({ error: "Jeton AniList invalide ou non reconnu." });
    }

    const updatedUser = updateUserAnilist(req.user.id, anilistData);
    res.json({
      success: true,
      user: sanitizeUser(updatedUser),
      anilist: anilistData
    });
  } catch (err) {
    console.error("Erreur liaison AniList:", err.message);
    res.status(400).json({ error: "Impossible de valider ce jeton auprès d'AniList: " + err.message });
  }
});

/**
 * Dissocier le compte AniList
 */
router.post('/api/auth/anilist/unlink', (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Non connecté." });
  }
  const updatedUser = unlinkUserAnilist(req.user.id);
  res.json({
    success: true,
    user: sanitizeUser(updatedUser)
  });
});

/**
 * Proxy GraphQL AniList
 */
router.post('/api/anilist/graphql', async (req, res) => {
  const { query, variables } = req.body;
  if (!query) {
    return res.status(400).json({ error: "Requête GraphQL manquante" });
  }

  let authHeader = req.headers.authorization;
  if (!authHeader && req.user?.anilist_token) {
    authHeader = `Bearer ${req.user.anilist_token}`;
  }

  try {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Animflix/1.0'
    };
    if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const aniRes = await axios.post('https://graphql.anilist.co', { query, variables }, {
      headers,
      timeout: 10000
    });

    res.json(aniRes.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const data = err.response?.data || { error: err.message };
    res.status(status).json(data);
  }
});

/**
 * Configuration AniList client
 */
router.get('/api/anilist/config', (req, res) => {
  res.json({
    clientId: process.env.ANILIST_CLIENT_ID || "24891"
  });
});

export default router;
