import { Router } from 'express';
import fs from 'fs';
import { isAdminUser } from '../../database.js';
import { getDownloadManager } from '../services/downloadService.js';
import { DOWNLOADS_DIR } from '../config/constants.js';

const router = Router();

const ID_RE = /^[a-z0-9]{32,40}_f\d{1,6}$/;

function managerOr503(res) {
  const manager = getDownloadManager();
  if (!manager) res.status(503).json({ error: 'Téléchargements indisponibles sur ce serveur.' });
  return manager;
}

function requireUser(req, res) {
  if (req.user) return true;
  res.status(401).json({ error: 'Connectez-vous à votre compte Animflix pour garder des épisodes sur le serveur.' });
  return false;
}

async function diskInfo() {
  try {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    const st = await fs.promises.statfs(DOWNLOADS_DIR);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch (e) {
    return null;
  }
}

/**
 * Bibliothèque du serveur (commune à tous les comptes) + espace disque restant
 */
router.get('/api/downloads', async (req, res) => {
  if (!requireUser(req, res)) return;
  const manager = managerOr503(res);
  if (!manager) return;
  res.setHeader('Cache-Control', 'no-store');
  const items = manager.list();
  res.json({
    items,
    usedBytes: items.reduce((sum, i) => sum + (i.status === 'done' ? (i.size || 0) : (i.downloaded || 0)), 0),
    disk: await diskInfo()
  });
});

router.post('/api/downloads', (req, res) => {
  if (!requireUser(req, res)) return;
  const manager = managerOr503(res);
  if (!manager) return;
  const result = manager.enqueue(req.body, req.user.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(result.created ? 201 : 200).json(result);
});

// Relance d'un téléchargement en échec (reprend le fichier partiel)
router.post('/api/downloads/:id/retry', (req, res) => {
  if (!requireUser(req, res)) return;
  const manager = managerOr503(res);
  if (!manager) return;
  const item = ID_RE.test(req.params.id) ? manager.get(req.params.id) : null;
  if (!item) return res.status(404).json({ error: 'Téléchargement introuvable' });
  const result = manager.enqueue({ ...item, magnet: item.magnet }, req.user.id);
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.json(result);
});

// Suppression : par la personne qui l'a demandé ou par l'administrateur
router.delete('/api/downloads/:id', (req, res) => {
  if (!requireUser(req, res)) return;
  const manager = managerOr503(res);
  if (!manager) return;
  const id = req.params.id;
  const item = ID_RE.test(id) ? manager.get(id) : null;
  if (!item) return res.status(404).json({ error: 'Téléchargement introuvable' });
  if (item.userId !== req.user.id && item.userId !== null && !isAdminUser(req.user)) {
    return res.status(403).json({ error: "Seul l'administrateur ou la personne qui l'a ajouté peut le supprimer." });
  }
  manager.remove(id);
  res.json({ success: true });
});

export default router;
