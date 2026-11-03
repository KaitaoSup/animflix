import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { VAAPI_DEVICE, FFMPEG_HWACCEL_PREF, TORRSERVER_LOCAL_URL, THUMB_CACHE_DIR, HLS_CACHE_DIR } from '../config/constants.js';
import { touchCacheFile } from '../utils/diskCacheCleaner.js';
import { streamsCache } from '../utils/cache.js';
import { getTorrentHash } from '../utils/network.js';
import {
  activeClientThumbProcesses,
  activeHlsSessions,
  clientActiveHlsMap,
  cleanupHlsSession
} from '../utils/sessionManager.js';

const execFilePromise = promisify(execFile);

let detectedHwAccel = 'cpu'; // 'vaapi' | 'nvenc' | 'cpu'

export function getDetectedHwAccel() {
  return detectedHwAccel;
}

export function getVaapiDevice() {
  return detectedHwAccel === 'vaapi' ? VAAPI_DEVICE : null;
}

/**
 * Détection et configuration dynamique de l'accélération matérielle
 */
export async function checkHardwareAcceleration() {
  if (FFMPEG_HWACCEL_PREF === 'cpu' || FFMPEG_HWACCEL_PREF === 'none' || FFMPEG_HWACCEL_PREF === 'false') {
    detectedHwAccel = 'cpu';
    console.log('⚙️ Transcodage FFmpeg configuré en mode CPU logiciel (libx264).');
    return;
  }

  // 1. Tester VAAPI sous Linux si le device DRI existe
  if ((FFMPEG_HWACCEL_PREF === 'auto' || FFMPEG_HWACCEL_PREF === 'vaapi') && fs.existsSync(VAAPI_DEVICE)) {
    try {
      await execFilePromise('ffmpeg', [
        '-init_hw_device', `vaapi=va:${VAAPI_DEVICE}`,
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
        '-vf', 'format=nv12,hwupload',
        '-c:v', 'h264_vaapi',
        '-f', 'null', '-'
      ]);
      detectedHwAccel = 'vaapi';
      console.log(`🚀 Accélération matérielle active : Intel/AMD VAAPI (${VAAPI_DEVICE})`);
      return;
    } catch (e) {
      // VAAPI non disponible
    }
  }

  // 2. Tester NVENC si GPU Nvidia
  if (FFMPEG_HWACCEL_PREF === 'auto' || FFMPEG_HWACCEL_PREF === 'nvenc') {
    try {
      await execFilePromise('ffmpeg', [
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
        '-c:v', 'h264_nvenc',
        '-f', 'null', '-'
      ]);
      detectedHwAccel = 'nvenc';
      console.log('🚀 Accélération matérielle active : NVIDIA NVENC (h264_nvenc)');
      return;
    } catch (e) {
      // NVENC non disponible
    }
  }

  detectedHwAccel = 'cpu';
  console.log('ℹ️ Transcodage FFmpeg : CPU logiciel standard (libx264 ultrafast).');
}

/**
 * Analyse rapide des flux (vidéo, audio, sous-titres, durée) avec ffprobe
 */
