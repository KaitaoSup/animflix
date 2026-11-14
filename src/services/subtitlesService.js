import { Transform } from 'stream';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { SUB_CACHE_DIR } from '../config/constants.js';
import { getTorrentHash } from '../utils/network.js';
import { getCachedStreamInfo } from './ffmpegService.js';
import { touchCacheFile } from '../utils/diskCacheCleaner.js';
import { mediaInputUrl } from './downloadService.js';
import { logServerError } from './errorLog.js';

/**
 * Retire les segments en mode dessin vectoriel ({\p1} m 0 0 l 10 0 ... jusqu'à {\p0}) :
 * ce sont les masques des panneaux, illisibles une fois convertis en texte WebVTT.
 */
export function stripAssDrawings(rawText) {
  if (!/\\p[1-9]/.test(rawText)) return rawText;
  let drawing = false;
  let out = '';
  for (const part of rawText.split(/(\{[^}]*\})/)) {
    if (part.startsWith('{') && part.endsWith('}')) {
      const modes = part.match(/\\p(\d+)/g);
      if (modes) drawing = parseInt(modes[modes.length - 1].slice(2), 10) > 0;
      out += part;
    } else if (!drawing) {
      out += part;
    }
  }
  return out;
}

/**
 * Transformateur de sous-titres ASS / SSA vers WebVTT positionné
 */
export class AssToVttStream extends Transform {
  constructor(options) {
    super(options);
    this.buffer = '';
    this.headerSent = false;
    this.isAlreadyVtt = false;
    this.styles = new Map();
    this.styleFormatIndices = null;
    this.playResY = 1080;
  }

