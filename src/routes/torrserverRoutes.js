import { Router } from 'express';
import {
  getTorrentFiles,
  dropTorrent,
  cleanTorrServerCache,
  getTorrServerStats,
  listTorrents,
  preloadTorrentFile
} from '../services/torrserverService.js';
import { getTorrentHash } from '../utils/network.js';
import { parseFileIndex } from '../utils/params.js';

const router = Router();

router.get('/api/torrent/files', async (req, res) => {
  const { magnet } = req.query;
  if (!magnet) return res.status(400).json({ error: "Lien magnet manquant" });

  try {
    const data = await getTorrentFiles(magnet);
    res.json(data);
  } catch (err) {
    res.json({
      hash: getTorrentHash(magnet),
      isMultiFile: false,
      files: [{ id: 1, name: "Flux vidéo principal", episode: 1, label: "Épisode 1" }]
    });
  }
});

router.post('/api/torrserver/drop', async (req, res) => {
  const { magnet, hash } = { ...req.query, ...req.body };
  const torrentHash = hash || (magnet ? getTorrentHash(magnet) : null);
  if (!torrentHash) return res.status(400).json({ error: "Hash ou magnet manquant" });

  try {
    const result = await dropTorrent(torrentHash);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Préchargement de l'épisode suivant (appelé par le lecteur vers 80 % de l'épisode en cours)
 */
router.post('/api/torrserver/preload', (req, res) => {
  const { magnet } = req.body || {};
  if (!magnet) return res.status(400).json({ error: "Lien magnet manquant" });
  res.status(202).json(preloadTorrentFile(magnet, parseFileIndex(req.body.fileIndex)));
});

router.post('/api/torrserver/clean', async (req, res) => {
  try {
    const result = await cleanTorrServerCache();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/torrserver/stats', async (req, res) => {
  const { hash, magnet } = req.query;
  const torrentHash = hash || (magnet ? getTorrentHash(magnet) : null);

  try {
    const stats = await getTorrServerStats(torrentHash);
    res.json(stats);
  } catch (err) {
    res.json({
      online: false,
      found: false,
      error: "TorrServer non accessible: " + err.message
    });
  }
});

router.get('/api/torrserver/status', async (req, res) => {
  try {
    const listRes = await listTorrents();
    const torrents = listRes.data || [];
    res.json({
      activeCount: torrents.length,
      torrents: torrents.map(t => ({
        hash: t.hash,
        title: t.title || t.name,
        stat: t.stat_string || t.stat,
        size: t.torrent_size
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
