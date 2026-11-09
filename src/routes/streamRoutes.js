import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { TORRSERVER_LOCAL_URL, HLS_CACHE_DIR, VAAPI_DEVICE, MAX_CONCURRENT_STREAMS, MAX_STREAMS_PER_USER } from '../config/constants.js';
import { getTorrentHash } from '../utils/network.js';
import {
  parseFileIndex,
  parseTrackIndex,
  parseSeekSeconds,
  parsePlaybackParams,
  isValidPlayId
} from '../utils/params.js';
import { buildDirectArgs, buildTranscodeArgs, buildHlsArgs, isH264DirectCopy } from '../services/ffmpegArgs.js';
import {
  countActiveStreams,
  resolveClientId,
  activeClientFfmpegProcesses,
  activePlaySessions,
  activeHlsSessions,
  clientActiveHlsMap,
  cleanupHlsSession,
  stopClientHlsSession,
  killClientFfmpegProcess,
  drainFfmpegStderr,
  buildStreamMeta,
  countUserStreams,
  getClientBlock,
  markPlayStopped,
  getPlayStopNotice
} from '../utils/sessionManager.js';
import {
  getStreamInfo,
  generateThumbnail,
  probeKeyframeStart,
  getDetectedHwAccel
} from '../services/ffmpegService.js';
import { streamSubtitlesLive } from '../services/subtitlesService.js';
import { getEmbeddedFonts, resolveFontFile } from '../services/fontsService.js';
import { getTorrentFiles } from '../services/torrserverService.js';
import { mediaInputUrl, getDownloadManager } from '../services/downloadService.js';

const router = Router();

/**
 * Marque une session play-sync comme résolue et réveille les requêtes /api/play-sync en attente
 */
function releasePlaySession(playSession, actualStart) {
  if (!playSession) return;
  playSession.actualStart = actualStart;
  playSession.keyframeOffset = 0;
  playSession.resolved = true;
  while (playSession.waiters && playSession.waiters.length > 0) {
    playSession.waiters.shift()();
  }
}

// --- ROUTE API INFO FLUX (AUDIO & SOUS-TITRES) ---
/**
 * Occupation du serveur : le lecteur la consulte quand une lecture échoue, pour distinguer
 * « serveur saturé » (503) d'un format illisible (le navigateur ne donne pas le code HTTP d'une <video>)
 */
router.get('/api/streams/capacity', (req, res) => {
  const active = countActiveStreams();
  res.setHeader('Cache-Control', 'no-store');
  const clientId = typeof req.query.clientId === 'string' ? req.query.clientId : null;
  const playId = typeof req.query.playId === 'string' && isValidPlayId(req.query.playId) ? req.query.playId : null;
  // Limite par compte : lectures du compte sur ses AUTRES appareils
  let user = null;
  if (req.user && MAX_STREAMS_PER_USER > 0) {
    const mine = countUserStreams(req.user.id, clientId);
    user = { active: mine, max: MAX_STREAMS_PER_USER, full: mine >= MAX_STREAMS_PER_USER };
  }
  res.json({
    active,
    max: MAX_CONCURRENT_STREAMS,
    full: active >= MAX_CONCURRENT_STREAMS,
    user,
    // Lecture coupée par l'administrateur (le lecteur l'affiche au lieu de relancer)
    stopped: getPlayStopNotice(playId)
  });
});

/**
 * Refus d'une nouvelle lecture : appareil coupé par l'administrateur il y a moins d'une minute (403),
 * limite de lectures du compte atteinte (429). Retourne true si la réponse est envoyée.
 */
function refuseStreamStart(req, res, clientId, playId) {
  const block = getClientBlock(clientId);
  if (block) {
    markPlayStopped(playId, block.message);
    res.setHeader('Retry-After', String(block.retryAfterS));
    res.status(403).send(block.message);
    return true;
  }
  if (req.user && MAX_STREAMS_PER_USER > 0 && countUserStreams(req.user.id, clientId) >= MAX_STREAMS_PER_USER) {
    console.warn(`⛔ Limite de ${MAX_STREAMS_PER_USER} lecture(s) par compte atteinte (${req.user.username})`);
    res.status(429).send(`Vous avez déjà ${MAX_STREAMS_PER_USER} lecture(s) en cours sur d'autres appareils.`);
    return true;
  }
  return false;
}

