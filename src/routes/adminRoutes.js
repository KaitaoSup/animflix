import { Router } from 'express';
import { db, dbBackupDir } from '../../database.js';
import { requireAdmin } from '../utils/admin.js';
import { getHealthReport, invalidateHealthCache } from '../services/healthService.js';
import path from 'path';
import fs from 'fs';
import { backupDatabase, BACKUP_NAME_RE } from '../services/dbMaintenance.js';
import { getErrorLog, ERROR_SOURCES } from '../services/errorLog.js';

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
