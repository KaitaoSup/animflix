import express from 'express';
import path from 'path';
import { ROOT_DIR } from './config/constants.js';
import authRoutes, { authMiddleware } from './routes/authRoutes.js';
import searchRoutes from './routes/searchRoutes.js';
import streamRoutes from './routes/streamRoutes.js';
import torrserverRoutes from './routes/torrserverRoutes.js';
import systemRoutes from './routes/systemRoutes.js';
import syncRoutes from './routes/syncRoutes.js';
import pushRoutes from './routes/pushRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import downloadRoutes from './routes/downloadRoutes.js';
import { validateTorrentParams } from './utils/network.js';

export function createApp() {
  const app = express();
  const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

  // Parser JSON pour les requêtes API
  app.use(express.json());

  // En-têtes no-cache pour fichiers HTML et JS principaux
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Middleware d'authentification utilisateur
  app.use(authMiddleware);

  // Validation des liens magnet / hash avant tout appel à TorrServer ou FFmpeg
  app.use(validateTorrentParams);

  // Routes système AVANT les fichiers statiques : index.html et sw.js y reçoivent la version des
  // ressources ({{ASSET_VERSION}}) ; servis bruts par express.static, le marqueur resterait tel quel
  app.use(systemRoutes);

  // Servir les fichiers statiques (CSS, JS, Icônes, Vendor) mis en cache par le navigateur
  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: false }));

  // Montage des routes modulaires
  app.use(authRoutes);
  app.use(searchRoutes);
  app.use(streamRoutes);
  app.use(torrserverRoutes);
  app.use(syncRoutes);
  app.use(pushRoutes);
  app.use(adminRoutes);
  app.use(downloadRoutes);

  return app;
}

export default createApp;
