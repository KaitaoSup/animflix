import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import Database from 'better-sqlite3';
import { createSyncStore } from '../src/services/syncStore.js';

const FRONT = path.join(process.cwd(), 'public/js');
const historySrc = fs.readFileSync(path.join(FRONT, 'history.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(FRONT, 'sync.js'), 'utf8');

function createServer() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1), (2);');
  return createSyncStore(db);
}

/**
 * Un « appareil » : history.js + sync.js chargés dans un contexte isolé, avec son propre localStorage
 * et un fetch qui appelle directement le stockage serveur (comme le feraient les routes /api/sync).
 */
function createDevice(server, userId = 1) {
  const storage = new Map();
  const renders = { home: 0 };
  const localStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url, 'http://animflix.local');
    if (u.pathname !== '/api/sync') return json({ error: 'not found' }, 404);
    // Aller-retour JSON, comme sur le réseau
    // Utilisateur de la session courante de l'appareil (comme req.user côté serveur)
    const uid = vm.runInContext('currentAnimflixUser.id', ctx);
    if ((opts.method || 'GET') === 'POST') return json(JSON.parse(JSON.stringify(server.push(uid, JSON.parse(opts.body).items))));
    return json(JSON.parse(JSON.stringify(server.pull(uid, u.searchParams.get('since')))));
  };
  const noop = () => {};
  const ctx = vm.createContext({
    localStorage,
    fetch,
    console: { warn: (...a) => { throw new Error(a.join(' ')); }, log: noop },
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    URL,
    window: { addEventListener: noop },
    document: { addEventListener: noop, getElementById: () => null, visibilityState: 'visible' },
    renderHomeScreen: () => { renders.home++; },
    showToast: noop
  });
  vm.runInContext(`
    let currentAnimflixUser = { id: ${userId}, username: 'test' };
    function getAuthHeaders() { return { 'Content-Type': 'application/json' }; }
  `, ctx);
  vm.runInContext(historySrc, ctx);
  vm.runInContext(syncSrc, ctx);

  const run = code => vm.runInContext(code, ctx);
  // Les tableaux créés dans le contexte vm ont un autre prototype Array : copie JSON pour les comparer
  const read = code => JSON.parse(JSON.stringify(run(code)));
  return {
    ctx,
    renders,
    sync: () => run('cloudSyncNow()'),
    history: () => read('getPlaybackHistory()'),
    favorites: () => read('getFavorites()'),
    profiles: () => read('getUserProfiles()'),
    setHistory: list => { ctx.__list = list; run('savePlaybackHistoryList(__list)'); },
    setFavorites: list => { ctx.__list = list; run('saveFavoritesList(__list)'); },
    switchProfile: id => { localStorage.setItem('animflix_active_profile_id', id); },
    storage
  };
}

const entry = (key, currentTime, updatedAt, extra = {}) => ({
  key, magnet: `magnet:?xt=urn:btih:${key}`, fileIndex: 1, animeName: 'Frieren', episode: 'Épisode 1',
  currentTime, duration: 1440, progressPct: Math.round(currentTime / 14.4), completed: false, updatedAt, ...extra
});

