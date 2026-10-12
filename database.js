import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'animflix.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
export const db = new Database(dbPath);

// Activer le mode WAL pour de meilleures performances et la concurrence
db.pragma('journal_mode = WAL');

// Initialiser les tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE COLLATE NOCASE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    anilist_token TEXT,
    anilist_id INTEGER,
    anilist_name TEXT,
    anilist_avatar TEXT,
    anilist_options TEXT DEFAULT '{}',
    preferences TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

/**
 * Hachage de mot de passe avec scrypt natif et sel unique
 */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

/**
 * Vérification sécurisée du mot de passe en temps constant
 */
export function verifyPassword(password, hash, salt) {
  try {
    const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
  } catch (e) {
    return false;
  }
}

/**
 * Nettoyage des données utilisateur avant envoi au client
 */
export function sanitizeUser(user) {
  if (!user) return null;
  let anilistOptions = {};
  try {
    if (user.anilist_options) anilistOptions = JSON.parse(user.anilist_options);
  } catch (e) {}

  let preferences = {};
  try {
    if (user.preferences) preferences = JSON.parse(user.preferences);
  } catch (e) {}

  return {
    id: user.id,
    username: user.username,
    createdAt: user.created_at,
    preferences,
    anilist: user.anilist_token ? {
      token: user.anilist_token,
      id: user.anilist_id,
      name: user.anilist_name,
      avatar: user.anilist_avatar,
      options: anilistOptions
    } : null
  };
}

/**
 * Création d'un nouvel utilisateur
 */
export function createUser(username, password, anilistData = null) {
  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 3 || cleanUsername.length > 32) {
    throw new Error('Le nom d\'utilisateur doit contenir entre 3 et 32 caractères.');
  }
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(cleanUsername)) {
    throw new Error('Le nom d\'utilisateur ne peut contenir que des lettres, chiffres, tirets et underscores.');
  }
  if (!password || String(password).length < 4) {
    throw new Error('Le mot de passe doit contenir au moins 4 caractères.');
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(cleanUsername);
  if (existing) {
    throw new Error('Ce nom d\'utilisateur est déjà pris.');
  }

  const { hash, salt } = hashPassword(password);
  
  const stmt = db.prepare(`
    INSERT INTO users (
      username, password_hash, salt,
      anilist_token, anilist_id, anilist_name, anilist_avatar, anilist_options
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const anilistToken = anilistData?.token || null;
  const anilistId = anilistData?.id || null;
  const anilistName = anilistData?.name || null;
  const anilistAvatar = anilistData?.avatar || null;
  const anilistOptions = anilistData?.options ? JSON.stringify(anilistData.options) : '{}';

  const info = stmt.run(
    cleanUsername,
    hash,
    salt,
    anilistToken,
    anilistId,
    anilistName,
    anilistAvatar,
    anilistOptions
  );

  return getUserById(info.lastInsertRowid);
}

/**
 * Récupère un utilisateur par ID
 */
export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * Récupère un utilisateur par nom d'utilisateur (insensible à la casse)
 */
export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(String(username).trim());
}

/**
 * Met à jour les informations AniList d'un utilisateur
 */
export function updateUserAnilist(userId, anilistData) {
  const stmt = db.prepare(`
    UPDATE users SET
      anilist_token = ?,
      anilist_id = ?,
      anilist_name = ?,
      anilist_avatar = ?,
      anilist_options = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  const anilistToken = anilistData?.token || null;
  const anilistId = anilistData?.id || null;
  const anilistName = anilistData?.name || null;
  const anilistAvatar = anilistData?.avatar || null;
  const anilistOptions = anilistData?.options ? JSON.stringify(anilistData.options) : '{}';

  stmt.run(anilistToken, anilistId, anilistName, anilistAvatar, anilistOptions, userId);
  return getUserById(userId);
}

/**
 * Dissocie le compte AniList d'un utilisateur
 */
export function unlinkUserAnilist(userId) {
  const stmt = db.prepare(`
    UPDATE users SET
      anilist_token = NULL,
      anilist_id = NULL,
      anilist_name = NULL,
      anilist_avatar = NULL,
      anilist_options = '{}',
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(userId);
  return getUserById(userId);
}

/**
 * Création d'une session de 90 jours
 */
export function createSession(userId, durationDays = 90) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + (durationDays * 24 * 60 * 60 * 1000);

  const stmt = db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  stmt.run(token, userId, now, expiresAt);

  return { token, expiresAt };
}

/**
 * Récupération de l'utilisateur à partir d'un token de session valide
 */
export function getSessionUser(token) {
  if (!token) return null;
  const now = Date.now();
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;

  if (session.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }

  const user = getUserById(session.user_id);
  return user || null;
}

/**
 * Suppression d'une session (déconnexion)
 */
export function deleteSession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * Nettoyage périodique des sessions expirées
 */
export function cleanupExpiredSessions() {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}

export default {
  db,
  hashPassword,
  verifyPassword,
  sanitizeUser,
  createUser,
  getUserById,
  getUserByUsername,
  updateUserAnilist,
  unlinkUserAnilist,
  createSession,
  getSessionUser,
  deleteSession,
  cleanupExpiredSessions
};