  _transform(chunk, encoding, callback) {
    if (this.isAlreadyVtt) {
      this.push(chunk);
      return callback();
    }

    this.buffer += chunk.toString('utf8');
    if (!this.headerSent && this.buffer.startsWith('WEBVTT')) {
      this.isAlreadyVtt = true;
      this.push(this.buffer);
      this.buffer = '';
      return callback();
    }

    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop(); // Conserver la ligne incomplète

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (!this.headerSent) {
        this.push('WEBVTT\n\n');
        this.headerSent = true;
      }

      const lower = line.toLowerCase();
      if (lower.startsWith('playresy:')) {
        const val = parseInt(line.split(':')[1].trim(), 10);
        if (!isNaN(val) && val > 0) this.playResY = val;
      } else if (lower.startsWith('format:')) {
        const fields = line.substring(7).split(',').map(f => f.trim().toLowerCase());
        if (fields.includes('fontname') && fields.includes('alignment')) {
          this.styleFormatIndices = fields;
        }
      } else if (lower.startsWith('style:')) {
        const parts = line.substring(6).split(',').map(p => p.trim());
        if (this.styleFormatIndices && parts.length >= this.styleFormatIndices.length) {
          const nameIdx = this.styleFormatIndices.indexOf('name');
          const alignIdx = this.styleFormatIndices.indexOf('alignment');
          if (nameIdx !== -1 && alignIdx !== -1) {
            this.styles.set(parts[nameIdx].toLowerCase(), parseInt(parts[alignIdx], 10) || 2);
          }
        }
      } else if (/^dialogue\s*:/i.test(line)) {
        const cue = this.parseDialogue(line);
        if (cue) {
          this.push(cue);
        }
      }
    }
    callback();
  }

  _flush(callback) {
    if (this.isAlreadyVtt) {
      if (this.buffer) this.push(this.buffer);
      return callback();
    }
    if (!this.headerSent) {
      this.push('WEBVTT\n\n');
    }
    if (this.buffer && /^dialogue\s*:/i.test(this.buffer.trim())) {
      const cue = this.parseDialogue(this.buffer.trim());
      if (cue) this.push(cue);
    }
    callback();
  }

  parseDialogue(line) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return null;
    const rest = line.substring(colonIdx + 1).trim();

    const fields = [];
    let currentStart = 0;
    for (let i = 0; i < 9; i++) {
      const nextComma = rest.indexOf(',', currentStart);
      if (nextComma === -1) return null;
      fields.push(rest.substring(currentStart, nextComma).trim());
      currentStart = nextComma + 1;
    }
    fields.push(rest.substring(currentStart));

    const startRaw = fields[1]?.trim();
    const endRaw = fields[2]?.trim();
    const styleName = fields[3]?.trim() || '';
    const rawText = fields[9] || '';

    if (!startRaw || !endRaw || !rawText) return null;

    const vttStart = this.formatTimestamp(startRaw);
    const vttEnd = this.formatTimestamp(endRaw);

    let isTop = false;

    // 1. Détection via Style ASS (ex: Sign, Top, Alignment 7, 8, 9)
    const styleAlign = this.styles.get(styleName.toLowerCase());
    if (styleAlign === 7 || styleAlign === 8 || styleAlign === 9) {
      isTop = true;
    } else if (/sign|top|title|osd|pancarte|trad/i.test(styleName)) {
      isTop = true;
    }

    // 2. Détection via Tags in-line ASS ({\an8}, \pos...)
    if (/(?:\\an[789]|\\a[567])\b/.test(rawText)) {
      isTop = true;
    }
    const posMatch = rawText.match(/\\pos\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/);
    if (posMatch) {
      const y = parseFloat(posMatch[2]);
      if (!isNaN(y) && y < this.playResY * 0.45) {
        isTop = true;
      }
    }

    // 3. Détection heuristique dans le texte (ex: [Panneau : ...])
    const plain = rawText.replace(/\{[^\}]*\}/g, '').trim();
    if (!isTop && /^(\[|\()(panneau|texte|titre|pancarte|enseigne|écrit|lettre|message|avis|sign|text|title|screen)\b/i.test(plain)) {
      isTop = true;
    }

    let text = stripAssDrawings(rawText)
      .replace(/\{[^\}]*\}/g, '')
      .replace(/\\N/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();

    if (!text) return null;

    const settings = isTop ? 'line:8% align:center' : 'line:85% align:center';
    return `${vttStart} --> ${vttEnd} ${settings}\n${text}\n\n`;
  }

  formatTimestamp(assTime) {
    const parts = assTime.trim().split(':');
    if (parts.length === 3) {
      const h = parts[0].padStart(2, '0');
      const m = parts[1].padStart(2, '0');
      const sParts = parts[2].split('.');
      const s = sParts[0].padStart(2, '0');
      const ms = (sParts[1] || '00').padEnd(3, '0').slice(0, 3);
      return `${h}:${m}:${s}.${ms}`;
    } else if (parts.length === 2) {
      const m = parts[0].padStart(2, '0');
      const sParts = parts[1].split('.');
      const s = sParts[0].padStart(2, '0');
      const ms = (sParts[1] || '00').padEnd(3, '0').slice(0, 3);
      return `00:${m}:${s}.${ms}`;
    }
    return assTime;
  }
}

/**
 * Stream et met en cache les sous-titres (ASS natif haute qualité ou WebVTT)
 */
