import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { TORRSERVER_LOCAL_URL, HLS_CACHE_DIR, VAAPI_DEVICE } from '../config/constants.js';
import { getTorrentHash } from '../utils/network.js';
import {
  resolveClientId,
  activeClientFfmpegProcesses,
  activePlaySessions,
  activeHlsSessions,
  clientActiveHlsMap,
  cleanupHlsSession,
  stopClientHlsSession,
  killClientFfmpegProcess
} from '../utils/sessionManager.js';
import {
  getStreamInfo,
  generateThumbnail,
  getDetectedHwAccel
} from '../services/ffmpegService.js';
import { streamSubtitlesLive } from '../services/subtitlesService.js';
import { getTorrentFiles } from '../services/torrserverService.js';

const router = Router();

// --- ROUTE API INFO FLUX (AUDIO & SOUS-TITRES) ---
router.get('/api/streams', async (req, res) => {
  const { magnet, fileIndex = 1 } = req.query;
  if (!magnet) return res.status(400).json({ error: "Lien magnet manquant" });
  try {
    const info = await getStreamInfo(magnet, fileIndex);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ROUTE API STREAMING SOUS-TITRES (ASS NATIF OU WEBVTT) ---
router.get('/api/subtitles', (req, res) => {
  const { magnet, fileIndex = 1, subIndex = 0, format = 'ass' } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");
  return streamSubtitlesLive({ magnet, fileIndex, subIndex, format, req, res }).catch((err) => {
    console.error("Erreur sous-titres:", err.message);
    if (!res.headersSent) res.status(500).send("Erreur extraction sous-titres");
    else res.end();
  });
});

// --- ROUTE API SYNCHRONISATION PRÉCISE DU LECTEUR ET DES SOUS-TITRES ---
router.get('/api/play-sync', async (req, res) => {
  const { playId, expectedSeek } = req.query;
  if (!playId) return res.status(400).json({ error: "playId manquant" });

  const parsedExpectedSeek = parseFloat(expectedSeek) || 0;

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
  const { magnet, mode, type, fileIndex = 1, audioIndex, ss, playId, audioOffset } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");

  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=${parsedFileIndex}&play`;
  const seekSeconds = parseFloat(ss) || 0;
  const parsedAudioOffset = parseFloat(audioOffset) || 0;

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

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'none');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // MODE 1 : LECTURE DIRECTE (0% CPU, STREAM ULTRA-RAPIDE SANS RÉENCODAGE VIDÉO)
  if (mode === 'direct') {
    const streamInfo = await getStreamInfo(magnet, parsedFileIndex).catch(() => null);
    console.log(`⚡ Lancement FFmpeg en Mode Direct (Fichier index: ${parsedFileIndex}, Seek: ${seekSeconds}s, Audio: ${audioIndex ?? 'auto'}, Offset: ${parsedAudioOffset}s, playId: ${playId ?? 'none'})`);
    const directArgs = ['-threads', '0'];

    if (seekSeconds > 0) {
      directArgs.push('-noaccurate_seek', '-ss', `${seekSeconds}`);
    }

    directArgs.push(
      '-i', torrUrl,
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-bsf:v', 'showinfo'
    );

    let chosenAudioTrack = null;
    if (audioIndex !== undefined && audioIndex !== null && audioIndex !== '') {
      const idx = parseInt(audioIndex, 10);
      directArgs.push('-map', `0:a:${idx}`);
      chosenAudioTrack = (streamInfo?.audioTracks || []).find(a => a.index === idx);
    } else {
      directArgs.push('-map', '0:a:0?');
      chosenAudioTrack = (streamInfo?.audioTracks || [])[0];
    }

    if (parsedAudioOffset !== 0) {
      directArgs.push('-itsoffset', `${parsedAudioOffset}`);
    }

    const needsAacConversion = !chosenAudioTrack || (chosenAudioTrack.codec !== 'aac' && chosenAudioTrack.codec !== 'mp3');
    if (needsAacConversion) {
      directArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    } else {
      directArgs.push('-c:a', 'copy');
    }

    directArgs.push(
      '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );

    const ffmpeg = spawn('ffmpeg', directArgs);
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
  const streamInfo = await getStreamInfo(magnet, parsedFileIndex).catch(() => null);
  const transcodeArgs = [];

  if (seekSeconds > 0) {
    transcodeArgs.push('-noaccurate_seek', '-ss', `${seekSeconds}`);
  }

  if (detectedHwAccel === 'vaapi') {
    transcodeArgs.push(
      '-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`,
      '-filter_hw_device', 'va',
      '-i', torrUrl,
      '-map', '0:v:0'
    );

    if (audioIndex !== undefined && audioIndex !== null && audioIndex !== '') {
      transcodeArgs.push('-map', `0:a:${audioIndex}`);
    } else {
      transcodeArgs.push('-map', '0:a:0?');
    }

    if (parsedAudioOffset !== 0) {
      transcodeArgs.push('-itsoffset', `${parsedAudioOffset}`);
    }

    const is10BitOrHevc = (streamInfo?.videoPixFmt && streamInfo.videoPixFmt.includes('10')) ||
                          (streamInfo?.videoCodec && (streamInfo.videoCodec.includes('hevc') || streamInfo.videoCodec.includes('h265')));

    if (is10BitOrHevc) {
      transcodeArgs.push('-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi');
    } else {
      transcodeArgs.push('-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi');
    }

    transcodeArgs.push(
      '-qp', '24',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );
  } else if (detectedHwAccel === 'nvenc') {
    transcodeArgs.push(
      '-i', torrUrl,
      '-map', '0:v:0'
    );
    if (audioIndex !== undefined && audioIndex !== null && audioIndex !== '') {
      transcodeArgs.push('-map', `0:a:${audioIndex}`);
    } else {
      transcodeArgs.push('-map', '0:a:0?');
    }
    if (parsedAudioOffset !== 0) {
      transcodeArgs.push('-itsoffset', `${parsedAudioOffset}`);
    }
    transcodeArgs.push(
      '-c:v', 'h264_nvenc',
      '-preset', 'p1',
      '-tune', 'ull',
      '-rc', 'constqp',
      '-qp', '26',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );
  } else {
    transcodeArgs.push(
      '-threads', '0',
      '-i', torrUrl,
      '-map', '0:v:0'
    );
    if (audioIndex !== undefined && audioIndex !== null && audioIndex !== '') {
      transcodeArgs.push('-map', `0:a:${audioIndex}`);
    } else {
      transcodeArgs.push('-map', '0:a:0?');
    }
    if (parsedAudioOffset !== 0) {
      transcodeArgs.push('-itsoffset', `${parsedAudioOffset}`);
    }
    transcodeArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '25',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ac', '2',
      '-sn',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    );
  }

  const ffmpeg = spawn('ffmpeg', transcodeArgs);
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
  const { magnet, fileIndex = 1, audioIndex, ss, audioOffset } = req.query;
  const clientId = resolveClientId(req);

  if (!magnet) return res.status(400).send("Lien magnet manquant");

  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const seekSeconds = parseFloat(ss) || 0;
  const parsedAudioOffset = parseFloat(audioOffset) || 0;
  const sessionDir = path.join(HLS_CACHE_DIR, playId);
  const m3u8Path = path.join(sessionDir, 'index.m3u8');

  // Synchronisation de la session pour /api/play-sync
  let playSession = activePlaySessions.get(playId);
  if (!playSession) {
    playSession = {
      seekSeconds,
      actualStart: seekSeconds,
      keyframeOffset: 0,
      resolved: true,
      createdAt: Date.now(),
      waiters: []
    };
    activePlaySessions.set(playId, playSession);
  } else {
    playSession.seekSeconds = seekSeconds;
    playSession.actualStart = seekSeconds;
    playSession.keyframeOffset = 0;
    playSession.resolved = true;
    while (playSession.waiters && playSession.waiters.length > 0) {
      const resolve = playSession.waiters.shift();
      resolve();
    }
  }

  // Si la session HLS existe déjà, servir directement la playlist
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

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=${parsedFileIndex}&play`;
  const streamInfo = await getStreamInfo(magnet, parsedFileIndex).catch(() => null);

  const isH264DirectCopy = streamInfo &&
    streamInfo.videoCodec === 'h264' &&
    (!streamInfo.videoPixFmt || streamInfo.videoPixFmt === 'yuv420p');

  let chosenAudioTrack = null;
  if (audioIndex !== undefined && audioIndex !== null && audioIndex !== '') {
    const idx = parseInt(audioIndex, 10);
    chosenAudioTrack = (streamInfo?.audioTracks || []).find(a => a.index === idx);
  } else {
    chosenAudioTrack = (streamInfo?.audioTracks || [])[0];
  }
  const needsAac = !chosenAudioTrack || (chosenAudioTrack.codec !== 'aac' && chosenAudioTrack.codec !== 'mp3');

  const hlsArgs = ['-threads', '0'];

  if (seekSeconds > 0) {
    hlsArgs.push('-noaccurate_seek', '-ss', `${seekSeconds}`);
  }

  const detectedHwAccel = getDetectedHwAccel();

  if (isH264DirectCopy) {
    console.log(`📡 Lancement HLS Direct Remuxing (0% CPU, playId: ${playId}, seek: ${seekSeconds}s)`);
    hlsArgs.push(
      '-i', torrUrl,
      '-map', '0:v:0',
      '-c:v', 'copy',
      '-bsf:v', 'h264_mp4toannexb'
    );
  } else if (detectedHwAccel === 'vaapi') {
    console.log(`📡 Lancement HLS Transcodage VAAPI (playId: ${playId}, seek: ${seekSeconds}s)`);
    hlsArgs.push(
      '-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`,
      '-filter_hw_device', 'va',
      '-i', torrUrl,
      '-map', '0:v:0',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi',
      '-qp', '24'
    );
  } else if (detectedHwAccel === 'nvenc') {
    console.log(`📡 Lancement HLS Transcodage NVENC (playId: ${playId}, seek: ${seekSeconds}s)`);
    hlsArgs.push(
      '-i', torrUrl,
      '-map', '0:v:0',
      '-c:v', 'h264_nvenc',
      '-preset', 'p2',
      '-tune', 'll',
      '-cq', '26'
    );
  } else {
    console.log(`📡 Lancement HLS Transcodage CPU (playId: ${playId}, seek: ${seekSeconds}s)`);
    hlsArgs.push(
      '-i', torrUrl,
      '-map', '0:v:0',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '24',
      '-pix_fmt', 'yuv420p'
    );
  }

  if (audioIndex !== undefined && audioIndex !== null && audioIndex !== '') {
    hlsArgs.push('-map', `0:a:${audioIndex}`);
  } else {
    hlsArgs.push('-map', '0:a:0?');
  }

  if (parsedAudioOffset !== 0) {
    hlsArgs.push('-itsoffset', `${parsedAudioOffset}`);
  }

  if (needsAac) {
    hlsArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  } else {
    hlsArgs.push('-c:a', 'copy');
  }

  hlsArgs.push(
    '-sn',
    '-f', 'hls',
    '-hls_time', '3',
    '-hls_init_time', '2',
    '-hls_list_size', '0',
    '-hls_playlist_type', 'event',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(sessionDir, 'seg_%05d.ts'),
    m3u8Path
  );

  const ffmpeg = spawn('ffmpeg', hlsArgs);

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
    lastAccess: Date.now()
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
  const { magnet, fileIndex = 1, t = 0 } = req.query;
  const clientId = resolveClientId(req);

  if (!magnet) return res.status(400).send("Lien magnet manquant");

  try {
    const thumbPath = await generateThumbnail({
      magnet,
      fileIndex,
      timestamp: t,
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
  const { magnet, fileIndex = 1, title } = req.query;
  if (!magnet) return res.status(400).send("Lien magnet manquant");

  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
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
