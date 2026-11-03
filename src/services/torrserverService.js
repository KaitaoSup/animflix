import axios from 'axios';
import path from 'path';
import { TORRSERVER_LOCAL_URL } from '../config/constants.js';
import { getTorrentHash, formatBytesSpeed, formatBytesSize } from '../utils/network.js';
import { torrentFilesCache } from '../utils/cache.js';
import { extractFileEpisodeNumber } from '../utils/animeParser.js';
import { activeHlsSessions, cleanupHlsSession } from '../utils/sessionManager.js';
import { cleanDiskCaches } from '../utils/diskCacheCleaner.js';

const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.webm', '.mov', '.m4v', '.ts']);

/**
 * Vérifie si le démon TorrServer est en ligne et répond
 */
export async function isTorrserverOnline() {
  try {
    const tRes = await axios.get(`${TORRSERVER_LOCAL_URL}/echo`, { timeout: 1500 });
    return (tRes.status === 200 || tRes.data === 'echo' || tRes.data === 'MatriX');
  } catch (e) {
    return false;
  }
}

/**
 * Ajoute un torrent à TorrServer sans sauvegarde permanente
 */
export async function addTorrent(magnet) {
  return axios.post(`${TORRSERVER_LOCAL_URL}/torrents`, {
    action: "add",
    link: magnet,
    save_to_db: false
  }, { timeout: 3500 });
}

/**
 * Récupère les données d'un torrent par son hash
 */
export async function getTorrent(hash) {
  return axios.post(`${TORRSERVER_LOCAL_URL}/torrents`, {
    action: "get",
    hash
  }, { timeout: 2500 });
}

/**
 * Récupère la liste de tous les torrents actifs dans TorrServer
 */
export async function listTorrents() {
  return axios.post(`${TORRSERVER_LOCAL_URL}/torrents`, {
    action: "list"
  }, { timeout: 3000 });
}

/**
 * Récupère la liste des fichiers vidéo d'un torrent avec détection des épisodes pour packs
 */
