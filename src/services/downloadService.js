/**
 * Bibliothèque d'épisodes gardés sur le serveur (« Garder sur le serveur »).
 *
 * Le fichier d'un torrent est téléchargé en entier via TorrServer dans DOWNLOADS_DIR, un à la fois
 * (pour ne pas ralentir les lectures en cours), avec reprise après coupure ou redémarrage.
 * Une fois terminé, toutes les lectures (direct, transcodage, HLS, sous-titres, miniatures) lisent
 * le fichier local au lieu du torrent : l'épisode reste regardable même sans seeders ni TorrServer.
 *
 * Le store prend la base en paramètre (comme syncStore / pushStore) pour être testable en mémoire.
 */
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { TORRSERVER_LOCAL_URL } from '../config/constants.js';
import { isValidMagnet } from '../utils/network.js';

export const DOWNLOAD_LIMITS = {
  MAX_TITLE_LENGTH: 300,
  MAX_URL_LENGTH: 2048,
  MAX_ITEMS: 2000,
  // Marge gardée libre sur le disque en plus de la taille du fichier
  DISK_MARGIN_BYTES: 2 * 1024 ** 3,
  MAX_ATTEMPTS: 6,
  // Délai sans aucune donnée reçue avant de considérer le flux bloqué (puis reprise)
  STALL_TIMEOUT_MS: 90 * 1000,
  PROGRESS_SAVE_MS: 3000
};

const VIDEO_EXTS = new Set(['.mkv', '.mp4', '.webm', '.avi', '.m4v', '.mov', '.ts', '.wmv']);

/**
 * Identifiant stable d'un fichier de torrent (`<infohash>_f<index>`), aussi utilisé comme nom de fichier.
 * Ne dépend que de l'infohash : un même épisode ouvert depuis un autre magnet (trackers différents) est reconnu.
 */
export function downloadId(magnet, fileIndex) {
  const m = typeof magnet === 'string' ? /xt=urn:btih:([a-z0-9]+)/i.exec(magnet) : null;
  if (!m) return null;
  const idx = parseInt(fileIndex, 10) || 1;
  return `${m[1].toLowerCase()}_f${idx}`;
}

function cleanText(value, max = DOWNLOAD_LIMITS.MAX_TITLE_LENGTH) {
  if (typeof value !== 'string') return null;
  const v = value.replace(/[\u0000-\u001f]/g, ' ').trim();
  return v ? v.slice(0, max) : null;
}

function cleanInt(value, { min = 0, max = 1e9 } = {}) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Valide une demande de téléchargement venant du client. Retourne null si elle est invalide.
 */
export function normalizeDownloadRequest(raw) {
  if (!raw || typeof raw !== 'object' || !isValidMagnet(raw.magnet)) return null;
  const fileIndex = cleanInt(raw.fileIndex ?? 1, { min: 0, max: 100000 }) ?? 1;
  const id = downloadId(raw.magnet, fileIndex);
  if (!id) return null;
  const poster = cleanText(raw.poster, DOWNLOAD_LIMITS.MAX_URL_LENGTH);
  return {
    id,
    magnet: raw.magnet,
    fileIndex,
    title: cleanText(raw.title) || 'Épisode',
    animeName: cleanText(raw.animeName),
    episode: cleanInt(raw.episode, { min: 0, max: 100000 }),
    mediaId: cleanInt(raw.mediaId, { min: 1 }),
    poster: poster && /^https?:\/\//i.test(poster) ? poster : null
  };
}

