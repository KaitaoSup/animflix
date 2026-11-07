import webpush from 'web-push';
import { db, getServerSetting, setServerSetting } from '../../database.js';
import { createPushStore } from './pushStore.js';

/**
 * Envoi des notifications Web Push (protocole standard, chiffré de bout en bout jusqu'au navigateur).
 *
 * Les clés VAPID identifient ce serveur auprès des services de push : générées au premier démarrage et
 * conservées dans server_settings (elles ne doivent pas changer, sinon tous les abonnements deviennent
 * invalides). VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY dans .env les remplacent si besoin.
 */

export const pushStore = createPushStore(db);

let vapidKeys = null;

export function getVapidKeys() {
  if (vapidKeys) return vapidKeys;
  let publicKey = process.env.VAPID_PUBLIC_KEY || getServerSetting('vapid_public_key');
  let privateKey = process.env.VAPID_PRIVATE_KEY || getServerSetting('vapid_private_key');
  if (!publicKey || !privateKey) {
    ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
    setServerSetting('vapid_public_key', publicKey);
    setServerSetting('vapid_private_key', privateKey);
    console.log('🔔 Clés VAPID générées pour les notifications push');
  }
  // Contact demandé par les services de push (Apple refuse les adresses en localhost).
  // Lu ici et non au chargement du module : le .env est chargé après les imports (animflix.js)
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:animflix@example.com', publicKey, privateKey);
  vapidKeys = { publicKey, privateKey };
  return vapidKeys;
}

/**
 * Envoie une notification à tous les appareils abonnés d'un utilisateur.
 * payload : { title, body, icon?, url?, tag?, mediaId?, episode? }
 * Retourne le nombre d'appareils atteints. Les abonnements expirés sont supprimés.
 */
export async function sendPushToUser(userId, payload, { ttl = 24 * 60 * 60 } = {}) {
  getVapidKeys();
  const subs = pushStore.listForUser(userId);
  const body = JSON.stringify(payload);
  let delivered = 0;

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        body,
        { TTL: ttl, urgency: 'normal', timeout: 10000 }
      );
      delivered++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        pushStore.removeEndpoint(s.endpoint); // désabonné côté navigateur, ou abonnement expiré
      } else {
        console.warn(`⚠️ Notification push non envoyée (${err.statusCode || err.code || 'erreur'}) :`, err.body || err.message);
      }
    }
  }));
  return delivered;
}
