import { Transform } from 'stream';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { SUB_CACHE_DIR, TORRSERVER_LOCAL_URL } from '../config/constants.js';
import { getTorrentHash } from '../utils/network.js';

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

    let text = rawText
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
 * Stream et met en cache les sous-titres WebVTT
 */
export function streamSubtitlesLive({ magnet, fileIndex = 1, subIndex = 0, req, res }) {
  const hash = getTorrentHash(magnet);
  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const parsedSubIndex = parseInt(subIndex, 10) || 0;
  const cacheKey = `${hash}_f${parsedFileIndex}_s${parsedSubIndex}`;
  const vttFile = path.join(SUB_CACHE_DIR, `${cacheKey}.vtt`);
  const uniqueId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  const tmpFile = path.join(SUB_CACHE_DIR, `${cacheKey}.${uniqueId}.tmp`);

  // 1. Si déjà entièrement extrait et mis en cache, servir instantanément (< 1ms)
  if (fs.existsSync(vttFile)) {
    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(vttFile).pipe(res);
  }

  // 2. Sinon, streamer en temps réel avec FFmpeg (extraction ASS puis conversion instantanée WebVTT)
  const torrUrl = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=${parsedFileIndex}&play`;

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const ffmpegArgs = [
    '-v', 'error',
    '-i', torrUrl,
    '-map', `0:s:${parsedSubIndex}`,
    '-flush_packets', '1',
    '-f', 'ass',
    'pipe:1'
  ];

  const ffmpeg = spawn('ffmpeg', ffmpegArgs);
  const fileOut = fs.createWriteStream(tmpFile);
  const vttTransform = new AssToVttStream();

  ffmpeg.stdout.pipe(vttTransform);
  vttTransform.pipe(res);
  vttTransform.pipe(fileOut);

  let ffmpegClosed = false;
  let fileOutFinished = false;
  let successCode = false;

  function tryPromoteCache() {
    if (ffmpegClosed && fileOutFinished && successCode) {
      if (fs.existsSync(tmpFile)) {
        try {
          if (!fs.existsSync(vttFile)) {
            fs.renameSync(tmpFile, vttFile);
          } else {
            fs.unlinkSync(tmpFile);
          }
        } catch (e) {}
      }
    }
  }

  fileOut.on('finish', () => {
    fileOutFinished = true;
    tryPromoteCache();
  });

  ffmpeg.on('close', (code) => {
    ffmpegClosed = true;
    if (code === 0) {
      successCode = true;
      tryPromoteCache();
    } else {
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
      }
    }
  });

  req.on('close', () => {
    if (!successCode) {
      ffmpeg.kill('SIGKILL');
      fileOut.end();
      if (fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
      }
    }
  });
}
