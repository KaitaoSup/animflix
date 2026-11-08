import { Router } from 'express';
import { db, dbBackupDir } from '../../database.js';
import { requireAdmin } from '../utils/admin.js';
import { getHealthReport, invalidateHealthCache } from '../services/healthService.js';
import { backupDatabase } from '../services/dbMaintenance.js';

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

export default router;
