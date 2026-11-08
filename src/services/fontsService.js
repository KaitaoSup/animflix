import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FONT_CACHE_DIR } from '../config/constants.js';
import { getTorrentHash } from '../utils/network.js';
import { touchCacheFile } from '../utils/diskCacheCleaner.js';
import { mediaInputUrl } from './downloadService.js';

const execFilePromise = promisify(execFile);

// --- POLICES EMBARQUÉES DES FANSUBS (PIÈCES JOINTES MKV) ---
// Les teams joignent au MKV les polices utilisées par leurs sous-titres ASS (dialogues, panneaux, karaokés).
// Elles sont extraites une fois par fichier, stockées par empreinte SHA-1 (une police partagée par tous
// les épisodes d'une série n'est stockée et téléchargée qu'une fois), puis servies au moteur libass du navigateur.

const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2'];
const FONT_MIME_REGEX = /(font|truetype|opentype|sfnt)/i;
const MAX_FONT_COUNT = 150;
const MAX_FONT_BYTES = 40 * 1024 * 1024;      // par police
const MAX_TOTAL_FONT_BYTES = 150 * 1024 * 1024; // par fichier vidéo
const FONT_ID_REGEX = /^[0-9a-f]{40}\.(ttf|otf|ttc|otc|woff|woff2)$/;

const FONT_CONTENT_TYPES = {
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ttc': 'font/collection',
  '.otc': 'font/collection',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const activeExtractions = new Map(); // manifestKey -> Promise<fonts[]>

function isFontAttachment(stream) {
  const filename = (stream.tags?.filename || '').toLowerCase();
  const mimetype = stream.tags?.mimetype || '';
  const codec = (stream.codec_name || '').toLowerCase();
  return FONT_EXTENSIONS.includes(path.extname(filename)) || FONT_MIME_REGEX.test(mimetype)
    || codec === 'ttf' || codec === 'otf';
}

function fontExtension(stream) {
  const ext = path.extname((stream.tags?.filename || '').toLowerCase());
  if (FONT_EXTENSIONS.includes(ext)) return ext;
  const mimetype = (stream.tags?.mimetype || '').toLowerCase();
  if (mimetype.includes('opentype') || mimetype.includes('otf')) return '.otf';
  if (mimetype.includes('woff2')) return '.woff2';
  if (mimetype.includes('woff')) return '.woff';
  return '.ttf';
}

function manifestPath(manifestKey) {
  return path.join(FONT_CACHE_DIR, `${manifestKey}.fonts.json`);
}

// Lit le manifeste en cache si toutes ses polices sont encore présentes sur le disque
function readCachedManifest(manifestKey) {
  const file = manifestPath(manifestKey);
  try {
    const fonts = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(fonts)) return null;
    if (!fonts.every(f => FONT_ID_REGEX.test(f.id) && fs.existsSync(path.join(FONT_CACHE_DIR, f.id)))) return null;
    touchCacheFile(file);
    for (const f of fonts) touchCacheFile(path.join(FONT_CACHE_DIR, f.id));
    return fonts;
  } catch (e) {
    return null;
  }
}

async function extractFonts(magnet, fileIndex, manifestKey) {
  const torrUrl = mediaInputUrl(magnet, fileIndex);

  // 1. Lister les pièces jointes (elles sont dans l'en-tête Matroska : lecture rapide)
  const { stdout } = await execFilePromise('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=index,codec_type,codec_name:stream_tags=filename,mimetype',
    '-of', 'json',
    torrUrl
  ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  const streams = JSON.parse(stdout).streams || [];
  const attachments = streams
    .filter(s => s.codec_type === 'attachment' && isFontAttachment(s))
    .slice(0, MAX_FONT_COUNT);

  if (attachments.length === 0) {
    fs.writeFileSync(manifestPath(manifestKey), '[]');
    return [];
  }

  // 2. Extraire chaque police vers un nom de fichier contrôlé (jamais le nom fourni par le MKV)
  const tmpDir = fs.mkdtempSync(path.join(FONT_CACHE_DIR, `.${manifestKey}_`));
  try {
    const args = ['-v', 'error', '-y'];
    for (const s of attachments) {
      args.push(`-dump_attachment:${s.index}`, path.join(tmpDir, `${s.index}.bin`));
    }
    args.push('-i', torrUrl, '-t', '0', '-f', 'null', '-');
    try {
      await execFilePromise('ffmpeg', args, { timeout: 90000, maxBuffer: 10 * 1024 * 1024 });
    } catch (e) {
      // FFmpeg peut se terminer en erreur après avoir extrait les pièces jointes : on garde ce qui a été écrit
      console.warn(`⚠️ Extraction polices (${manifestKey}) : ${e.message.split('\n')[0]}`);
    }

    // 3. Stockage par empreinte (dédupliqué entre épisodes)
    const fonts = [];
    const seen = new Set();
    let total = 0;
    for (const s of attachments) {
      const tmpFile = path.join(tmpDir, `${s.index}.bin`);
      let data;
      try { data = fs.readFileSync(tmpFile); } catch (e) { continue; }
      if (data.length === 0 || data.length > MAX_FONT_BYTES || total + data.length > MAX_TOTAL_FONT_BYTES) continue;
      const id = crypto.createHash('sha1').update(data).digest('hex') + fontExtension(s);
      if (seen.has(id)) continue;
      seen.add(id);
      total += data.length;
      const dest = path.join(FONT_CACHE_DIR, id);
      if (fs.existsSync(dest)) touchCacheFile(dest);
      else fs.writeFileSync(dest, data);
      fonts.push({ id, name: path.basename(s.tags?.filename || id), size: data.length });
    }

    fs.writeFileSync(manifestPath(manifestKey), JSON.stringify(fonts));
    console.log(`🔤 ${fonts.length} police(s) embarquée(s) extraite(s) (${(total / 1024 / 1024).toFixed(1)} Mo) pour ${manifestKey}`);
    return fonts;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Liste des polices embarquées d'un fichier vidéo : [{ id, name, size }]
 * (extraction au premier appel, puis cache disque ; une seule extraction simultanée par fichier)
 */
export async function getEmbeddedFonts(magnet, fileIndex = 1) {
  const hash = getTorrentHash(magnet);
  const parsedFileIndex = parseInt(fileIndex, 10) || 1;
  const manifestKey = `${hash}_f${parsedFileIndex}`;

  const cached = readCachedManifest(manifestKey);
  if (cached) return cached;

  let pending = activeExtractions.get(manifestKey);
  if (!pending) {
    pending = extractFonts(magnet, parsedFileIndex, manifestKey)
      .finally(() => activeExtractions.delete(manifestKey));
    activeExtractions.set(manifestKey, pending);
  }
  return pending;
}

/**
 * Chemin disque et type MIME d'une police extraite, ou null si l'identifiant est invalide / absent
 */
export function resolveFontFile(id) {
  if (typeof id !== 'string' || !FONT_ID_REGEX.test(id)) return null;
  const filePath = path.join(FONT_CACHE_DIR, id);
  if (!fs.existsSync(filePath)) return null;
  touchCacheFile(filePath);
  return { filePath, contentType: FONT_CONTENT_TYPES[path.extname(id)] || 'application/octet-stream' };
}
