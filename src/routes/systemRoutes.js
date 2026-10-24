import { Router } from 'express';
import path from 'path';
import { ROOT_DIR, PORT } from '../config/constants.js';
import { getServerNetworkIps } from '../utils/network.js';
import { isTorrserverOnline } from '../services/torrserverService.js';
import { getCurrentNyaaUrl } from '../services/nyaaService.js';
import { getDetectedHwAccel, getVaapiDevice } from '../services/ffmpegService.js';

const router = Router();
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// --- SERVICE WORKER & MANIFEST PWA ---
router.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'sw.js'));
});

router.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(PUBLIC_DIR, 'manifest.json'));
});

// --- RACINE & SPA SHELL ---
router.get(['/', '/index.html'], (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- STATUT ET INFORMATIONS SYSTEME ---
router.get('/api/server/status', async (req, res) => {
  const torrserverOnline = await isTorrserverOnline();
  const { lanIp, tailscaleIp } = getServerNetworkIps();

  res.json({
    version: '1.2.0',
    hwAccel: getDetectedHwAccel(),
    vaapiDevice: getVaapiDevice(),
    torrserverOnline,
    nyaaUrl: getCurrentNyaaUrl(),
    lanIp,
    tailscaleIp,
    port: PORT
  });
});

export default router;
