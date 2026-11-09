// Doit rester le premier import : charge le .env avant que les autres modules lisent process.env
import './src/config/env.js';
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
import { initErrorLog } from './src/services/errorLog.js';
import { getTorrentFiles } from './src/services/torrserverService.js';
import { startAutoDownloader, buildReadyPayload } from './src/services/autoDownloader.js';
import { sendPushToUser } from './src/services/pushService.js';
import { annotateTorrents } from './src/services/sourceHealth.js';
import { autoDownloadStore } from './src/routes/autoDownloadRoutes.js';
import { sourceHealthStore } from './src/routes/sourceRoutes.js';

// Privilégier IPv4 pour éviter les lenteurs et blocages de résolution DNS
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

initErrorLog(db);
// Épisode téléchargé automatiquement terminé : « Prêt à regarder » aux comptes qui suivent l'anime
function notifyAutoDownloadReady(item) {
  const ready = buildReadyPayload(autoDownloadStore, item);
  if (!ready) return;
  for (const userId of ready.users) sendPushToUser(userId, ready.payload).catch(() => {});
}

const downloads = initDownloadManager({
  store: createDownloadStore(db),
  dir: DOWNLOADS_DIR,
  getFiles: getTorrentFiles,
  onComplete: notifyAutoDownloadReady
});

const app = createApp();

const server = app.listen(PORT, async () => {
  startDiskCacheCleaner();
  startDbMaintenance({ db, backupDir: dbBackupDir, cleanupExpiredSessions });
  startEpisodeNotifier();
  downloads.resume();
  startAutoDownloader({
    store: autoDownloadStore,
    enqueue: (request, userId) => downloads.enqueue(request, userId),
    // Épisode déjà gardé à la main (ou en cours) : pas de second exemplaire
    isAlreadyKept: (mediaId, episode) => downloads.list().some(i => i.mediaId === mediaId && i.episode === episode && i.status !== 'error'),
    getFiles: getTorrentFiles,
    annotate: (list) => { try { return annotateTorrents(sourceHealthStore, list); } catch (e) { return list; } }
  });
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