router.get('/api/streams', async (req, res) => {
  const { magnet } = req.query;
  if (!magnet) return res.status(400).json({ error: "Lien magnet manquant" });
  try {
    const info = await getStreamInfo(magnet, parseFileIndex(req.query.fileIndex));
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROUTE API STREAMING SOUS-TITRES (ASS NATIF OU WEBVTT) ---
router.get('/api/subtitles', (req, res) => {
  const { magnet, format = 'ass' } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");
  const fileIndex = parseFileIndex(req.query.fileIndex);
  const subIndex = parseTrackIndex(req.query.subIndex);
  return streamSubtitlesLive({ magnet, fileIndex, subIndex, format, req, res }).catch((err) => {
    console.error("Erreur sous-titres:", err.message);
    if (!res.headersSent) res.status(500).send("Erreur extraction sous-titres");
    else res.end();
  });
});

// --- ROUTE API POLICES EMBARQUÉES (PIÈCES JOINTES MKV DES FANSUBS) ---
router.get('/api/fonts', async (req, res) => {
  const { magnet } = req.query;
  if (!magnet) return res.status(400).json({ error: "Lien magnet manquant" });
  try {
    const fonts = await getEmbeddedFonts(magnet, parseFileIndex(req.query.fileIndex));
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ fonts: fonts.map(f => ({ ...f, url: '/api/fonts/' + f.id })) });
  } catch (err) {
    console.warn("⚠️ Polices embarquées indisponibles :", err.message.split('\n')[0]);
    res.status(503).json({ error: "Polices indisponibles", fonts: [] });
  }
});

router.get('/api/fonts/:id', (req, res) => {
  const font = resolveFontFile(req.params.id);
  if (!font) return res.status(404).send("Police introuvable");
  res.setHeader('Content-Type', font.contentType);
  // Identifiant = empreinte du contenu : cache navigateur permanent
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(font.filePath);
});

// --- ROUTE API SYNCHRONISATION PRÉCISE DU LECTEUR ET DES SOUS-TITRES ---
router.get('/api/play-sync', async (req, res) => {
  const { playId } = req.query;
  if (!isValidPlayId(playId)) return res.status(400).json({ error: "playId manquant ou invalide" });

  const parsedExpectedSeek = parseSeekSeconds(req.query.expectedSeek);

  let session = activePlaySessions.get(playId);
  if (!session) {
    session = {
      seekSeconds: parsedExpectedSeek,
      actualStart: parsedExpectedSeek,
      keyframeOffset: 0,
      resolved: parsedExpectedSeek === 0,
      createdAt: Date.now(),
      waiters: []
    };
    activePlaySessions.set(playId, session);
  }

  if (session.resolved) {
    return res.json({
      playId,
      actualStart: typeof session.actualStart === 'number' ? session.actualStart : parsedExpectedSeek,
      keyframeOffset: session.keyframeOffset || 0,
      seekSeconds: session.seekSeconds ?? parsedExpectedSeek,
      resolved: true
    });
  }

  // Si le flux est encore en cours d'initialisation, attendre jusqu'à 5 secondes
  await new Promise((resolve) => {
    session.waiters.push(resolve);
    setTimeout(resolve, 5000);
  });

  return res.json({
    playId,
    actualStart: typeof session.actualStart === 'number' ? session.actualStart : parsedExpectedSeek,
    keyframeOffset: session.keyframeOffset || 0,
    seekSeconds: session.seekSeconds ?? parsedExpectedSeek,
    resolved: session.resolved
  });
});

// --- TRANSCODEUR FFMPEG OPTIMISÉ (ZÉRO LATENCE, SEEK & MULTITHREAD) ---
router.get('/play', async (req, res) => {
  const { magnet, mode, playId } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");
  if (playId !== undefined && !isValidPlayId(playId)) return res.status(400).send("playId invalide");

  const {
    fileIndex: parsedFileIndex,
    audioIndex,
    seekSeconds,
    audioOffset: parsedAudioOffset
  } = parsePlaybackParams(req.query);
  const torrUrl = mediaInputUrl(magnet, parsedFileIndex);

  // Création / liaison de la session de synchronisation
  let playSession = null;
  if (playId) {
    playSession = activePlaySessions.get(playId);
    if (!playSession) {
      playSession = {
        seekSeconds,
        actualStart: seekSeconds,
        keyframeOffset: 0,
        resolved: seekSeconds === 0,
        createdAt: Date.now(),
        waiters: []
      };
      activePlaySessions.set(playId, playSession);
    } else {
      playSession.seekSeconds = seekSeconds;
      playSession.actualStart = seekSeconds;
      if (seekSeconds === 0) {
        playSession.resolved = true;
        playSession.keyframeOffset = 0;
        while (playSession.waiters && playSession.waiters.length > 0) {
          const resolve = playSession.waiters.shift();
          resolve();
        }
      }
    }
  }

  // Interruption immédiate et isolée de tout flux précédent DU MÊME CLIENT
  const clientId = resolveClientId(req);
  stopClientHlsSession(clientId);
  killClientFfmpegProcess(clientId);

  if (refuseStreamStart(req, res, clientId, playId)) {
    releasePlaySession(playSession, seekSeconds);
    return;
  }

  // Analyse des pistes (mode direct) AVANT la vérification de limite : aucun `await` ne doit séparer
  // le comptage des flux du lancement de FFmpeg, sinon deux requêtes simultanées dépassent la limite.
  const streamInfo = mode === 'direct'
    ? await getStreamInfo(magnet, parsedFileIndex).catch(() => null)
    : null;

  // Client parti pendant l'analyse : son événement 'close' est déjà passé, un FFmpeg lancé maintenant
  // ne serait jamais arrêté (processus zombie lisant le torrent indéfiniment)
  if (req.destroyed) {
    releasePlaySession(playSession, seekSeconds);
    return;
  }

  if (countActiveStreams() >= MAX_CONCURRENT_STREAMS) {
    console.warn(`⛔ Limite de ${MAX_CONCURRENT_STREAMS} flux simultanés atteinte, lecture refusée (client ${clientId})`);
    releasePlaySession(playSession, seekSeconds);
    return res.status(503).send(`Trop de lectures en cours (max ${MAX_CONCURRENT_STREAMS}). Réessayez dans un instant.`);
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // MODE 1 : LECTURE DIRECTE (0% CPU, STREAM ULTRA-RAPIDE SANS RÉENCODAGE VIDÉO)
  if (mode === 'direct') {
    console.log(`⚡ Lancement FFmpeg en Mode Direct (Fichier index: ${parsedFileIndex}, Seek: ${seekSeconds}s, Audio: ${audioIndex ?? 'auto'}, Offset: ${parsedAudioOffset}s, playId: ${playId ?? 'none'})`);
    const directArgs = buildDirectArgs({
      torrUrl,
      seekSeconds,
      audioIndex,
      audioOffset: parsedAudioOffset,
      streamInfo
    });

    const ffmpeg = spawn('ffmpeg', directArgs);
    drainFfmpegStderr(ffmpeg, `FFmpeg direct (${clientId})`);
    ffmpeg.animflixMeta = buildStreamMeta(req, { clientId, playId, mode: 'direct', magnet, fileIndex: parsedFileIndex, local: torrUrl.startsWith('file:') });
    activeClientFfmpegProcesses.set(clientId, ffmpeg);

    if (playSession) {
      if (seekSeconds === 0) {
        playSession.resolved = true;
        while (playSession.waiters && playSession.waiters.length > 0) {
          const resolve = playSession.waiters.shift();
          resolve();
        }
      } else {
        let stderrBuffer = '';
        const onData = (chunk) => {
          if (playSession.resolved) return;
          stderrBuffer += chunk.toString('utf8');
          const match = stderrBuffer.match(/\[showinfo[^\]]*\]\s*n:\s*0\b[\s\S]*?\bpt:\s*(-?[\d\.]+)/);
          if (match) {
            const ptOffset = parseFloat(match[1]) || 0;
            const actualStart = Math.max(0, Math.round((playSession.seekSeconds + ptOffset) * 1000) / 1000);
            playSession.actualStart = actualStart;
            playSession.keyframeOffset = ptOffset;
            playSession.resolved = true;
            console.log(`🎯 FFmpeg Keyframe détecté (${playId}) : demandé = ${playSession.seekSeconds}s, décalage = ${ptOffset}s -> effectif = ${actualStart}s`);
            while (playSession.waiters && playSession.waiters.length > 0) {
              const resolve = playSession.waiters.shift();
              resolve();
            }
            ffmpeg.stderr.off('data', onData);
          }
          if (stderrBuffer.length > 10000) {
            stderrBuffer = stderrBuffer.slice(-5000);
          }
        };
        ffmpeg.stderr.on('data', onData);
      }
    }

    ffmpeg.stdout.pipe(res);

    req.on('close', () => {
      ffmpeg.kill('SIGKILL');
      if (activeClientFfmpegProcesses.get(clientId) === ffmpeg) {
        activeClientFfmpegProcesses.delete(clientId);
      }
      if (playSession && !playSession.resolved) {
        if (typeof playSession.actualStart !== 'number' || isNaN(playSession.actualStart)) {
          playSession.actualStart = playSession.seekSeconds || 0;
        }
        playSession.resolved = true;
        while (playSession.waiters && playSession.waiters.length > 0) {
          const resolve = playSession.waiters.shift();
          resolve();
        }
      }
    });

    ffmpeg.on('close', () => {
      if (activeClientFfmpegProcesses.get(clientId) === ffmpeg) {
        activeClientFfmpegProcesses.delete(clientId);
      }
      if (playSession && !playSession.resolved) {
        if (typeof playSession.actualStart !== 'number' || isNaN(playSession.actualStart)) {
          playSession.actualStart = playSession.seekSeconds || 0;
        }
        playSession.resolved = true;
        while (playSession.waiters && playSession.waiters.length > 0) {
          const resolve = playSession.waiters.shift();
          resolve();
        }
      }
    });
    return;
  }

  // MODE 2 : TRANSCODAGE VIDÉO H.264
  if (playSession) {
    playSession.actualStart = seekSeconds;
    playSession.keyframeOffset = 0;
    playSession.resolved = true;
    while (playSession.waiters && playSession.waiters.length > 0) {
      const resolve = playSession.waiters.shift();
      resolve();
    }
  }

  const detectedHwAccel = getDetectedHwAccel();
  console.log(`🎬 Lancement FFmpeg en Mode Transcodage [${detectedHwAccel.toUpperCase()}] (Fichier index: ${parsedFileIndex}, Seek: ${seekSeconds}s)`);
  const transcodeArgs = buildTranscodeArgs({
    torrUrl,
    seekSeconds,
    audioIndex,
    audioOffset: parsedAudioOffset,
    hwAccel: detectedHwAccel,
    vaapiDevice: VAAPI_DEVICE
  });

  const ffmpeg = spawn('ffmpeg', transcodeArgs);
  drainFfmpegStderr(ffmpeg, `FFmpeg transcodage (${clientId})`);
  ffmpeg.animflixMeta = buildStreamMeta(req, { clientId, playId, mode: `transcode-${detectedHwAccel}`, magnet, fileIndex: parsedFileIndex, local: torrUrl.startsWith('file:') });
  activeClientFfmpegProcesses.set(clientId, ffmpeg);

  ffmpeg.stdout.pipe(res);

  req.on('close', () => {
    ffmpeg.kill('SIGKILL');
    if (activeClientFfmpegProcesses.get(clientId) === ffmpeg) {
      activeClientFfmpegProcesses.delete(clientId);
    }
  });

  ffmpeg.on('close', () => {
    if (activeClientFfmpegProcesses.get(clientId) === ffmpeg) {
      activeClientFfmpegProcesses.delete(clientId);
    }
  });
});

// --- STREAMING HLS ADAPTATIF (.M3U8 / HLS.JS & SAFARI / IOS / TV) ---
router.get('/api/hls/:playId/index.m3u8', async (req, res) => {
  const { playId } = req.params;
  const { magnet } = req.query;
  const clientId = resolveClientId(req);

  if (!magnet) return res.status(400).send("Lien magnet manquant");
  // playId sert de nom de dossier : refuser tout ce qui pourrait sortir du cache HLS ("..%2F..")
  if (!isValidPlayId(playId)) return res.status(400).send("playId invalide");

  const {
    fileIndex: parsedFileIndex,
    audioIndex,
    seekSeconds,
    audioOffset: parsedAudioOffset
  } = parsePlaybackParams(req.query);
  const sessionDir = path.join(HLS_CACHE_DIR, playId);
  const m3u8Path = path.join(sessionDir, 'index.m3u8');

  // Si la session HLS existe déjà, servir directement la playlist
  // (hls.js recharge la playlist en boucle : la synchro déjà calculée ne doit pas être écrasée)
  if (activeHlsSessions.has(playId) && fs.existsSync(m3u8Path)) {
    activeHlsSessions.get(playId).lastAccess = Date.now();
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return fs.createReadStream(m3u8Path).pipe(res);
  }

  // Interrompre toute ancienne session HLS du même client
  stopClientHlsSession(clientId);
  killClientFfmpegProcess(clientId);
  if (refuseStreamStart(req, res, clientId, playId)) return;

  const torrUrl = mediaInputUrl(magnet, parsedFileIndex);
  const streamInfo = await getStreamInfo(magnet, parsedFileIndex).catch(() => null);

  // Vérification juste avant le lancement (aucun `await` entre les deux)
  if (countActiveStreams() >= MAX_CONCURRENT_STREAMS) {
    console.warn(`⛔ Limite de ${MAX_CONCURRENT_STREAMS} flux simultanés atteinte, session HLS refusée (client ${clientId})`);
    return res.status(503).send(`Trop de lectures en cours (max ${MAX_CONCURRENT_STREAMS}). Réessayez dans un instant.`);
  }

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  // Synchronisation de la session pour /api/play-sync
  let playSession = activePlaySessions.get(playId);
  if (!playSession) {
    playSession = { createdAt: Date.now(), waiters: [] };
    activePlaySessions.set(playId, playSession);
  }
  playSession.seekSeconds = seekSeconds;
  playSession.keyframeOffset = 0;

  const videoIsCopied = isH264DirectCopy(streamInfo);
  if (videoIsCopied && seekSeconds > 0) {
    // Vidéo copiée : le flux démarre sur l'image clé PRÉCÉDENT le seek, pas sur le seek lui-même.
    // (En réencodage, FFmpeg coupe exactement au temps demandé : aucun décalage.)
    playSession.resolved = false;
    probeKeyframeStart(torrUrl, seekSeconds).then((actualStart) => {
      const start = actualStart ?? seekSeconds;
      if (actualStart !== null) {
        console.log(`🎯 Keyframe HLS détecté (${playId}) : demandé = ${seekSeconds}s -> effectif = ${start}s`);
      }
      playSession.keyframeOffset = Math.round((start - seekSeconds) * 1000) / 1000;
      playSession.actualStart = start;
      playSession.resolved = true;
      while (playSession.waiters.length > 0) playSession.waiters.shift()();
    });
  } else {
    releasePlaySession(playSession, seekSeconds);
  }

  const detectedHwAccel = getDetectedHwAccel();
  const hlsModeLabel = videoIsCopied
    ? 'Direct Remuxing, 0% CPU'
    : `Transcodage ${['vaapi', 'nvenc'].includes(detectedHwAccel) ? detectedHwAccel.toUpperCase() : 'CPU'}`;
  console.log(`📡 Lancement HLS ${hlsModeLabel} (playId: ${playId}, seek: ${seekSeconds}s)`);

  const hlsArgs = buildHlsArgs({
    torrUrl,
    seekSeconds,
    audioIndex,
    audioOffset: parsedAudioOffset,
    streamInfo,
    hwAccel: detectedHwAccel,
    vaapiDevice: VAAPI_DEVICE,
    segmentPattern: path.join(sessionDir, 'seg_%05d.ts'),
    m3u8Path
  });

  const ffmpeg = spawn('ffmpeg', hlsArgs);
  // Indispensable : sans lecture du stderr, FFmpeg se fige après ~100 segments (voir drainFfmpegStderr)
  drainFfmpegStderr(ffmpeg, `FFmpeg HLS ${playId}`);

  const hlsSession = {
    playId,
    clientId,
    hash: getTorrentHash(magnet),
    fileIndex: parsedFileIndex,
    seekSeconds,
    dir: sessionDir,
    m3u8Path,
    ffmpegProcess: ffmpeg,
    createdAt: Date.now(),
    lastAccess: Date.now(),
    meta: buildStreamMeta(req, {
      clientId, playId, mode: videoIsCopied ? 'hls-copy' : `hls-transcode-${detectedHwAccel}`,
      magnet, fileIndex: parsedFileIndex, local: torrUrl.startsWith('file:')
    })
  };

  activeHlsSessions.set(playId, hlsSession);

  if (!clientActiveHlsMap.has(clientId)) {
    clientActiveHlsMap.set(clientId, new Set());
  }
  clientActiveHlsMap.get(clientId).add(playId);

  ffmpeg.on('close', (code) => {
    console.log(`📡 FFmpeg HLS session ${playId} s'est arrêté (code ${code})`);
  });

  // Attendre la génération du fichier .m3u8 initial avec au moins 1 segment
  const startTime = Date.now();
  const waitForM3u8 = async () => {
    while (Date.now() - startTime < 18000) {
      if (fs.existsSync(m3u8Path)) {
        try {
          const content = fs.readFileSync(m3u8Path, 'utf8');
          if (content.includes('#EXTINF:') || content.includes('.ts')) {
            return true;
          }
        } catch (e) {}
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return false;
  };

  const isReady = await waitForM3u8();
  if (!isReady || !fs.existsSync(m3u8Path)) {
    cleanupHlsSession(playId);
    return res.status(504).send("Délai d'attente dépassé pour la génération des segments HLS.");
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(m3u8Path).pipe(res);
});

router.get('/api/hls/:playId/:segment', (req, res) => {
  const { playId, segment } = req.params;
  const session = activeHlsSessions.get(playId);
  if (!session) {
    return res.status(404).send("Session HLS expirée ou inconnue.");
  }

  session.lastAccess = Date.now();
  const cleanSegment = path.basename(segment);
  const segmentPath = path.join(session.dir, cleanSegment);

  if (!fs.existsSync(segmentPath)) {
    return res.status(404).send("Segment non trouvé.");
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Access-Control-Allow-Origin', '*');
  fs.createReadStream(segmentPath).pipe(res);
});

router.post('/api/hls/stop', (req, res) => {
  const clientId = resolveClientId(req);
  const { playId } = req.body || {};

  if (playId) {
    cleanupHlsSession(playId);
  } else if (clientId) {
    stopClientHlsSession(clientId);
  }

  res.json({ success: true });
});

// --- ROUTE API MINIATURES POUR LA TIMELINE (VISUAL SCRUBBING) ---
router.get('/api/thumbnail', async (req, res) => {
  const { magnet } = req.query;
  const clientId = resolveClientId(req);

  if (!magnet) return res.status(400).send("Lien magnet manquant");

  try {
    const thumbPath = await generateThumbnail({
      magnet,
      fileIndex: parseFileIndex(req.query.fileIndex),
      timestamp: parseSeekSeconds(req.query.t),
      clientId: `thumb_${clientId}`
    });

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    res.status(500).send("Erreur génération miniature: " + err.message);
  }
});

// --- ROUTE API TÉLÉCHARGEMENT LOCAL D'ÉPISODE (MODE HORS-LIGNE) ---
router.get('/api/download', async (req, res) => {
  const { magnet, title } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");

  const parsedFileIndex = parseFileIndex(req.query.fileIndex);

  // Épisode gardé sur le serveur : envoi direct du fichier local (rapide, sans seeders ni TorrServer)
  const downloads = getDownloadManager();
  const localFile = downloads?.localPath(magnet, parsedFileIndex);
  if (localFile) {
    const item = downloads.get(path.basename(localFile, path.extname(localFile)));
    let name = item?.fileName || title || 'video';
    if (!path.extname(name)) name += path.extname(localFile);
    return res.download(localFile, name, (err) => {
      if (err && !res.headersSent) res.status(500).send("Fichier local illisible");
    });
  }

  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=${parsedFileIndex}&play`;

  let fileName = title || 'video';
  try {
    const filesInfo = await getTorrentFiles(magnet);
    const targetFile = filesInfo.files.find(f => f.id === parsedFileIndex);
    if (targetFile && targetFile.name) {
      fileName = targetFile.name;
    }
  } catch (e) {}

  if (!path.extname(fileName)) {
    fileName += '.mkv';
  }

  const ext = path.extname(fileName).toLowerCase();
  const contentType = (ext === '.mp4') ? 'video/mp4' : ((ext === '.webm') ? 'video/webm' : 'video/x-matroska');
  const asciiFallback = fileName.replace(/[^\w\.\-\(\)]/g, '_');

  const headers = {};
  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  try {
    const upstream = await axios({
      method: 'get',
      url: torrUrl,
      headers,
      responseType: 'stream',
      timeout: 20000
    });

    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    if (upstream.headers['content-range']) {
      res.setHeader('Content-Range', upstream.headers['content-range']);
    }
    res.setHeader('Accept-Ranges', 'bytes');

    upstream.data.pipe(res);
    req.on('close', () => {
      try {
        upstream.data.destroy();
      } catch (e) {}
    });
  } catch (err) {
    console.error("⚠️ Erreur téléchargement hors-ligne:", err.message);
    if (!res.headersSent) {
      res.status(502).send("Impossible de récupérer le fichier vidéo depuis TorrServer");
    }
  }
});

export default router;