export async function analyzeStreams(videoUrl, { timeoutMs = 15000 } = {}) {
  try {
    console.log("🔍 FFPROBE: Analyse rapide des flux et durée...");
    const ffprobeArgs = [
      '-v', 'error',
      '-probesize', '5000000',
      '-analyzeduration', '5000000',
      '-show_entries', 'stream=index,codec_type,codec_name,pix_fmt,width,height,duration:format=duration:stream_tags=language,title',
      '-of', 'json',
      videoUrl
    ];
    const { stdout } = await execFilePromise('ffprobe', ffprobeArgs, { timeout: timeoutMs });
    const data = JSON.parse(stdout);
    const streams = data.streams || [];

    let duration = null;
    if (data.format?.duration && !isNaN(parseFloat(data.format.duration))) {
      duration = Math.round(parseFloat(data.format.duration));
    }
    if (!duration) {
      for (const s of streams) {
        if (s.duration && !isNaN(parseFloat(s.duration))) {
          const d = Math.round(parseFloat(s.duration));
          if (d > 0) {
            duration = d;
            break;
          }
        }
      }
    }
    if (!duration || duration <= 0) {
      duration = 1440; // 24 minutes standard fallback
    }

    let videoCodec = 'h264';
    let videoPixFmt = 'yuv420p';
    let videoWidth = 1920;
    let videoHeight = 1080;
    let foundVideo = false;

    let subIndex = null;
    let relativeSubCount = 0;
    const subTracks = [];

    let frAudioIndex = null;
    let relativeAudioCount = 0;
    const audioTracks = [];

    for (const s of streams) {
      const lang = (s.tags?.language || '').toLowerCase();
      const title = s.tags?.title || '';

      if (s.codec_type === 'video' && !foundVideo) {
        foundVideo = true;
        videoCodec = (s.codec_name || 'h264').toLowerCase();
        videoPixFmt = (s.pix_fmt || 'yuv420p').toLowerCase();
        if (s.width) videoWidth = parseInt(s.width, 10) || 1920;
        if (s.height) videoHeight = parseInt(s.height, 10) || 1080;
      } else if (s.codec_type === 'subtitle') {
        const isFrench = (lang === 'fre' || lang === 'fra' || title.toLowerCase().includes('french') || title.toLowerCase().includes('vostfr') || title.toLowerCase().includes('français') || title.toLowerCase().includes('vf'));
        let trackLabel = title;
        if (!trackLabel) {
          trackLabel = isFrench ? 'Français (VOSTFR)' : (lang ? `Sous-titre (${lang.toUpperCase()})` : `Piste ${relativeSubCount + 1}`);
        }

        subTracks.push({
          index: relativeSubCount,
          streamIndex: s.index,
          codec: (s.codec_name || '').toLowerCase(),
          lang: lang || 'und',
          label: trackLabel,
          isFrench
        });

        if (subIndex === null && isFrench) {
          console.log(`✅ FFPROBE: Sous-titre FR trouvé (index relatif : ${relativeSubCount})`);
          subIndex = relativeSubCount;
        }
        relativeSubCount++;
      } else if (s.codec_type === 'audio') {
        const isFrench = (lang === 'fre' || lang === 'fra' || title.toLowerCase().includes('french') || title.toLowerCase().includes('vf'));
        audioTracks.push({
          index: relativeAudioCount,
          streamIndex: s.index,
          lang: lang || 'und',
          label: title || (isFrench ? 'Français (VF)' : (lang ? `Audio (${lang.toUpperCase()})` : `Audio ${relativeAudioCount + 1}`)),
          isFrench,
          codec: (s.codec_name || '').toLowerCase()
        });

        if (frAudioIndex === null && isFrench) {
          console.log(`✅ FFPROBE: Audio Français trouvé (index relatif : ${relativeAudioCount})`);
          frAudioIndex = relativeAudioCount;
        }
        relativeAudioCount++;
      }
    }

    if (subIndex === null && subTracks.length > 0) {
      console.log("ℹ️ FFPROBE: Pas de piste FR explicite, sélection du premier sous-titre.");
      subIndex = 0;
    }

    console.log(`✅ FFPROBE: Analyse terminée. Vidéo = ${videoCodec} (${videoPixFmt}), Durée = ${duration}s, Sous-titres = ${subTracks.length}, Audio = ${audioTracks.length}`);
    return { subIndex, subTracks, frAudioIndex, audioTracks, duration, videoCodec, videoPixFmt, videoWidth, videoHeight };
  } catch (e) {
    console.log("⚠️ FFPROBE: Analyse rapide streams terminée avec fallback:", e.message);
    // Analyse impossible (torrent encore lent…) : on ne connaît PAS les pistes.
    // Ne surtout pas prétendre que la piste 0 est en français : c'est souvent l'anglais.
    return {
      probeFailed: true,
      subIndex: 0,
      subTracks: [{ index: 0, lang: 'und', label: 'Piste 1 (analyse en cours…)', isFrench: false }],
      frAudioIndex: null,
      audioTracks: [],
      duration: 1440,
      videoCodec: 'h264',
      videoPixFmt: 'yuv420p',
      videoWidth: 1920,
      videoHeight: 1080
    };
  }
}