export async function getTorrentFiles(magnet) {
  const hash = getTorrentHash(magnet);
  const cached = torrentFilesCache.get(hash);
  if (cached) {
    return cached;
  }

  // 1. Ajouter le torrent à TorrServer
  try {
    await addTorrent(magnet);
  } catch (e) {}

  // 2. Récupérer les informations et la liste des fichiers (poll court)
  let fileStats = [];
  for (let i = 0; i < 6; i++) {
    try {
      const statRes = await getTorrent(hash);
      if (statRes.data?.file_stats && statRes.data.file_stats.length > 0) {
        fileStats = statRes.data.file_stats;
        break;
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 600));
  }

  let videoFiles = fileStats
    .filter(f => {
      const ext = path.extname(f.path || '').toLowerCase();
      return VIDEO_EXTENSIONS.has(ext) || (f.length && f.length > 25 * 1024 * 1024);
    })
    .map(f => {
      const ep = extractFileEpisodeNumber(f.path);
      return {
        id: f.id,
        path: f.path,
        name: path.basename(f.path),
        length: f.length,
        episode: ep,
        label: ep !== null ? `Épisode ${ep}` : path.basename(f.path)
      };
    });

  // Tri par numéro d'épisode puis par nom
  videoFiles.sort((a, b) => {
    if (a.episode !== null && b.episode !== null) return a.episode - b.episode;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  const isMultiFile = videoFiles.length > 1;
  const responseData = {
    hash,
    isMultiFile,
    files: videoFiles.length > 0 ? videoFiles : [{ id: 1, name: "Flux vidéo principal", episode: 1, label: "Épisode 1" }]
  };

  if (videoFiles.length > 0) {
    torrentFilesCache.set(hash, responseData);
  }

  return responseData;
}

/**
 * Supprime un torrent de TorrServer et nettoie ses sessions HLS associées
 */
export async function dropTorrent(torrentHash) {
  if (!torrentHash) throw new Error("Hash manquant");

  for (const [playId, sess] of activeHlsSessions.entries()) {
    if (sess.hash === torrentHash) {
      cleanupHlsSession(playId);
    }
  }

  await axios.post(`${TORRSERVER_LOCAL_URL}/torrents`, {
    action: "rem",
    hash: torrentHash
  }, { timeout: 3000 });

  return { success: true, message: `Torrent ${torrentHash} retiré de TorrServer.` };
}

/**
 * Purge tous les torrents et données en mémoire de TorrServer
 */
export async function cleanTorrServerCache() {
  for (const playId of Array.from(activeHlsSessions.keys())) {
    cleanupHlsSession(playId);
  }

  const listRes = await listTorrents();
  const torrents = listRes.data || [];
  let cleaned = 0;
  for (const t of torrents) {
    if (t.hash) {
      try {
        await axios.post(`${TORRSERVER_LOCAL_URL}/torrents`, {
          action: "rem",
          hash: t.hash
        }, { timeout: 2000 });
        cleaned++;
      } catch (e) {}
    }
  }

  const disk = await cleanDiskCaches({ all: true });
  const freedMb = (disk.freed / 1024 / 1024).toFixed(1);

  return {
    success: true,
    cleaned,
    filesRemoved: disk.removed,
    message: `${cleaned} torrent(s) purgé(s) du cache TorrServer, ${disk.removed} fichier(s) de cache supprimé(s) (${freedMb} Mo).`
  };
}

/**
 * Récupère les statistiques détaillées (P2P, débits, pairs, buffer)
 */
export async function getTorrServerStats(torrentHash = null) {
  if (torrentHash) {
    let torrentData = null;
    try {
      const getRes = await getTorrent(torrentHash);
      if (getRes.data && getRes.data.hash) {
        torrentData = getRes.data;
      }
    } catch (e) {}

    if (!torrentData) {
      try {
        const listRes = await listTorrents();
        const list = listRes.data || [];
        torrentData = list.find(t => t.hash && t.hash.toLowerCase() === torrentHash.toLowerCase());
      } catch (e) {}
    }

    if (!torrentData) {
      return {
        online: true,
        found: false,
        hash: torrentHash,
        stat: 0,
        statLabel: "Initialisation du flux...",
        downloadSpeed: 0,
        downloadSpeedFormatted: "0 Ko/s",
        uploadSpeed: 0,
        uploadSpeedFormatted: "0 Ko/s",
        activePeers: 0,
        connectedSeeders: 0,
        totalPeers: 0,
        preloadPercent: 0,
        loadedSizeFormatted: "0 Mo"
      };
    }

    const stat = typeof torrentData.stat === 'number' ? torrentData.stat : 0;
    let statLabel = "Connexion...";
    if (stat === 0) statLabel = "Torrent ajouté";
    else if (stat === 1) statLabel = "Recherche des métadonnées & pairs...";
    else if (stat === 2) statLabel = "Mise en mémoire tampon (Préchargement)...";
    else if (stat === 3) statLabel = "Lecture & P2P en direct";
    else if (stat === 4) statLabel = "Arrêté";
    else if (torrentData.stat_string) statLabel = torrentData.stat_string;

    const preloaded = torrentData.preloaded_bytes || 0;
    const preloadSize = torrentData.preload_size || 0;
    let preloadPercent = 0;
    if (preloadSize > 0) {
      preloadPercent = Math.min(100, Math.max(0, Math.round((preloaded / preloadSize) * 100)));
    } else if (stat === 3) {
      preloadPercent = 100;
    }

    return {
      online: true,
      found: true,
      hash: torrentData.hash,
      name: torrentData.name || torrentData.title || "",
      stat,
      statString: torrentData.stat_string || "",
      statLabel,
      downloadSpeed: torrentData.download_speed || 0,
      downloadSpeedFormatted: formatBytesSpeed(torrentData.download_speed),
      uploadSpeed: torrentData.upload_speed || 0,
      uploadSpeedFormatted: formatBytesSpeed(torrentData.upload_speed),
      activePeers: torrentData.active_peers || 0,
      connectedSeeders: torrentData.connected_seeders || 0,
      totalPeers: torrentData.total_peers || 0,
      pendingPeers: torrentData.pending_peers || 0,
      halfOpenPeers: torrentData.half_open_peers || 0,
      preloadedBytes: preloaded,
      preloadSize,
      preloadPercent,
      loadedSize: torrentData.loaded_size || 0,
      loadedSizeFormatted: formatBytesSize(torrentData.loaded_size),
      torrentSize: torrentData.torrent_size || 0,
      torrentSizeFormatted: formatBytesSize(torrentData.torrent_size)
    };
  }

  // Statistiques globales
  const listRes = await listTorrents();
  const torrents = listRes.data || [];
  let totalDl = 0;
  let totalUl = 0;
  let totalPeers = 0;
  torrents.forEach(t => {
    totalDl += t.download_speed || 0;
    totalUl += t.upload_speed || 0;
    totalPeers += t.active_peers || 0;
  });

  return {
    online: true,
    activeCount: torrents.length,
    totalDownloadSpeed: totalDl,
    totalDownloadSpeedFormatted: formatBytesSpeed(totalDl),
    totalUploadSpeed: totalUl,
    totalUploadSpeedFormatted: formatBytesSpeed(totalUl),
    totalActivePeers: totalPeers,
    torrents: torrents.map(t => ({
      hash: t.hash,
      name: t.name || t.title,
      stat: t.stat,
      statString: t.stat_string,
      downloadSpeed: formatBytesSpeed(t.download_speed),
      peers: `${t.active_peers || 0} / ${t.total_peers || 0}`,
      size: formatBytesSize(t.torrent_size)
    }))
  };
}
