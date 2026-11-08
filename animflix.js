import dns from 'dns';
import { PORT, DOWNLOADS_DIR } from './src/config/constants.js';
import { checkHardwareAcceleration } from './src/services/ffmpegService.js';
import { killAllProcesses } from './src/utils/sessionManager.js';
import { createApp } from './src/app.js';
import { startDiskCacheCleaner } from './src/utils/diskCacheCleaner.js';
import { startDbMaintenance } from './src/services/dbMaintenance.js';
import { startEpisodeNotifier } from './src/services/episodeNotifier.js';
import { db, dbBackupDir, cleanupExpiredSessions } from './database.js';
import { initDownloadManager, createDownloadStore } from './src/services/downloadService.js';
import { getTorrentFiles } from './src/services/torrserverService.js';

// Privilégier IPv4 pour éviter les lenteurs et blocages de résolution DNS
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

// Chargement automatique des variables d'environnement (.env)
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (e) {
    // Le fichier .env est optionnel
  }
}

const downloads = initDownloadManager({ store: createDownloadStore(db), dir: DOWNLOADS_DIR, getFiles: getTorrentFiles });

const app = createApp();

const server = app.listen(PORT, async () => {
  startDiskCacheCleaner();
  startDbMaintenance({ db, backupDir: dbBackupDir, cleanupExpiredSessions });
  startEpisodeNotifier();
  downloads.resume();
  await checkHardwareAcceleration();
  console.log(`✅ Serveur Animflix modulaire prêt sur http://localhost:${PORT} !`);
});

// Gestion propre des signaux d'arrêt pour éviter les processus zombies FFmpeg
function handleShutdown(signal) {
  console.log(`\n🛑 Signal ${signal} reçu, arrêt propre du serveur Animflix...`);
  killAllProcesses();
  downloads.stopAll();
  server.close(() => {
    console.log("👋 Serveur Animflix arrêté proprement.");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 4000).unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

export default app;
