// =========================================================================
// --- SYNCHRONISATION MULTI-APPAREILS (HISTORIQUE, REPRISE, FAVORIS, PROFILS, PRÉFÉRENCES) ---
// =========================================================================
// Les données restent dans le localStorage (l'app marche hors connexion et sans compte). Pour un
// utilisateur connecté, elles sont en plus synchronisées avec le serveur (/api/sync) :
//  - envoi : on compare chaque élément à son « reflet » (empreinte au dernier échange) pour n'envoyer
//    que ce qui a changé, et une pierre tombale pour ce qui a disparu ;
//  - réception : on ne télécharge que les éléments modifiés depuis la dernière révision serveur connue ;
//  - conflit : le dernier modifié (updatedAt) l'emporte.

const SYNC_STATE_KEY = 'animflix_sync_state';
const SYNC_PUSH_BATCH = 50;          // éléments par requête (limite de taille des requêtes JSON)
const SYNC_MIN_INTERVAL_MS = 15000;  // pendant la lecture, la position change toutes les 3,5 s
const SYNC_POLL_INTERVAL_MS = 60000;

// Préférences communes à tous les appareils (le mode de lecture, la vitesse ou le mode TV restent propres à chacun)
const SYNCED_PREF_KEYS = [
    'animflix_default_search_type',
    'animflix_aniskip_mode',
    'animflix_autoplay_next',
    'animflix_pref_release_groups',
    'animflix_pref_resolution',
    'animflix_theme_color'
];

let cloudSyncRunning = null;    // Promise de la synchro en cours
let cloudSyncRerun = false;     // une modification est arrivée pendant la synchro
let cloudSyncTimer = null;
let cloudSyncPollTimer = null;
let cloudSyncLastRun = 0;

// Empreinte FNV-1a 32 bits : suffit à détecter un changement sans stocker une 2e copie des données
function syncHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

function isCloudSyncEnabled() {
    return !!(typeof currentAnimflixUser !== 'undefined' && currentAnimflixUser && currentAnimflixUser.id);
}

function loadSyncState() {
    try {
        const raw = localStorage.getItem(SYNC_STATE_KEY);
        if (raw) {
            const s = JSON.parse(raw);
            if (s && typeof s === 'object' && s.shadow) return s;
        }
    } catch (e) {}
    return { userId: null, rev: 0, shadow: {} };
}

function saveSyncState(state) {
    try {
        localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(state));
    } catch (e) {}
}

function readJsonArray(storageKey) {
    try {
        const parsed = JSON.parse(localStorage.getItem(storageKey) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

// --- COLLECTIONS SYNCHRONISÉES ---
// Chaque espace de noms correspond à une liste du localStorage : read() -> [{ key, data, updatedAt? }], write(Map key->data)

function historyStorageKeyFor(profileId) {
    return profileId === 'default' ? STORAGE_KEY_HISTORY : `animflix_playback_history_${profileId}`;
}

function favoritesStorageKeyFor(profileId) {
    return profileId === 'default' ? STORAGE_KEY_FAVORITES : `animflix_favorites_${profileId}`;
}

function arrayCollection(ns, storageKey, keyOf, sortList) {
    return {
        ns,
        read() {
            return readJsonArray(storageKey)
                .filter(item => item && keyOf(item))
                .map(item => ({ key: String(keyOf(item)), data: item, updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : null }));
        },
        write(map) {
            let list = [...map.values()];
            if (sortList) list = sortList(list);
            try {
                if (list.length === 0) localStorage.removeItem(storageKey);
                else localStorage.setItem(storageKey, JSON.stringify(list));
            } catch (e) {}
        }
    };
}

function getSyncCollection(ns) {
    if (ns === 'profiles') {
        return arrayCollection('profiles', STORAGE_KEY_PROFILES, p => p.id, list => {
            // Le profil principal existe toujours, en tête de liste
            const def = list.find(p => p.id === 'default') || { id: 'default', name: 'Principal', avatar: '🍿', isKid: false };
            return [def, ...list.filter(p => p.id !== 'default')];
        });
    }
    if (ns === 'prefs') {
        return {
            ns,
            read() {
                return SYNCED_PREF_KEYS
                    .map(k => ({ key: k, value: localStorage.getItem(k) }))
                    .filter(p => p.value !== null)
                    .map(p => ({ key: p.key, data: { value: p.value }, updatedAt: null }));
            },
            write(map) {
                SYNCED_PREF_KEYS.forEach(k => {
                    try {
                        const entry = map.get(k);
                        if (entry && typeof entry.value === 'string') localStorage.setItem(k, entry.value);
                        else localStorage.removeItem(k);
                    } catch (e) {}
                });
            }
        };
    }
    const m = /^(history|favorites|stats):([A-Za-z0-9_-]{1,64})$/.exec(ns);
    if (!m) return null;
    if (m[1] === 'stats') {
        // Journal du temps regardé (stats.js) : une entrée par jour × appareil × anime
        if (typeof statsStorageKeyFor !== 'function') return null;
        return arrayCollection(ns, statsStorageKeyFor(m[2]), e => e.key, list => trimWatchStats(list));
    }
    if (m[1] === 'history') {
        return arrayCollection(ns, historyStorageKeyFor(m[2]), h => h.key,
            list => list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50));
    }
    return arrayCollection(ns, favoritesStorageKeyFor(m[2]), f => f.id,
        list => list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)));
}

