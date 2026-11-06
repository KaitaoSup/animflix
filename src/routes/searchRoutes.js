import { Router } from 'express';
import { searchAnime, testNyaaMirrors, setWorkingNyaaUrl } from '../services/nyaaService.js';
import { getTorrentSourcesStatus } from '../services/torrentAggregator.js';
import { testTorznabConnection } from '../services/torznabService.js';
import { getServerSetting, setServerSetting } from '../../database.js';

const router = Router();

/**
 * Recherche torrent unifiée (multi-sources résiliente : Nyaa + TokyoTosho + Torznab)
 */
router.get('/api/search', async (req, res) => {
  const query = req.query.q?.trim();
  const type = req.query.type || 'vostfr';
  const mode = req.query.mode; // 'resilient' | 'aggregate' | 'nyaa_only'
  if (!query) return res.json([]);

  try {
    const videos = await searchAnime(query, type, { mode });
    res.json(videos);
  } catch (error) {
    console.error("⚠️ Erreur recherche multi-sources torrent:", error.message);
    res.status(500).json([]);
  }
});

/**
 * État et configuration actuelle des sources torrents
 */
router.get('/api/torrent/sources', (req, res) => {
  try {
    const status = getTorrentSourcesStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Récupère les paramètres de configuration des sources
 */
router.get('/api/torrent/settings', (req, res) => {
  res.json({
    mode: getServerSetting('torrent_source_mode', 'resilient'),
    torznabUrl: getServerSetting('torznab_url', ''),
    hasTorznabApiKey: Boolean(getServerSetting('torznab_api_key', '')),
    customNyaaUrl: getServerSetting('custom_nyaa_url', '')
  });
});

/**
 * Enregistre les paramètres de configuration des sources torrents
 */
router.post('/api/torrent/settings', (req, res) => {
  const { mode, torznabUrl, torznabApiKey, customNyaaUrl } = req.body || {};

  if (mode && ['resilient', 'aggregate', 'nyaa_only'].includes(mode)) {
    setServerSetting('torrent_source_mode', mode);
  }

  if (torznabUrl !== undefined) {
    setServerSetting('torznab_url', String(torznabUrl).trim());
  }

  if (torznabApiKey !== undefined && torznabApiKey !== '********') {
    setServerSetting('torznab_api_key', String(torznabApiKey).trim());
  }

  if (customNyaaUrl !== undefined) {
    const cleanNyaa = String(customNyaaUrl).trim();
    setServerSetting('custom_nyaa_url', cleanNyaa);
    if (cleanNyaa) {
      setWorkingNyaaUrl(cleanNyaa);
    }
  }

  res.json({
    success: true,
    settings: {
      mode: getServerSetting('torrent_source_mode', 'resilient'),
      torznabUrl: getServerSetting('torznab_url', ''),
      hasTorznabApiKey: Boolean(getServerSetting('torznab_api_key', ''))
    }
  });
});

/**
 * Teste la connexion à une instance Jackett / Prowlarr via Torznab
 */
router.post('/api/torrent/test-torznab', async (req, res) => {
  let { url, apiKey } = req.body || {};
  if (!url) {
    url = getServerSetting('torznab_url', '');
  }
  if (!apiKey || apiKey === '********') {
    apiKey = getServerSetting('torznab_api_key', '');
  }

  const result = await testTorznabConnection({ url, apiKey });
  res.json(result);
});

/**
 * Teste et compare la latence des miroirs Nyaa
 */
router.get('/api/torrent/mirrors', async (req, res) => {
  try {
    const mirrors = await testNyaaMirrors();
    res.json(mirrors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
