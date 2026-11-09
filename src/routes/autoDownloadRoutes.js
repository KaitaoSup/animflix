import { Router } from 'express';
import { db } from '../../database.js';
import { createAutoDownloadStore, AUTO_DOWNLOAD_CONFIG } from '../services/autoDownloader.js';

/**
 * Téléchargement automatique des nouveaux épisodes, réglé par anime depuis sa fiche (compte Animflix requis).
 */
const router = Router();

export const autoDownloadStore = createAutoDownloadStore(db);

function requireUser(req, res) {
  if (req.user) return true;
  res.status(401).json({ error: 'Connectez-vous à votre compte Animflix pour télécharger automatiquement les épisodes.' });
  return false;
}

function parseMediaId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 1e9 ? n : null;
}

router.get('/api/auto-downloads', (req, res) => {
  if (!requireUser(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: autoDownloadStore.listForUser(req.user.id) });
});

router.get('/api/auto-downloads/:mediaId', (req, res) => {
  if (!requireUser(req, res)) return;
  const mediaId = parseMediaId(req.params.mediaId);
  if (!mediaId) return res.status(400).json({ error: 'Anime invalide' });
  res.setHeader('Cache-Control', 'no-store');
  const item = autoDownloadStore.get(req.user.id, mediaId);
  res.json({ enabled: !!item, item });
});

// Active (avec la langue et les préférences de release de l'appareil) ou désactive pour un anime
router.put('/api/auto-downloads/:mediaId', (req, res) => {
  if (!requireUser(req, res)) return;
  const mediaId = parseMediaId(req.params.mediaId);
  if (!mediaId) return res.status(400).json({ error: 'Anime invalide' });
  const body = req.body || {};

  if (!body.enabled) {
    autoDownloadStore.remove(req.user.id, mediaId);
    return res.json({ enabled: false });
  }
  const exists = !!autoDownloadStore.get(req.user.id, mediaId);
  if (!exists && autoDownloadStore.countForUser(req.user.id) >= AUTO_DOWNLOAD_CONFIG.MAX_PER_USER) {
    return res.status(409).json({ error: `Limite atteinte : ${AUTO_DOWNLOAD_CONFIG.MAX_PER_USER} animes en téléchargement automatique.` });
  }
  const item = autoDownloadStore.set(req.user.id, mediaId, {
    title: body.title,
    poster: body.poster,
    lang: body.lang,
    resolution: body.resolution,
    groups: body.groups
  });
  res.json({ enabled: true, item });
});

export default router;
