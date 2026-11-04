import { Router } from 'express';
import { db } from '../../database.js';
import { createSyncStore, SYNC_LIMITS } from '../services/syncStore.js';

const router = Router();
const store = createSyncStore(db);

function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Connectez-vous à Animflix pour synchroniser vos données entre appareils." });
    return false;
  }
  return true;
}

/**
 * Éléments modifiés depuis la révision `since` (synchronisation incrémentale)
 */
router.get('/api/sync', (req, res) => {
  if (!requireUser(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json(store.pull(req.user.id, req.query.since));
});

/**
 * Envoi des éléments modifiés sur cet appareil
 */
router.post('/api/sync', (req, res) => {
  if (!requireUser(req, res)) return;
  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Liste d'éléments manquante" });
  }
  if (items.length > SYNC_LIMITS.MAX_ITEMS_PER_PUSH) {
    return res.status(413).json({ error: `Trop d'éléments (max ${SYNC_LIMITS.MAX_ITEMS_PER_PUSH} par envoi)` });
  }
  res.json(store.push(req.user.id, items));
});

export default router;