// Espaces de noms à examiner : ceux des profils existants + ceux déjà synchronisés (pour propager les suppressions)
function listSyncNamespaces(state) {
    const set = new Set(['profiles', 'prefs']);
    getUserProfiles().forEach(p => {
        if (/^[A-Za-z0-9_-]{1,64}$/.test(p.id)) {
            set.add(`history:${p.id}`);
            set.add(`favorites:${p.id}`);
            set.add(`stats:${p.id}`);
        }
    });
    Object.keys(state.shadow).forEach(ns => set.add(ns));
    return [...set].filter(ns => getSyncCollection(ns));
}

// --- ENVOI DES MODIFICATIONS LOCALES ---

function collectLocalChanges(state) {
    const changes = [];
    const now = Date.now();
    for (const ns of listSyncNamespaces(state)) {
        const shadow = state.shadow[ns] || {};
        const present = new Set();
        for (const item of getSyncCollection(ns).read()) {
            present.add(item.key);
            const h = syncHash(JSON.stringify(item.data));
            const prev = shadow[item.key];
            if (prev && prev.h === h) continue;
            changes.push({ ns, key: item.key, data: item.data, updatedAt: item.updatedAt || now, h });
        }
        for (const key of Object.keys(shadow)) {
            if (!present.has(key)) changes.push({ ns, key, deleted: true, updatedAt: now });
        }
    }
    return changes;
}

function setShadow(state, ns, key, data, updatedAt) {
    if (!state.shadow[ns]) state.shadow[ns] = {};
    if (data === null) {
        delete state.shadow[ns][key];
        if (Object.keys(state.shadow[ns]).length === 0) delete state.shadow[ns];
    } else {
        state.shadow[ns][key] = { h: syncHash(JSON.stringify(data)), t: updatedAt };
    }
}

async function pushLocalChanges(state) {
    const changes = collectLocalChanges(state);
    const serverWins = [];
    for (let i = 0; i < changes.length; i += SYNC_PUSH_BATCH) {
        const batch = changes.slice(i, i + SYNC_PUSH_BATCH);
        const res = await fetch('/api/sync', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include',
            body: JSON.stringify({ items: batch.map(({ h, ...item }) => item) })
        });
        if (!res.ok) throw new Error(`envoi refusé (HTTP ${res.status})`);
        const data = await res.json();
        batch.forEach(c => setShadow(state, c.ns, c.key, c.deleted ? null : c.data, c.updatedAt));
        if (Array.isArray(data.conflicts)) serverWins.push(...data.conflicts);
        saveSyncState(state);
    }
    return serverWins;
}