describe('Synchro multi-appareils (front + stockage serveur)', () => {
  test("la position de lecture d'un appareil est reprise sur l'autre", async () => {
    const server = createServer();
    const pc = createDevice(server);
    const phone = createDevice(server);

    pc.setHistory([entry('aaa_f1', 600, 1000)]);
    await pc.sync();
    await phone.sync();
    assert.equal(phone.history()[0].currentTime, 600);

    // Le téléphone continue l'épisode : le PC récupère la nouvelle position
    phone.setHistory([entry('aaa_f1', 900, 2000)]);
    await phone.sync();
    await pc.sync();
    assert.equal(pc.history().length, 1);
    assert.equal(pc.history()[0].currentTime, 900);
  });

  test('fusion : les épisodes vus sur chaque appareil sont réunis, triés du plus récent au plus ancien', async () => {
    const server = createServer();
    const a = createDevice(server);
    const b = createDevice(server);
    a.setHistory([entry('ep1_f1', 100, 1000)]);
    b.setHistory([entry('ep2_f1', 200, 3000)]);
    await a.sync();
    await b.sync();
    await a.sync();
    assert.deepEqual(a.history().map(h => h.key), ['ep2_f1', 'ep1_f1']);
    assert.deepEqual(b.history().map(h => h.key), ['ep2_f1', 'ep1_f1']);
  });

  test('une suppression (favori retiré) se propage', async () => {
    const server = createServer();
    const a = createDevice(server);
    const b = createDevice(server);
    a.setFavorites([{ id: 'frieren', animeName: 'Frieren', addedAt: 1 }, { id: 'dandadan', animeName: 'Dandadan', addedAt: 2 }]);
    await a.sync();
    await b.sync();
    assert.equal(b.favorites().length, 2);

    b.setFavorites(b.favorites().filter(f => f.id !== 'frieren'));
    await b.sync();
    await a.sync();
    assert.deepEqual(a.favorites().map(f => f.id), ['dandadan']);
  });

  test('conflit : la modification la plus récente gagne, même si elle a été envoyée en premier', async () => {
    const server = createServer();
    const a = createDevice(server);
    const b = createDevice(server);
    a.setHistory([entry('k_f1', 100, 1000)]);
    await a.sync();
    await b.sync();

    a.setHistory([entry('k_f1', 800, 5000)]);   // plus récent
    b.setHistory([entry('k_f1', 300, 4000)]);   // plus ancien, envoyé après
    await a.sync();
    await b.sync();
    await a.sync();
    assert.equal(a.history()[0].currentTime, 800);
    assert.equal(b.history()[0].currentTime, 800);
  });

  test('un nouveau profil et son historique apparaissent sur les autres appareils', async () => {
    const server = createServer();
    const a = createDevice(server);
    const b = createDevice(server);
    a.ctx.__p = null;
    vm.runInContext("__p = createUserProfile('Léa', '🦊', true)", a.ctx);
    const profileId = a.ctx.__p;
    a.switchProfile(profileId);
    a.setHistory([entry('kid_f1', 50, 1000)]);
    await a.sync();
    await b.sync();

    assert.deepEqual(b.profiles().map(p => p.id), ['default', profileId]);
    assert.equal(b.history().length, 0, 'le profil principal de B reste vide');
    b.switchProfile(profileId);
    assert.equal(b.history()[0].key, 'kid_f1');
  });

  test("l'écho de ses propres envois ne réaffiche pas l'accueil (lecture en cours)", async () => {
    const server = createServer();
    const a = createDevice(server);
    a.setHistory([entry('k_f1', 100, 1000)]);
    await a.sync();
    const before = a.renders.home;
    // Pendant la lecture, la position change et chaque synchro renvoie l'élément : son écho ne doit rien redessiner
    a.setHistory([entry('k_f1', 130, 2000)]);
    await a.sync();
    a.setHistory([entry('k_f1', 160, 3000)]);
    await a.sync();
    assert.equal(a.renders.home, before);
    assert.equal(a.history()[0].currentTime, 160);
  });

  test('changement de compte sur le même navigateur : les données locales rejoignent le nouveau compte', async () => {
    const server = createServer();
    const a = createDevice(server);
    a.setHistory([entry('k_f1', 100, 1000)]);
    await a.sync();
    assert.equal(server.pull(2, 0).items.length, 0);

    vm.runInContext('currentAnimflixUser = { id: 2, username: "autre" }', a.ctx);
    await a.sync();
    assert.equal(JSON.parse(a.storage.get('animflix_sync_state')).userId, 2);
    assert.deepEqual(server.pull(2, 0).items.map(i => i.key), ['k_f1']);
  });
});
