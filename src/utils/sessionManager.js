import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { HLS_CACHE_DIR } from '../config/constants.js';
import { logServerError } from '../services/errorLog.js';

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
    const lines = tail.split(/[\r\n]+/).filter(Boolean).slice(-6);
    const lastLines = lines.join('\n   ');
    console.warn(`⚠️ ${label} terminé en erreur (code ${code}) :\n   ${lastLines}`);
    // Message regroupable : sans identifiant de client / session ni adresse mémoire
    const kind = label.replace(/\s*\(.*?\)\s*$/, '').replace(/^(FFmpeg HLS)\s.*$/, '$1');
    const lastLine = (lines[lines.length - 1] || '').replace(/ @ 0x[0-9a-f]+/gi, '').trim();
    logServerError('ffmpeg', `${kind} : ${lastLine || `code ${code}`}`, `${label} — code ${code}\n${lines.join('\n')}`);
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

// =========================================================================
// --- LECTURES EN COURS : QUI REGARDE QUOI, ARRÊT PAR L'ADMINISTRATEUR, LIMITE PAR COMPTE ---
// =========================================================================
//
// Chaque processus FFmpeg de lecture (direct / transcodage : process.animflixMeta ; HLS : session.meta)
// porte le compte, l'appareil, le titre et le mode. L'administrateur voit la liste et peut couper la
// lecture d'un appareil : le flux s'arrête, l'appareil ne peut pas relancer pendant 1 minute et son
// lecteur affiche « Lecture arrêtée par l'administrateur » (au lieu de relancer ou de signaler la source).

export const STREAM_CONTROL = {
  BLOCK_MS: 60 * 1000,          // l'appareil coupé ne peut pas relancer de lecture pendant ce délai
  NOTICE_MS: 10 * 60 * 1000,    // durée pendant laquelle le lecteur coupé peut l'apprendre
  MAX_TITLE: 140,
  STOP_MESSAGE: "Lecture arrêtée par l'administrateur du serveur."
};

const stoppedPlays = new Map();   // playId -> { at, message }
const blockedClients = new Map(); // clientId -> { until, message }

function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const v = value.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, STREAM_CONTROL.MAX_TITLE) : null;
}

/** Nom du torrent (paramètre dn du magnet), à défaut du titre envoyé par le lecteur */
function magnetDisplayName(magnet) {
  const m = /[?&]dn=([^&]+)/.exec(String(magnet || ''));
  if (!m) return null;
  try { return cleanTitle(decodeURIComponent(m[1].replace(/\+/g, ' '))); } catch (e) { return null; }
}

/** « Chrome · Android », « Safari · iPhone »… à partir du User-Agent */
export function describeDevice(ua) {
  const s = String(ua || '');
  if (!s) return 'Appareil inconnu';
  const os = /iPhone/.test(s) ? 'iPhone'
    : /iPad/.test(s) ? 'iPad'
    : /Android/.test(s) ? (/Mobile/.test(s) ? 'Android' : 'Tablette Android')
    : /CrOS/.test(s) ? 'ChromeOS'
    : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac'
    : /SmartTV|SMART-TV|Tizen|Web0S|webOS|BRAVIA|AFT[A-Z]/i.test(s) ? 'TV'
    : /Linux/.test(s) ? 'Linux' : null;
  const browser = /Edg\//.test(s) ? 'Edge'
    : /OPR\/|Opera/.test(s) ? 'Opera'
    : /SamsungBrowser/.test(s) ? 'Samsung Internet'
    : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome'
    : /Safari\//.test(s) ? 'Safari'
    : /VLC|Lavf|ffmpeg|mpv/i.test(s) ? 'Lecteur externe' : null;
  return [browser, os].filter(Boolean).join(' · ') || 'Appareil inconnu';
}