export async function streamSubtitlesLive({ magnet, fileIndex = 1, subIndex = 0, format = 'ass', req, res }) {
  const hash = getTorrentHash(magnet);
  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const parsedSubIndex = parseInt(subIndex, 10) || 0;
  const isAss = format === 'ass';
  const cacheKey = `${hash}_f${parsedFileIndex}_s${parsedSubIndex}`;
  const assFile = path.join(SUB_CACHE_DIR, `${cacheKey}.ass`);
  const vttFile = path.join(SUB_CACHE_DIR, `${cacheKey}.vtt`);

  // 1. Si format ASS demandé et déjà en cache (.ass)
  if (isAss && fs.existsSync(assFile)) {
    touchCacheFile(assFile);
    res.setHeader('Content-Type', 'text/x-ssa; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    return fs.createReadStream(assFile).pipe(res);
  }

  // 2. Si format VTT demandé et déjà en cache (.vtt)
  if (!isAss && fs.existsSync(vttFile)) {
    touchCacheFile(vttFile);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    return fs.createReadStream(vttFile).pipe(res);
  }

  // 3. Si format VTT demandé et .ass existe en cache : conversion instantanée sans FFmpeg
  if (!isAss && fs.existsSync(assFile)) {
    touchCacheFile(assFile);
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    const vttStream = new AssToVttStream();
    const assRead = fs.createReadStream(assFile);
    assRead.pipe(vttStream);
    return vttStream.pipe(res);
  }

  // 4. Sinon, extraction en temps réel avec FFmpeg (partagée entre clients pour une même piste)
  const contentType = isAss ? 'text/x-ssa; charset=utf-8' : 'text/vtt; charset=utf-8';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  let extraction = activeSubExtractions.get(cacheKey);
  if (!extraction) {
    extraction = await startSubExtraction({ magnet, parsedFileIndex, parsedSubIndex, cacheKey, assFile });
  }
  attachClientToExtraction(extraction, { isAss, req, res });
}

/**
 * Vrai si FFmpeg s'est arrêté nettement avant la fin du fichier (durée connue par ffprobe).
 * Durée inconnue : on ne peut pas juger, on fait confiance au code de sortie.
 */
export function isTruncatedRead(readSeconds, durationSeconds) {
  if (!(durationSeconds > 0)) return false;
  return readSeconds < durationSeconds - Math.max(20, durationSeconds * 0.02);
}

// --- EXTRACTIONS FFMPEG EN COURS (une seule par piste, partagée entre clients) ---
const activeSubExtractions = new Map(); // key: cacheKey -> extraction
const SUB_EXTRACTION_IDLE_TIMEOUT_MS = 120000;

async function startSubExtraction({ magnet, parsedFileIndex, parsedSubIndex, cacheKey, assFile }) {
  // Réserver la clé immédiatement (une seule extraction FFmpeg par piste)
  const extraction = { chunks: [], clients: new Set(), done: false };
  activeSubExtractions.set(cacheKey, extraction);

  const uniqueId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const tmpAssFile = path.join(SUB_CACHE_DIR, `${cacheKey}.${uniqueId}.ass.tmp`);
  const torrUrl = mediaInputUrl(magnet, parsedFileIndex);

  const ffmpegArgs = [
    '-v', 'error',
    '-nostats',
    '-progress', 'pipe:2',
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-fflags', '+nobuffer',
    '-i', torrUrl,
    '-vn', '-an',
    '-map', `0:s:${parsedSubIndex}`,
    '-flush_packets', '1'
  ];

  // Copie directe uniquement si la piste exacte est identifiée comme ASS/SSA
  // (cache seulement : ne jamais retarder l'extraction en attendant une analyse ffprobe)
  const streamInfo = getCachedStreamInfo(magnet, parsedFileIndex);
  const targetSub = (streamInfo?.subTracks || []).find(t => t.index === parsedSubIndex);
  if (targetSub?.codec === 'ass' || targetSub?.codec === 'ssa') {
    ffmpegArgs.push('-c:s', 'copy');
  }
  ffmpegArgs.push('-f', 'ass', 'pipe:1');
  // Sortie témoin (copie vers null, coût négligeable) : sa progression suit la lecture du fichier jusqu'au bout,
  // ce qui permet de détecter un flux coupé en route (FFmpeg sort alors en code 0 avec des sous-titres tronqués)
  ffmpegArgs.push('-map', '0:a:0?', '-map', '0:v:0?', '-c', 'copy', '-f', 'null', '-');

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  const assFileOut = fs.createWriteStream(tmpAssFile);
  assFileOut.on('error', () => {});

  let ffmpegClosed = false;
  let fileOutFinished = false;
  let successCode = false;

  function finish() {
    if (extraction.done) return;
    extraction.done = true;
    if (activeSubExtractions.get(cacheKey) === extraction) {
      activeSubExtractions.delete(cacheKey);
    }
    for (const client of extraction.clients) client.end();
    extraction.clients.clear();
  }

  function tryPromoteCache() {
    if (ffmpegClosed && fileOutFinished && successCode && fs.existsSync(tmpAssFile)) {
      try {
        if (!fs.existsSync(assFile)) fs.renameSync(tmpAssFile, assFile);
        else fs.unlinkSync(tmpAssFile);
      } catch (e) {}
    }
  }

  // Délai d'inactivité : FFmpeg n'est tué que si la lecture du torrent n'avance plus (pas de durée totale fixe)
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.warn(`⚠️ Extraction sous-titres bloquée (${cacheKey}), arrêt de FFmpeg`);
      try { ffmpeg.kill('SIGKILL'); } catch (e) {}
    }, SUB_EXTRACTION_IDLE_TIMEOUT_MS);
  };
  resetIdle();

  let readSeconds = 0;
  let stderrTail = '';
  ffmpeg.stderr.on('data', (chunk) => {
    resetIdle();
    stderrTail += chunk.toString();
    const lines = stderrTail.split('\n');
    stderrTail = lines.pop();
    for (const line of lines) {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m) readSeconds = Math.max(readSeconds, Number(m[1]) / 1e6);
    }
  });
  ffmpeg.stdout.on('data', (chunk) => {
    resetIdle();
    extraction.chunks.push(chunk);
    assFileOut.write(chunk);
    for (const client of extraction.clients) client.write(chunk);
  });

  assFileOut.on('finish', () => {
    fileOutFinished = true;
    tryPromoteCache();
  });

  ffmpeg.on('error', (err) => {
    console.error(`❌ FFmpeg sous-titres introuvable ou en erreur : ${err.message}`);
    logServerError('ffmpeg', `Extraction des sous-titres : ${err.message}`);
  });

  ffmpeg.on('close', (code) => {
    clearTimeout(idleTimer);
    ffmpegClosed = true;
    successCode = code === 0;
    if (successCode && isTruncatedRead(readSeconds, getCachedStreamInfo(magnet, parsedFileIndex)?.duration)) {
      successCode = false;
      const msg = `Extraction des sous-titres incomplète (${cacheKey}) : flux lu jusqu'à ${Math.round(readSeconds)} s, non mis en cache`;
      console.warn(`⚠️ ${msg}`);
      logServerError('ffmpeg', msg);
    }
    assFileOut.end();
    if (!successCode) {
      assFileOut.on('close', () => {
        try { if (fs.existsSync(tmpAssFile)) fs.unlinkSync(tmpAssFile); } catch (e) {}
      });
    }
    finish();
  });

  return extraction;
}

function attachClientToExtraction(extraction, { isAss, req, res }) {
  // Chaque client reçoit ce qui a déjà été extrait, puis le flux en direct.
  // Les écritures ne dépendent jamais de la réponse HTTP : une déconnexion ne bloque pas l'extraction.
  let sink;
  if (isAss) {
    sink = {
      write: (chunk) => { if (!res.writableEnded && !res.destroyed) res.write(chunk); },
      end: () => { if (!res.writableEnded && !res.destroyed) res.end(); }
    };
  } else {
    const vttTransform = new AssToVttStream();
    vttTransform.on('error', () => {});
    vttTransform.on('data', (data) => { if (!res.writableEnded && !res.destroyed) res.write(data); });
    vttTransform.on('end', () => { if (!res.writableEnded && !res.destroyed) res.end(); });
    sink = {
      write: (chunk) => vttTransform.write(chunk),
      end: () => vttTransform.end()
    };
  }

  for (const chunk of extraction.chunks) sink.write(chunk);
  if (extraction.done) {
    sink.end();
    return;
  }
  extraction.clients.add(sink);
  req.on('close', () => extraction.clients.delete(sink));
}

