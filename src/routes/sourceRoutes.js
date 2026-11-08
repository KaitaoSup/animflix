import { Router } from 'express';
import { db } from '../../database.js';
import { createSourceHealthStore, hashFromMagnet, FAIL_REASONS } from '../services/sourceHealth.js';
import { logServerError } from '../services/errorLog.js';

const router = Router();

export const sourceHealthStore = createSourceHealthStore(db);
try { sourceHealthStore.prune(); } catch (e) {}
setInterval(() => { try { sourceHealthStore.prune(); } catch (e) {} }, 24 * 60 * 60 * 1000).unref();

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

// Une personne = un compte, sinon un lecteur (clientId), sinon une adresse IP
function reporterFor(req) {
  if (req.user) return `u:${req.user.id}`;
  const clientId = req.body?.clientId;
  if (typeof clientId === 'string' && CLIENT_ID_RE.test(clientId)) return `c:${clientId}`;
  return `ip:${req.ip}`;
}

/**
 * Signalement du lecteur : { magnet, fileIndex, outcome: 'fail' | 'ok', reason, title }
 */
router.post('/api/sources/report', (req, res) => {
  const { magnet, outcome, reason } = req.body || {};
  const hash = hashFromMagnet(magnet);
  if (!hash || (outcome !== 'fail' && outcome !== 'ok')) {
    return res.status(400).json({ error: 'Signalement invalide' });
  }
  const fileIndex = Number.isInteger(Number(req.body.fileIndex)) ? Number(req.body.fileIndex) : 1;
  const recorded = sourceHealthStore.record({ hash, fileIndex, outcome, reason, reporter: reporterFor(req) });
  if (recorded && outcome === 'fail') {
    const title = typeof req.body.title === 'string' ? req.body.title.slice(0, 160) : hash;
    logServerError('lecture', `${FAIL_REASONS[reason] || 'Source signalée'} : ${title}`,
      `Torrent ${hash} (fichier ${fileIndex})${req.user ? ` — signalé par ${req.user.username}` : ''}`);
  }
  res.json({ recorded, status: sourceHealthStore.statusFor([hash]).get(hash) || null });
});

export default router;