/** Métadonnées d'un flux, attachées au processus FFmpeg (direct/transcodage) ou à la session HLS */
export function buildStreamMeta(req, { clientId, playId = null, mode, magnet, fileIndex = 1, local = false, now = Date.now() }) {
  return {
    clientId,
    playId: playId || null,
    userId: req?.user?.id ?? null,
    username: req?.user?.username ?? null,
    title: cleanTitle(req?.query?.title) || magnetDisplayName(magnet) || 'Lecture sans titre',
    hash: (/xt=urn:btih:([a-z0-9]+)/i.exec(String(magnet || ''))?.[1] || '').toLowerCase() || null,
    fileIndex,
    mode,
    local: !!local,
    device: describeDevice(req?.headers?.['user-agent']),
    startedAt: now
  };
}

/** Toutes les lectures en cours (un flux par appareil), les plus récentes d'abord */
export function listActiveStreams(now = Date.now()) {
  const list = [];
  for (const [clientId, proc] of activeClientFfmpegProcesses.entries()) {
    if (!isProcessAlive(proc) || !proc.animflixMeta) continue;
    list.push({ ...proc.animflixMeta, clientId, kind: 'progressive', lastAccess: now });
  }
  for (const session of activeHlsSessions.values()) {
    if (!isProcessAlive(session.ffmpegProcess) || !session.meta) continue;
    list.push({ ...session.meta, clientId: session.clientId, playId: session.playId, kind: 'hls', lastAccess: session.lastAccess });
  }
  return list.sort((a, b) => b.startedAt - a.startedAt);
}

/** Nombre de lectures du compte, hors celle de l'appareil qui demande (elle est remplacée) */
export function countUserStreams(userId, exceptClientId = null) {
  if (userId === null || userId === undefined) return 0;
  return listActiveStreams().filter(s => s.userId === userId && s.clientId !== exceptClientId).length;
}

/**
 * Coupe la lecture d'un appareil. Retourne le nombre de flux arrêtés.
 */
export function stopClientStreams(clientId, { message = STREAM_CONTROL.STOP_MESSAGE, now = Date.now() } = {}) {
  if (!clientId) return 0;
  const playIds = [];
  const proc = activeClientFfmpegProcesses.get(clientId);
  let stopped = 0;
  if (proc && isProcessAlive(proc)) {
    stopped++;
    if (proc.animflixMeta?.playId) playIds.push(proc.animflixMeta.playId);
  }
  for (const playId of clientActiveHlsMap.get(clientId) || []) {
    if (activeHlsSessions.has(playId)) stopped++;
    playIds.push(playId);
  }
  for (const id of playIds) stoppedPlays.set(id, { at: now, message });
  blockedClients.set(clientId, { until: now + STREAM_CONTROL.BLOCK_MS, message });
  killClientFfmpegProcess(clientId);
  stopClientHlsSession(clientId);
  return stopped;
}

/** Appareil coupé il y a moins d'une minute : { message, retryAfterS } ; sinon null */
export function getClientBlock(clientId, now = Date.now()) {
  const b = clientId ? blockedClients.get(clientId) : null;
  if (!b) return null;
  if (now >= b.until) {
    blockedClients.delete(clientId);
    return null;
  }
  return { message: b.message, retryAfterS: Math.ceil((b.until - now) / 1000) };
}

/** Lecture (playId) refusée ou coupée par l'administrateur */
export function markPlayStopped(playId, message = STREAM_CONTROL.STOP_MESSAGE, now = Date.now()) {
  if (playId) stoppedPlays.set(playId, { at: now, message });
}

export function getPlayStopNotice(playId, now = Date.now()) {
  const n = playId ? stoppedPlays.get(playId) : null;
  if (!n) return null;
  if (now - n.at > STREAM_CONTROL.NOTICE_MS) {
    stoppedPlays.delete(playId);
    return null;
  }
  return { message: n.message };
}

export function pruneStreamControl(now = Date.now()) {
  for (const [id, n] of stoppedPlays.entries()) if (now - n.at > STREAM_CONTROL.NOTICE_MS) stoppedPlays.delete(id);
  for (const [id, b] of blockedClients.entries()) if (now >= b.until) blockedClients.delete(id);
}

setInterval(() => pruneStreamControl(), 60000).unref();
