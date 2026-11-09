import { Router } from 'express';
import { db, dbBackupDir } from '../../database.js';
import { requireAdmin } from '../utils/admin.js';
import { getHealthReport, invalidateHealthCache } from '../services/healthService.js';
import path from 'path';
import fs from 'fs';
import { backupDatabase, BACKUP_NAME_RE } from '../services/dbMaintenance.js';
import { getErrorLog, ERROR_SOURCES } from '../services/errorLog.js';
import { listActiveStreams, stopClientStreams, STREAM_CONTROL } from '../utils/sessionManager.js';
import { MAX_CONCURRENT_STREAMS, MAX_STREAMS_PER_USER } from '../config/constants.js';

const router = Router();

/**
 * État de santé du serveur (page « Serveur » de l'administrateur). ?refresh=1 relance les tests réseau.
 */
router.get('/api/admin/health', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    res.json(await getHealthReport({ force: req.query.refresh === '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Lectures en cours : compte, appareil, titre, mode (direct, transcodage, HLS), depuis quand
 */
router.get('/api/admin/streams', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  res.json({
    now,
    max: MAX_CONCURRENT_STREAMS,
    maxPerUser: MAX_STREAMS_PER_USER,
    blockSeconds: STREAM_CONTROL.BLOCK_MS / 1000,
    items: listActiveStreams(now).map(s => ({
      clientId: s.clientId,
      kind: s.kind,
      mode: s.mode,
      username: s.username,
      title: s.title,
      hash: s.hash,
      fileIndex: s.fileIndex,
      local: s.local,
      device: s.device,
      startedAt: s.startedAt,
      lastAccess: s.lastAccess,
      own: s.clientId === (typeof req.query.clientId === 'string' ? req.query.clientId : null)
    }))
  });
});

/**
 * Coupe la lecture d'un appareil (il ne peut pas relancer pendant 1 minute)
 */
router.post('/api/admin/streams/stop', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const clientId = req.body?.clientId;
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{4,64}$/.test(clientId)) {
    return res.status(400).json({ error: 'Appareil invalide' });
  }
  const stopped = stopClientStreams(clientId);
  if (!stopped) return res.status(404).json({ error: 'Cette lecture est déjà terminée.' });
  console.log(`🛑 Lecture coupée par l'administrateur ${req.user.username} (appareil ${clientId})`);
  res.json({ success: true, stopped });
});

/**
 * Sauvegarde immédiate de la base (une par jour : sans effet si celle du jour existe déjà)
 */
router.post('/api/admin/backup', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const created = await backupDatabase(db, { backupDir: dbBackupDir });
    invalidateHealthCache();
    res.json({
      success: true,
      created: !!created,
      message: created ? 'Sauvegarde du jour créée.' : "La sauvegarde du jour existe déjà."
    });
  } catch (err) {
    res.status(500).json({ error: 'Sauvegarde impossible : ' + err.message });
  }
});

/**
 * Journal des erreurs (?source=ffmpeg… pour filtrer)
 */
router.get('/api/admin/errors', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  const log = getErrorLog();
  if (!log) return res.json({ items: [], counts24h: {}, sources: ERROR_SOURCES });
  const source = typeof req.query.source === 'string' && ERROR_SOURCES[req.query.source] ? req.query.source : null;
  res.json({
    items: log.list({ limit: req.query.limit, source }),
    counts24h: log.countsSince(Date.now() - 24 * 60 * 60 * 1000),
    sources: ERROR_SOURCES
  });
});

router.delete('/api/admin/errors', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const log = getErrorLog();
  res.json({ cleared: log ? log.clear() : 0 });
});

/**
 * Téléchargement d'une sauvegarde (copie hors du serveur)
 */
router.get('/api/admin/backups/:name', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name = req.params.name;
  if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: 'Nom de sauvegarde invalide' });
  const file = path.join(dbBackupDir, name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Sauvegarde introuvable' });
  res.download(file, name);
});

export default router;