// --- RÉCEPTION DES MODIFICATIONS DISTANTES ---

// Applique des éléments venus du serveur. `force` : versions que le serveur a gardées face aux nôtres (plus récentes)
function applyRemoteItems(state, items, force = false) {
    const byNs = new Map();
    items.forEach(it => {
        if (!byNs.has(it.ns)) byNs.set(it.ns, []);
        byNs.get(it.ns).push(it);
    });

    const touched = new Set();
    for (const [ns, nsItems] of byNs) {
        const col = getSyncCollection(ns);
        if (!col) continue;
        const local = new Map(col.read().map(i => [i.key, i]));
        const map = new Map([...local].map(([k, i]) => [k, i.data]));
        const shadow = state.shadow[ns] || {};
        let changed = false;

        for (const it of nsItems) {
            const localItem = local.get(it.key);
            if (localItem && !force) {
                const prev = shadow[it.key];
                const unchangedSinceSync = prev && prev.h === syncHash(JSON.stringify(localItem.data));
                // Modifié ici depuis le dernier échange (pendant la synchro) : la version locale sera envoyée au prochain tour
                if (!unchangedSinceSync) continue;
                const localT = localItem.updatedAt || prev.t || 0;
                if (it.updatedAt < localT) continue;
            }
            if (it.deleted) {
                if (localItem) { map.delete(it.key); changed = true; }
                setShadow(state, ns, it.key, null);
            } else {
                // Écho de notre propre envoi (ou contenu identique) : rien à réécrire ni à réafficher
                if (!localItem || JSON.stringify(localItem.data) !== JSON.stringify(it.data)) {
                    map.set(it.key, it.data);
                    changed = true;
                }
                setShadow(state, ns, it.key, it.data, it.updatedAt);
            }
        }
        if (changed) {
            col.write(map);
            touched.add(ns);
        }
    }
    return touched;
}

async function pullRemoteChanges(state) {
    const touched = new Set();
    for (let guard = 0; guard < 50; guard++) {
        const res = await fetch('/api/sync?since=' + encodeURIComponent(state.rev || 0), {
            headers: getAuthHeaders(),
            credentials: 'include',
            cache: 'no-store'
        });
        if (!res.ok) throw new Error(`réception refusée (HTTP ${res.status})`);
        const data = await res.json();

        // Révision serveur inférieure à la nôtre : base serveur réinitialisée -> tout renvoyer
        if (typeof data.rev === 'number' && data.rev < (state.rev || 0)) {
            state.rev = 0;
            state.shadow = {};
            saveSyncState(state);
            return { touched, reset: true };
        }

        applyRemoteItems(state, data.items || []).forEach(ns => touched.add(ns));
        state.rev = data.rev || state.rev;
        saveSyncState(state);
        if (!data.more) break;
    }
    return { touched, reset: false };
}

function refreshUiAfterSync(touched) {
    if (touched.size === 0) return;
    const active = getActiveProfile().id;
    const affectsActive = touched.has('profiles') || touched.has(`history:${active}`) || touched.has(`favorites:${active}`);
    if (touched.has('prefs') && typeof loadUserSettings === 'function') loadUserSettings();
    if (touched.has('profiles') && typeof renderSettingsProfiles === 'function') renderSettingsProfiles();
    if (affectsActive && typeof renderHomeScreen === 'function') {
        const tab = typeof getActiveHomeTab === 'function' ? getActiveHomeTab() : 'home';
        if (tab === 'home' || tab === 'history' || tab === 'favorites') renderHomeScreen();
    }
    if (touched.has(`stats:${active}`) && typeof getActiveHomeTab === 'function' && getActiveHomeTab() === 'stats'
        && typeof renderHomeScreen === 'function') {
        renderHomeScreen();
    }
}

