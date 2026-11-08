import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { HLS_CACHE_DIR } from '../config/constants.js';

// --- SUIVI ET ISOLATION DES SESSIONS CLIENTS ---
export const activeClientFfmpegProcesses = new Map(); // key: clientId, value: ChildProcess
export const activePlaySessions = new Map();           // key: playId, value: PlaySession
export const activeHlsSessions = new Map();            // key: playId, value: HlsSession
export const clientActiveHlsMap = new Map();           // key: clientId, value: Set<playId>
export const activeClientThumbProcesses = new Map();   // key: clientId, value: ChildProcess

/**
 * Résolution et isolation stricte du clientId
 * Évite le problème où deux appareils sur la même IP (LAN, Wi-Fi, Tailscale, Reverse Proxy)
 * partagent req.ip et s'interrompent mutuellement lors d'un seek ou changement d'épisode.
 */
export function resolveClientId(req) {
  const fromQuery = typeof req?.query?.clientId === 'string' ? req.query.clientId.trim() : null;
  const fromHeader = typeof req?.headers?.['x-client-id'] === 'string' ? req.headers['x-client-id'].trim() : null;
  const candidate = fromQuery || fromHeader;

  // Validation stricte : caractères alphanumériques, tirets et underscores (entre 4 et 64 caractères)
  if (candidate && /^[a-zA-Z0-9_\-]{4,64}$/.test(candidate)) {
    return candidate;
  }

  // Si aucun clientId valide n'a été fourni, générer un identifiant cryptographiquement unique
  // pour cette session afin de ne JAMAIS utiliser l'IP brute comme identifiant de processus partagé
  return `anon_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Interrompt proprement tout flux FFmpeg direct/transcodé en cours pour un client spécifique
 */
export function killClientFfmpegProcess(clientId) {
  if (!clientId) return;
  if (activeClientFfmpegProcesses.has(clientId)) {
    const prev = activeClientFfmpegProcesses.get(clientId);
    try {
      prev.kill('SIGKILL');
    } catch (e) {}
    activeClientFfmpegProcesses.delete(clientId);
  }
}

/**
 * Lit en continu le stderr d'un processus FFmpeg de streaming.
 *
 * Sans lecteur, le tampon du socket stderr (~200 Ko) se remplit avec le journal de FFmpeg
 * (une ligne par segment HLS, statistiques de progression, une ligne par image avec showinfo…).
 * FFmpeg se bloque alors sur l'écriture de son journal, cesse de lire TorrServer, et la lecture
 * se fige au bout de quelques minutes (débit du torrent à ~0 o/s malgré les seeders).
 *
 * Les dernières lignes sont gardées et affichées si FFmpeg se termine en erreur.
 */
export function drainFfmpegStderr(proc, label = 'FFmpeg') {
  if (!proc?.stderr) return;
  let tail = '';
  proc.stderr.on('data', (chunk) => {
    tail = (tail + chunk.toString('utf8')).slice(-4000);
  });
  proc.on('close', (code) => {
    // code null = tué volontairement (seek, arrêt) : rien à signaler
    if (code === 0 || code === null || !tail.trim()) return;
    const lastLines = tail.split(/[\r\n]+/).filter(Boolean).slice(-6).join('\n   ');
    console.warn(`⚠️ ${label} terminé en erreur (code ${code}) :\n   ${lastLines}`);
  });
}

function isProcessAlive(proc) {
  return Boolean(proc) && proc.exitCode === null && proc.signalCode === null;
}

/**
 * Nombre de flux vidéo FFmpeg actuellement en cours (lecture directe/transcodage + HLS)
 */
export function countActiveStreams() {
  let count = 0;
  for (const proc of activeClientFfmpegProcesses.values()) {
    if (isProcessAlive(proc)) count++;
  }
  for (const session of activeHlsSessions.values()) {
    if (isProcessAlive(session.ffmpegProcess)) count++;
  }
  return count;
}

/**
 * Interrompt un processus de génération de miniature pour un client donné
 */
export function killClientThumbProcess(clientId) {
  if (!clientId) return;
  if (activeClientThumbProcesses.has(clientId)) {
    const prev = activeClientThumbProcesses.get(clientId);
    try {
      prev.kill('SIGKILL');
    } catch (e) {}
    activeClientThumbProcesses.delete(clientId);
  }
}

/**
 * Nettoie une session HLS (processus FFmpeg + fichiers segments .ts et index .m3u8)
 */
export function cleanupHlsSession(playId) {
  if (!playId || !activeHlsSessions.has(playId)) return;
  const session = activeHlsSessions.get(playId);
  activeHlsSessions.delete(playId);

  // Retrait de la référence client
  if (session.clientId && clientActiveHlsMap.has(session.clientId)) {
    const set = clientActiveHlsMap.get(session.clientId);
    set.delete(playId);
    if (set.size === 0) clientActiveHlsMap.delete(session.clientId);
  }

  // Interruption du processus FFmpeg HLS
  if (session.ffmpegProcess) {
    try {
      session.ffmpegProcess.kill('SIGKILL');
    } catch (e) {}
  }

  // Suppression du dossier temporaire de segments HLS
  // Garde-fou : ne jamais supprimer récursivement autre chose qu'un sous-dossier direct du cache HLS
  const sessionDir = path.resolve(HLS_CACHE_DIR, playId);
  if (path.dirname(sessionDir) !== path.resolve(HLS_CACHE_DIR)) {
    console.error(`⛔ Suppression HLS refusée hors du cache : ${sessionDir}`);
    return;
  }
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

/**
 * Interrompt toutes les sessions HLS actives pour un client donné
 */
export function stopClientHlsSession(clientId) {
  if (!clientId || !clientActiveHlsMap.has(clientId)) return;
  const playIds = Array.from(clientActiveHlsMap.get(clientId));
  for (const playId of playIds) {
    cleanupHlsSession(playId);
  }
}

/**
 * Arrêt complet de tous les processus lors de la fermeture du serveur
 */
export function killAllProcesses() {
  console.log("🧹 Nettoyage des processus multimédias résiduels...");
  for (const [clientId, proc] of activeClientFfmpegProcesses.entries()) {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
  activeClientFfmpegProcesses.clear();

  for (const [clientId, proc] of activeClientThumbProcesses.entries()) {
    try { proc.kill('SIGKILL'); } catch (e) {}
  }
  activeClientThumbProcesses.clear();

  for (const playId of Array.from(activeHlsSessions.keys())) {
    cleanupHlsSession(playId);
  }
}

// Nettoyage régulier des sessions play-sync inactives (> 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activePlaySessions.entries()) {
    if (now - session.createdAt > 300000) {
      activePlaySessions.delete(id);
    }
  }
}, 60000).unref();

// Nettoyage régulier des sessions HLS inactives (> 2 minutes sans requête)
setInterval(() => {
  const now = Date.now();
  for (const [playId, session] of activeHlsSessions.entries()) {
    if (now - session.lastAccess > 120000) {
      cleanupHlsSession(playId);
    }
  }
}, 60000).unref();