/**
 * Récupère les métadonnées de flux mises en cache
 */
export async function getStreamInfo(magnet, fileIndex = 1) {
  const hash = getTorrentHash(magnet);
  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const cacheKey = `${hash}_f${parsedFileIndex}`;
  const cached = streamsCache.get(cacheKey);
  if (cached && cached.duration) {
    return cached;
  }

  // Une seule analyse ffprobe à la fois par fichier : /api/streams, /play et les sous-titres
  // la demandent en même temps, et plusieurs ffprobe parallèles ralentissent le torrent.
  if (pendingStreamProbes.has(cacheKey)) {
    return pendingStreamProbes.get(cacheKey);
  }

  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=${parsedFileIndex}&play`;
  const probe = (async () => {
    const data = await analyzeStreams(torrUrl);
    // Un échec n'est gardé que 20s : le lecteur relance l'analyse pour obtenir la vraie liste des pistes
    streamsCache.set(cacheKey, data, data.probeFailed ? 20000 : undefined);
    return data;
  })();

  pendingStreamProbes.set(cacheKey, probe);
  try {
    return await probe;
  } finally {
    pendingStreamProbes.delete(cacheKey);
  }
}

const pendingStreamProbes = new Map(); // cacheKey -> Promise (analyse ffprobe en cours)

/**
 * Métadonnées déjà connues (cache uniquement, sans lancer ffprobe) : null si inconnues ou analyse échouée
 */
export function getCachedStreamInfo(magnet, fileIndex = 1) {
  const hash = getTorrentHash(magnet);
  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const cached = streamsCache.get(`${hash}_f${parsedFileIndex}`);
  return cached && !cached.probeFailed ? cached : null;
}

/**
 * Génère une miniature JPEG 16:9 à la volée avec mise en cache disque
 */
export async function generateThumbnail({ magnet, fileIndex = 1, timestamp = 0, clientId = 'thumb_client' }) {
  const hash = getTorrentHash(magnet);
  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const t = Math.max(0, parseFloat(timestamp) || 0);

  // Regroupement par paliers de 5 secondes pour maximiser le hit ratio
  const quantizedTime = Math.floor(t / 5) * 5;
  const thumbFileName = `${hash}_f${parsedFileIndex}_t${quantizedTime}.jpg`;
  const thumbPath = path.join(THUMB_CACHE_DIR, thumbFileName);

  if (fs.existsSync(thumbPath)) {
    touchCacheFile(thumbPath);
    return thumbPath;
  }

  // Interrompre une éventuelle extraction précédente pour ce client
  if (activeClientThumbProcesses.has(clientId)) {
    const prev = activeClientThumbProcesses.get(clientId);
    try { prev.kill('SIGKILL'); } catch (e) {}
    activeClientThumbProcesses.delete(clientId);
  }

  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=${parsedFileIndex}&play`;
  const tempPath = path.join(THUMB_CACHE_DIR, `${thumbFileName}.${Date.now().toString(36)}.tmp`);

  const ffmpegArgs = [
    '-threads', '2',
    '-noaccurate_seek',
    '-ss', `${quantizedTime}`,
    '-i', torrUrl,
    '-vframes', '1',
    '-vf', 'scale=320:-1',
    '-q:v', '4',
    '-f', 'image2',
    '-y',
    tempPath
  ];

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ffmpegArgs);
    activeClientThumbProcesses.set(clientId, proc);

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) {}
      reject(new Error("Timeout extraction miniature"));
    }, 6000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      activeClientThumbProcesses.delete(clientId);
      if (code === 0 && fs.existsSync(tempPath)) {
        try {
          fs.renameSync(tempPath, thumbPath);
          resolve(thumbPath);
        } catch (e) {
          resolve(tempPath);
        }
      } else {
        if (fs.existsSync(tempPath)) {
          try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        reject(new Error(`FFmpeg thumbnail a échoué avec le code ${code}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      activeClientThumbProcesses.delete(clientId);
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch (e) {}
      }
      reject(err);
    });
  });

  return thumbPath;
}