async function runCloudSync() {
    let state = loadSyncState();
    if (state.userId !== currentAnimflixUser.id) {
        // Nouveau compte sur ce navigateur : tout ce qui est local est envoyé puis fusionné avec le serveur
        state = { userId: currentAnimflixUser.id, rev: 0, shadow: {} };
        saveSyncState(state);
    }

    const conflicts = await pushLocalChanges(state);
    const touched = applyRemoteItems(state, conflicts, true);
    const pulled = await pullRemoteChanges(state);
    pulled.touched.forEach(ns => touched.add(ns));
    if (pulled.reset) {
        await pushLocalChanges(state);
        const again = await pullRemoteChanges(state);
        again.touched.forEach(ns => touched.add(ns));
    }

    // Une liste réécrite peut avoir été tronquée (historique limité à 50) : le prochain envoi propagera ces retraits
    saveSyncState(state);
    refreshUiAfterSync(touched);
}

/**
 * Lance une synchro maintenant (ou juste après celle en cours). Sans effet si l'utilisateur n'est pas connecté.
 */
function cloudSyncNow() {
    if (!isCloudSyncEnabled()) return Promise.resolve();
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
    if (cloudSyncRunning) {
        cloudSyncRerun = true;
        return cloudSyncRunning;
    }
    cloudSyncLastRun = Date.now();
    cloudSyncRunning = runCloudSync()
        .catch(err => console.warn('[Synchro] Échec :', err.message))
        .finally(() => {
            cloudSyncRunning = null;
            if (cloudSyncRerun) {
                cloudSyncRerun = false;
                scheduleCloudSync();
            }
        });
    return cloudSyncRunning;
}

/**
 * À appeler après chaque modification locale : regroupe les écritures (au plus une synchro toutes les 15 s)
 */
function scheduleCloudSync() {
    if (!isCloudSyncEnabled() || cloudSyncTimer) return;
    const wait = Math.max(1000, SYNC_MIN_INTERVAL_MS - (Date.now() - cloudSyncLastRun));
    cloudSyncTimer = setTimeout(() => {
        cloudSyncTimer = null;
        cloudSyncNow();
    }, wait);
}

// Fermeture / mise en arrière-plan : envoi immédiat de ce qui reste (keepalive survit à la fermeture de l'onglet)
function flushCloudSyncOnHide() {
    if (!isCloudSyncEnabled() || cloudSyncRunning) return;
    const state = loadSyncState();
    if (state.userId !== currentAnimflixUser.id) return;
    const changes = collectLocalChanges(state).slice(0, SYNC_PUSH_BATCH);
    if (changes.length === 0) return;
    try {
        fetch('/api/sync', {
            method: 'POST',
            headers: getAuthHeaders(),
            credentials: 'include',
            keepalive: true,
            body: JSON.stringify({ items: changes.map(({ h, ...item }) => item) })
        });
        // Pas de mise à jour du reflet : la prochaine synchro renverra ces éléments, sans effet côté serveur
    } catch (e) {}
}

/**
 * Appelée par auth.js à chaque changement de session (démarrage, connexion, inscription, déconnexion)
 */
function onAnimflixAuthChanged() {
    if (typeof refreshPushSubscription === 'function') refreshPushSubscription();
    clearTimeout(cloudSyncTimer);
    cloudSyncTimer = null;
    clearInterval(cloudSyncPollTimer);
    cloudSyncPollTimer = null;

    if (!isCloudSyncEnabled()) {
        // Déconnexion : les données restent sur cet appareil, seul l'état de synchro est oublié
        try { localStorage.removeItem(SYNC_STATE_KEY); } catch (e) {}
        return;
    }
    cloudSyncNow();
    cloudSyncPollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') cloudSyncNow();
    }, SYNC_POLL_INTERVAL_MS);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cloudSyncNow();
    else flushCloudSyncOnHide();
});
window.addEventListener('pagehide', flushCloudSyncOnHide);

window.cloudSyncNow = cloudSyncNow;
window.scheduleCloudSync = scheduleCloudSync;
window.onAnimflixAuthChanged = onAnimflixAuthChanged;