export function createDownloadStore(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_downloads (
      id TEXT PRIMARY KEY,
      magnet TEXT NOT NULL,
      file_index INTEGER NOT NULL,
      title TEXT NOT NULL,
      anime_name TEXT,
      episode INTEGER,
      media_id INTEGER,
      poster TEXT,
      file_name TEXT,
      local_file TEXT,
      size INTEGER,
      downloaded INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      user_id INTEGER,
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_server_downloads_media ON server_downloads(media_id);
  `);

  const stmts = {
    get: db.prepare('SELECT * FROM server_downloads WHERE id = ?'),
    all: db.prepare('SELECT * FROM server_downloads ORDER BY created_at DESC'),
    count: db.prepare('SELECT COUNT(*) AS n FROM server_downloads'),
    nextQueued: db.prepare("SELECT * FROM server_downloads WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"),
    insert: db.prepare(`
      INSERT INTO server_downloads (id, magnet, file_index, title, anime_name, episode, media_id, poster, status, user_id, created_at)
      VALUES (@id, @magnet, @fileIndex, @title, @animeName, @episode, @mediaId, @poster, 'queued', @userId, @now)
    `),
    remove: db.prepare('DELETE FROM server_downloads WHERE id = ?'),
    requeueInterrupted: db.prepare("UPDATE server_downloads SET status = 'queued' WHERE status = 'downloading'")
  };

  const COLUMNS = new Set(['file_name', 'local_file', 'size', 'downloaded', 'status', 'error', 'completed_at']);

  return {
    get: (id) => stmts.get.get(id) || null,
    list: () => stmts.all.all(),
    count: () => stmts.count.get().n,
    nextQueued: () => stmts.nextQueued.get() || null,
    insert: (req, userId, now = Date.now()) => stmts.insert.run({ ...req, userId: userId ?? null, now }),
    remove: (id) => stmts.remove.run(id).changes > 0,
    requeueInterrupted: () => stmts.requeueInterrupted.run().changes,
    update(id, fields) {
      const keys = Object.keys(fields).filter(k => COLUMNS.has(k));
      if (!keys.length) return;
      db.prepare(`UPDATE server_downloads SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`)
        .run({ ...Object.fromEntries(keys.map(k => [k, fields[k]])), id });
    }
  };
}

function parseContentRangeTotal(header) {
  const m = /\/(\d+)\s*$/.exec(header || '');
  return m ? Number(m[1]) : null;
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (e) { return 0; }
}

/**
 * Gestionnaire de téléchargements : une file, un téléchargement actif à la fois.
 * Les dépendances réseau / disque sont injectables pour les tests.
 */
export function createDownloadManager({
  store,
  dir,
  httpGet = (url, opts) => axios.get(url, opts),
  getFiles = null,
  freeSpace = async (d) => { const st = await fs.promises.statfs(d); return st.bavail * st.bsize; },
  retryDelayMs = (attempt) => Math.min(60000, 5000 * attempt),
  log = console
}) {
  let active = null; // { id, controller, bytes, total, speed, lastSample }
  let pumping = false;

  const partPath = (id) => path.join(dir, `${id}.part`);

  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  function publicItem(row) {
    if (!row) return null;
    const live = active && active.id === row.id ? active : null;
    const downloaded = live ? live.bytes : row.downloaded;
    const size = (live && live.total) || row.size || null;
    return {
      id: row.id,
      magnet: row.magnet,
      fileIndex: row.file_index,
      title: row.title,
      animeName: row.anime_name,
      episode: row.episode,
      mediaId: row.media_id,
      poster: row.poster,
      fileName: row.file_name,
      size,
      downloaded,
      progress: size ? Math.min(1, downloaded / size) : (row.status === 'done' ? 1 : 0),
      speed: live ? Math.round(live.speed) : 0,
      status: row.status,
      error: row.error,
      userId: row.user_id ?? null,
      createdAt: row.created_at,
      completedAt: row.completed_at
    };
  }

  /**
   * Chemin du fichier local d'un épisode terminé, ou null (toujours null si le fichier a disparu du disque)
   */
  function localPath(magnet, fileIndex) {
    const id = downloadId(magnet, fileIndex);
    if (!id) return null;
    const row = store.get(id);
    if (!row || row.status !== 'done' || !row.local_file) return null;
    const p = path.join(dir, row.local_file);
    return fs.existsSync(p) ? p : null;
  }

  function enqueue(raw, userId = null) {
    const req = normalizeDownloadRequest(raw);
    if (!req) return { error: 'Demande de téléchargement invalide', status: 400 };
    const existing = store.get(req.id);
    if (existing) {
      if (existing.status === 'error') {
        store.update(req.id, { status: 'queued', error: null });
        pump();
      }
      return { item: publicItem(store.get(req.id)), created: false };
    }
    if (store.count() >= DOWNLOAD_LIMITS.MAX_ITEMS) {
      return { error: 'Trop d\'épisodes gardés sur le serveur : supprimez-en avant d\'en ajouter.', status: 409 };
    }
    store.insert(req, userId);
    pump();
    return { item: publicItem(store.get(req.id)), created: true };
  }

  function remove(id) {
    const row = store.get(id);
    if (!row) return false;
    if (active && active.id === id) {
      active.cancelled = true;
      active.controller.abort();
    }
    store.remove(id);
    for (const p of [partPath(id), row.local_file ? path.join(dir, row.local_file) : null]) {
      if (p) fs.promises.unlink(p).catch(() => {});
    }
    return true;
  }

  function list() {
    return store.list().map(publicItem);
  }

  function get(id) {
    return publicItem(store.get(id));
  }

  /**
   * Un passage de téléchargement : HTTP GET (avec Range pour reprendre) écrit dans le .part.
   * Résout { complete: true } quand le fichier est entier.
   */
  async function transferOnce(row, job) {
    const part = partPath(row.id);
    let start = fileSize(part);
    if (job.total && start >= job.total) return { complete: true };

    const url = `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(row.magnet)}&index=${row.file_index}&play`;
    const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
    const res = await httpGet(url, {
      responseType: 'stream',
      headers,
      signal: job.controller.signal,
      timeout: DOWNLOAD_LIMITS.STALL_TIMEOUT_MS,
      validateStatus: (s) => s === 200 || s === 206
    });

    if (res.status === 200 && start > 0) {
      // Reprise ignorée par le serveur : tout recommencer
      start = 0;
    }
    const total = parseContentRangeTotal(res.headers?.['content-range'])
      || (Number(res.headers?.['content-length']) ? Number(res.headers['content-length']) + start : null)
      || job.total;
    if (total) {
      job.total = total;
      store.update(row.id, { size: total });
    }

    job.bytes = start;
    const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
    await new Promise((resolve, reject) => {
      let stallTimer = null;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => res.data.destroy(new Error('Aucune donnée reçue (torrent bloqué)')), DOWNLOAD_LIMITS.STALL_TIMEOUT_MS);
      };
      const fail = (err) => { clearTimeout(stallTimer); out.destroy(); reject(err); };
      armStall();
      res.data.on('data', (chunk) => {
        job.bytes += chunk.length;
        armStall();
        const now = Date.now();
        const dt = now - job.lastSample.at;
        if (dt >= 1000) {
          job.speed = ((job.bytes - job.lastSample.bytes) * 1000) / dt;
          job.lastSample = { at: now, bytes: job.bytes };
        }
        if (now - job.lastSavedAt >= DOWNLOAD_LIMITS.PROGRESS_SAVE_MS) {
          job.lastSavedAt = now;
          store.update(row.id, { downloaded: job.bytes });
        }
      });
      res.data.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => { clearTimeout(stallTimer); resolve(); });
      res.data.pipe(out);
    });

    const written = fileSize(part);
    store.update(row.id, { downloaded: written });
    // Taille inconnue : la fin normale du flux vaut fichier complet
    return { complete: job.total ? written >= job.total : true };
  }

  async function runJob(row) {
    const job = {
      id: row.id,
      controller: new AbortController(),
      bytes: row.downloaded || 0,
      total: row.size || null,
      speed: 0,
      lastSample: { at: Date.now(), bytes: row.downloaded || 0 },
      lastSavedAt: 0,
      cancelled: false
    };
    active = job;
    store.update(row.id, { status: 'downloading', error: null });

    try {
      ensureDir();
      let fileName = row.file_name;
      if (getFiles && (!fileName || !job.total)) {
        try {
          const info = await getFiles(row.magnet);
          const f = (info?.files || []).find(x => x.id === row.file_index);
          if (f?.name) fileName = path.basename(f.name);
          if (f?.length) job.total = f.length;
          store.update(row.id, { file_name: fileName || null, size: job.total || null });
        } catch (e) {}
      }

      if (job.total) {
        const free = await freeSpace(dir).catch(() => Infinity);
        const remaining = job.total - fileSize(partPath(row.id));
        if (free - remaining < DOWNLOAD_LIMITS.DISK_MARGIN_BYTES) {
          throw Object.assign(new Error('Espace disque insuffisant sur le serveur'), { fatal: true });
        }
      }

      let attempt = 0;
      for (;;) {
        try {
          const { complete } = await transferOnce(row, job);
          if (complete) break;
          throw new Error('Flux interrompu avant la fin du fichier');
        } catch (err) {
          if (job.cancelled) return;
          attempt++;
          if (attempt >= DOWNLOAD_LIMITS.MAX_ATTEMPTS) throw err;
          log.warn?.(`📥 Téléchargement ${row.id} interrompu (${err.message}), reprise ${attempt}/${DOWNLOAD_LIMITS.MAX_ATTEMPTS - 1}…`);
          await new Promise(r => setTimeout(r, retryDelayMs(attempt)));
          if (job.cancelled) return;
        }
      }

      const ext = path.extname(fileName || '').toLowerCase();
      const localFile = `${row.id}${VIDEO_EXTS.has(ext) ? ext : '.mkv'}`;
      await fs.promises.rename(partPath(row.id), path.join(dir, localFile));
      const size = fileSize(path.join(dir, localFile));
      if (!store.get(row.id)) {
        // Supprimé pendant le renommage
        await fs.promises.unlink(path.join(dir, localFile)).catch(() => {});
        return;
      }
      store.update(row.id, { status: 'done', local_file: localFile, size, downloaded: size, completed_at: Date.now(), error: null });
      log.log?.(`📥 Épisode gardé sur le serveur : ${row.title} (${Math.round(size / 1024 / 1024)} Mo)`);
    } catch (err) {
      if (job.cancelled) return;
      store.update(row.id, { status: 'error', error: String(err.message || err).slice(0, 300), downloaded: fileSize(partPath(row.id)) });
      log.warn?.(`📥 Échec du téléchargement ${row.id} : ${err.message}`);
    } finally {
      if (active === job) active = null;
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (active) return;
        const next = store.nextQueued();
        if (!next) return;
        await runJob(next);
      }
    } finally {
      pumping = false;
    }
  }

  /** Au démarrage : les téléchargements coupés par l'arrêt du serveur repartent là où ils en étaient */
  function resume() {
    const n = store.requeueInterrupted();
    if (n) log.log?.(`📥 Reprise de ${n} téléchargement(s) interrompu(s)`);
    pump();
  }

  function stopAll() {
    if (active) {
      active.cancelled = true;
      active.controller.abort();
    }
  }

  return { enqueue, remove, list, get, localPath, resume, stopAll, pump, _partPath: partPath };
}

// --- INSTANCE DU SERVEUR ---

let manager = null;

export function initDownloadManager(options) {
  manager = createDownloadManager(options);
  return manager;
}

export function getDownloadManager() {
  return manager;
}

/**
 * Entrée FFmpeg / ffprobe d'un épisode : le fichier gardé sur le serveur s'il existe, sinon le flux TorrServer
 */
export function mediaInputUrl(magnet, fileIndex = 1) {
  const idx = parseInt(fileIndex, 10) || 1;
  const local = manager ? manager.localPath(magnet, idx) : null;
  // Préfixe file: : un chemin contenant « : » serait sinon pris pour un protocole par FFmpeg
  if (local) return `file:${local}`;
  return `${TORRSERVER_LOCAL_URL}/stream?link=${encodeURIComponent(magnet)}&index=${idx}&play`;
}
