// =========================================================================
// --- NOTIFICATIONS PUSH : NOUVEAUX ÉPISODES DES ANIMES EN COURS ---
// =========================================================================
//
// Le serveur surveille la liste AniList « En cours » des comptes abonnés et envoie une notification
// quand un nouvel épisode est disponible (src/services/episodeNotifier.js). Ici : abonnement de
// l'appareil, panneau des paramètres et ouverture de la fiche anime au clic sur une notification.

const PUSH_SW_READY_TIMEOUT_MS = 5000;

function isIosDevice() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandaloneApp() {
    return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isPushSupported() {
    return window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlBase64ToUint8Array(base64) {
    const padded = (base64 + '='.repeat((4 - base64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function arrayBufferToUrlBase64(buffer) {
    if (!buffer) return '';
    return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// navigator.serviceWorker.ready ne se résout jamais sans service worker : délai de garde
async function getPushRegistration() {
    if (!isPushSupported()) return null;
    return Promise.race([
        navigator.serviceWorker.ready,
        new Promise(resolve => setTimeout(() => resolve(null), PUSH_SW_READY_TIMEOUT_MS))
    ]);
}

async function getCurrentPushSubscription() {
    const reg = await getPushRegistration();
    return reg ? reg.pushManager.getSubscription() : null;
}

async function fetchPushConfig(endpoint) {
    const qs = endpoint ? '?endpoint=' + encodeURIComponent(endpoint) : '';
    const res = await fetch('/api/push/config' + qs, { headers: getAuthHeaders(), credentials: 'include' });
    if (!res.ok) throw new Error('Configuration des notifications indisponible');
    return res.json();
}

function preferredPushLang() {
    return localStorage.getItem('animflix_default_search_type') || 'vostfr';
}

async function sendPushSubscription(sub) {
    const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({ subscription: sub.toJSON(), lang: preferredPushLang() })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Abonnement refusé par le serveur');
    return data;
}

async function enableEpisodeNotifications() {
    try {
        if (!isPushSupported()) return;
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            showToast('🔕 Notifications refusées : autorisez-les dans les réglages du navigateur');
            return;
        }
        const reg = await getPushRegistration();
        if (!reg) throw new Error("Service worker indisponible : rechargez la page");
        const { publicKey } = await fetchPushConfig();

        let sub = await reg.pushManager.getSubscription();
        // Abonnement créé avec une autre clé serveur (clés VAPID régénérées) : il ne recevrait plus rien
        if (sub && arrayBufferToUrlBase64(sub.options?.applicationServerKey) !== publicKey) {
            await sub.unsubscribe().catch(() => {});
            sub = null;
        }
        if (!sub) {
            sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
        }
        const result = await sendPushSubscription(sub);
        showToast(result.anilistLinked
            ? '🔔 Notifications activées pour vos animes en cours'
            : '🔔 Notifications activées : liez AniList pour suivre vos animes en cours');
    } catch (err) {
        showToast('❌ ' + (err.message || "Impossible d'activer les notifications"));
    } finally {
        renderNotificationSettings();
    }
}

async function disableEpisodeNotifications() {
    try {
        await unbindPushSubscription();
        showToast('🔕 Notifications désactivées sur cet appareil');
    } catch (err) {
        showToast('❌ ' + (err.message || 'Désactivation impossible'));
    } finally {
        renderNotificationSettings();
    }
}

/**
 * Retire l'abonnement de cet appareil (serveur puis navigateur). Appelé aussi à la déconnexion :
 * l'appareil ne doit plus recevoir les épisodes d'un compte qui n'y est plus connecté.
 */
async function unbindPushSubscription() {
    const sub = await getCurrentPushSubscription().catch(() => null);
    if (!sub) return;
    await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: getAuthHeaders(),
        credentials: 'include',
        body: JSON.stringify({ endpoint: sub.endpoint })
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
}

async function sendTestNotification() {
    try {
        const res = await fetch('/api/push/test', { method: 'POST', headers: getAuthHeaders(), credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Envoi impossible');
        showToast('📨 Notification de test envoyée');
    } catch (err) {
        showToast('❌ ' + err.message);
    }
}

/**
 * Au démarrage et après connexion : rattache l'abonnement existant de cet appareil au compte connecté
 * (et à la langue de recherche actuelle, utilisée pour chercher les sources).
 */
async function refreshPushSubscription() {
    try {
        if (!isPushSupported() || Notification.permission !== 'granted') return;
        if (typeof currentAnimflixUser === 'undefined' || !currentAnimflixUser) return;
        const sub = await getCurrentPushSubscription();
        if (sub) await sendPushSubscription(sub);
    } catch (e) {
        console.warn('[Notifications] Mise à jour de l\'abonnement impossible :', e.message);
    }
}

async function renderNotificationSettings() {
    const el = document.getElementById('settingsNotifContent');
    if (!el) return;

    if (!isPushSupported()) {
        el.innerHTML = isIosDevice() && !isStandaloneApp()
            ? "Sur iPhone / iPad, installez d'abord Animflix sur l'écran d'accueil (Partager → « Sur l'écran d'accueil »), puis ouvrez-le depuis son icône."
            : "Ce navigateur ne prend pas en charge les notifications (une connexion HTTPS est nécessaire).";
        return;
    }
    if (typeof currentAnimflixUser === 'undefined' || !currentAnimflixUser) {
        el.innerHTML = `
            Connectez-vous à un compte Animflix pour être prévenu de la sortie des épisodes.
            <div style="margin-top: 8px;">
                <button type="button" class="btn-sub-style" style="padding: 5px 12px; font-size: 12px;" onclick="openAnimflixAuthModal('login')">Se connecter</button>
            </div>`;
        return;
    }

    let sub = null;
    let cfg = null;
    try {
        sub = await getCurrentPushSubscription();
        cfg = await fetchPushConfig(sub?.endpoint);
    } catch (e) {
        el.textContent = '⚠️ ' + e.message;
        return;
    }

    const enabled = !!(sub && cfg.subscribed && Notification.permission === 'granted');
    const anilistHint = cfg.anilistLinked ? '' : `
        <div style="color: #f5c518; margin-top: 6px;">
            ⚠️ Liez votre compte AniList : les notifications suivent votre liste « En cours ».
        </div>`;

    if (Notification.permission === 'denied') {
        el.innerHTML = `🔕 Notifications bloquées pour ce site : autorisez-les dans les réglages du navigateur.${anilistHint}`;
        return;
    }

    el.innerHTML = enabled
        ? `
            <span style="color: #46d369; font-weight: 600;">✓ Activées sur cet appareil</span>
            — vous êtes prévenu dès qu'un épisode de vos animes en cours est disponible.
            ${anilistHint}
            <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                <button type="button" class="btn-sub-style" style="padding: 5px 12px; font-size: 12px;" onclick="sendTestNotification()">📨 Tester</button>
                <button type="button" class="btn-sub-style" style="padding: 5px 12px; font-size: 12px;" onclick="disableEpisodeNotifications()">🔕 Désactiver</button>
            </div>`
        : `
            Recevez une notification dès qu'un nouvel épisode de vos animes en cours (AniList) est disponible.
            ${anilistHint}
            <div style="margin-top: 8px;">
                <button type="button" class="btn-sub-style" style="padding: 5px 12px; font-size: 12px;" onclick="enableEpisodeNotifications()">🔔 Activer sur cet appareil</button>
            </div>`;
}

// Clic sur une notification alors qu'Animflix est déjà ouvert : le service worker transmet la fiche à ouvrir
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'animflix-notification-open') return;
        if (msg.mediaId && typeof openAnimePage === 'function') {
            openAnimePage(Number(msg.mediaId), { ep: msg.episode ? Number(msg.episode) : null });
        } else if (msg.url) {
            window.location.href = msg.url;
        }
    });
}

window.enableEpisodeNotifications = enableEpisodeNotifications;
window.disableEpisodeNotifications = disableEpisodeNotifications;
window.sendTestNotification = sendTestNotification;
window.renderNotificationSettings = renderNotificationSettings;
window.refreshPushSubscription = refreshPushSubscription;
window.unbindPushSubscription = unbindPushSubscription;
