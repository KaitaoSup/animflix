import { Router } from 'express';
import { getVapidKeys, pushStore, sendPushToUser } from '../services/pushService.js';
import { normalizeSubscription } from '../services/pushStore.js';

const router = Router();

function requireUser(req, res) {
  if (!req.user) {
    res.status(401).json({ error: "Connectez-vous à Animflix pour recevoir les notifications." });
    return false;
  }
  return true;
}

/**
 * Clé publique VAPID (nécessaire au navigateur pour s'abonner) et état de l'appareil
 */
router.get('/api/push/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const endpoint = typeof req.query.endpoint === 'string' ? req.query.endpoint : null;
  res.json({
    publicKey: getVapidKeys().publicKey,
    loggedIn: !!req.user,
    anilistLinked: !!(req.user?.anilist_id && req.user?.anilist_token),
    subscribed: !!(req.user && endpoint && pushStore.isSubscribed(req.user.id, endpoint))
  });
});

/**
 * Abonnement de cet appareil (ou mise à jour : langue des sources, compte connecté)
 */
router.post('/api/push/subscribe', (req, res) => {
  if (!requireUser(req, res)) return;
  const sub = normalizeSubscription(req.body?.subscription, req.body?.lang);
  if (!sub) {
    return res.status(400).json({ error: "Abonnement push invalide ou service de notification non reconnu." });
  }
  pushStore.subscribe(req.user.id, sub);
  res.json({ success: true, anilistLinked: !!(req.user.anilist_id && req.user.anilist_token) });
});

router.post('/api/push/unsubscribe', (req, res) => {
  if (!requireUser(req, res)) return;
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') {
    return res.status(400).json({ error: "Endpoint manquant" });
  }
  res.json({ success: pushStore.unsubscribe(req.user.id, endpoint) });
});

/**
 * Notification de test sur tous les appareils abonnés
 */
router.post('/api/push/test', async (req, res) => {
  if (!requireUser(req, res)) return;
  const delivered = await sendPushToUser(req.user.id, {
    title: '🔔 Animflix',
    body: 'Les notifications fonctionnent ! Vous serez prévenu à la sortie des épisodes de vos animes en cours.',
    icon: '/icons/icon-192.png',
    url: '/#/',
    tag: 'animflix-test'
  }, { ttl: 60 });
  if (!delivered) {
    return res.status(502).json({ error: "Aucun appareil n'a pu être joint. Réactivez les notifications sur cet appareil." });
  }
  res.json({ success: true, delivered });
});

export default router;
