import { Router } from 'express';
import { db, getUserById } from '../../database.js';
import { createCalendarStore, createCalendarBuilder, isValidCalendarToken } from '../services/calendarService.js';
import { anilistRequest } from '../services/episodeNotifier.js';

const router = Router();
const store = createCalendarStore(db);
const calendarForUser = createCalendarBuilder({ fetchAnilist: anilistRequest });

const LOOPBACK_RE = /^(?:127\.|::1$|::ffff:127\.)/;
const HOST_RE = /^[a-z0-9.\-]+(?::\d{1,5})?$|^\[[a-f0-9:]+\](?::\d{1,5})?$/i;

/**
 * Adresse publique du serveur pour les liens de l'agenda. Derrière un proxy local (Tailscale Funnel,
 * nginx), le protocole d'origine est lu dans X-Forwarded-Proto.
 */
function publicBaseUrl(req) {
  const socketIp = req.socket?.remoteAddress || '';
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const proto = LOOPBACK_RE.test(socketIp) && (forwardedProto === 'https' || forwardedProto === 'http') ? forwardedProto : req.protocol;
  const host = String(req.headers['x-forwarded-host'] && LOOPBACK_RE.test(socketIp) ? req.headers['x-forwarded-host'] : req.get('host') || '').split(',')[0].trim();
  return HOST_RE.test(host) ? `${proto}://${host}` : '';
}

function requireAnilistUser(req, res) {
  if (!req.user) {
    res.status(401).json({ error: 'Connectez-vous à votre compte Animflix pour exporter votre planning.' });
    return false;
  }
  if (!req.user.anilist_token || !req.user.anilist_id) {
    res.status(409).json({ error: 'Liez votre compte AniList à votre compte Animflix pour exporter votre planning.' });
    return false;
  }
  return true;
}

/**
 * Lien d'abonnement de l'agenda (créé à la première demande)
 */
router.get('/api/calendar', (req, res) => {
  if (!requireAnilistUser(req, res)) return;
  res.setHeader('Cache-Control', 'no-store');
  res.json({ path: `/calendar/${store.getOrCreateToken(req.user.id)}.ics` });
});

// Nouveau lien : l'ancien cesse de fonctionner (lien partagé par erreur)
router.post('/api/calendar/reset', (req, res) => {
  if (!requireAnilistUser(req, res)) return;
  res.json({ path: `/calendar/${store.resetToken(req.user.id)}.ics` });
});

/**
 * Agenda .ics lu par les applications d'agenda (sans session : le jeton du lien fait office d'accès)
 */
router.get('/calendar/:file', async (req, res) => {
  const m = /^([a-f0-9]+)\.ics$/.exec(req.params.file || '');
  const token = m ? m[1] : null;
  const userId = isValidCalendarToken(token) ? store.userIdForToken(token) : null;
  const user = userId ? getUserById(userId) : null;
  if (!user) return res.status(404).type('text/plain').send('Agenda introuvable (lien révoqué ?)');
  if (!user.anilist_token || !user.anilist_id) {
    return res.status(404).type('text/plain').send('Compte AniList non lié');
  }
  try {
    const ics = await calendarForUser(user, {
      includePlanning: req.query.planning === '1',
      baseUrl: publicBaseUrl(req)
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="animflix.ics"');
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.send(ics);
  } catch (err) {
    console.warn(`📅 Agenda indisponible (utilisateur ${user.id}) : ${err.message}`);
    const status = err.response?.status;
    res.status(502).type('text/plain').send(status === 400 || status === 401
      ? "Le lien AniList de ce compte a expiré ou a été révoqué : reconnectez AniList dans Animflix."
      : 'AniList ne répond pas, réessayez plus tard.');
  }
});

export default router;
