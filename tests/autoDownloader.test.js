import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Base SQLite jetable : database.js (importé indirectement) lit DATABASE_PATH à l'import
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-autodl-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const {
  createAutoDownloadStore, createAutoDownloader, pickBestTorrent, pickEpisodeFile, normalizePrefs,
  buildReadyPayload, extractReleaseGroup, AUTO_DOWNLOAD_CONFIG
} = await import('../src/services/autoDownloader.js');

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);
const AIRED_S = NOW_S - 3600; // diffusé il y a 1 h
const MEDIA = { id: 42, title: { romaji: 'Kimi no Anime', english: 'Your Anime' }, coverImage: { large: 'https://img/42.jpg' } };

const fresh = (title, seeders = 50, extra = {}) => ({
  titre: title,
  lienMagnet: `magnet:?xt=urn:btih:${Buffer.from(title).toString('hex').slice(0, 40).padEnd(40, 'a')}`,
  seeders,
  pubDate: new Date((AIRED_S + 600) * 1000).toUTCString(),
  ...extra
});

function freshStore() {
  return createAutoDownloadStore(new Database(':memory:'));
}

describe('autoDownloader — choix de la source', () => {
  test('épisode seul, publié après la diffusion, avec des seeders', () => {
    const list = [
      fresh('[SubsPlease] Kimi no Anime - 04 (1080p)', 500),                                          // mauvais épisode
      fresh('[SubsPlease] Kimi no Anime - 01 ~ 12 (1080p) [Batch]', 900),                             // pack
      fresh('[Old] Kimi no Anime - 05 (1080p)', 999, { pubDate: new Date((NOW_S - 400 * 86400) * 1000).toUTCString() }), // ancienne saison
      fresh('[Dead] Kimi no Anime - 05 (1080p)', 0),                                                  // sans seeders
      fresh('[NoDate] Kimi no Anime - 05 (1080p)', 999, { pubDate: null }),                           // date inconnue
      fresh('[Erai-raws] Kimi no Anime - 05 [720p]', 30)
    ];
    const best = pickBestTorrent(list, { episode: 5, airingAtS: AIRED_S });
    assert.equal(best.titre, '[Erai-raws] Kimi no Anime - 05 [720p]');
    assert.equal(pickBestTorrent(list.slice(0, 5), { episode: 5, airingAtS: AIRED_S }), null);
  });

  test('groupe préféré, puis résolution voulue, puis seeders ; sources signalées en dernier', () => {
    const a = fresh('[SubsPlease] Kimi no Anime - 05 (1080p)', 500);
    const b = fresh('[Erai-raws] Kimi no Anime - 05 [720p]', 30);
    const c = fresh('[Tsundere-Raws] Kimi no Anime - 05 [1080p]', 10);
    assert.equal(pickBestTorrent([a, b, c], { episode: 5, airingAtS: AIRED_S }).titre, a.titre);
    assert.equal(pickBestTorrent([a, b, c], { episode: 5, airingAtS: AIRED_S, prefs: { groups: ['erai raws'] } }).titre, b.titre);
    assert.equal(pickBestTorrent([b, c], { episode: 5, airingAtS: AIRED_S, prefs: { resolution: '1080p' } }).titre, c.titre);
    const reported = { ...a, reported: { fails: 2 } };
    assert.equal(pickBestTorrent([reported, c], { episode: 5, airingAtS: AIRED_S }).titre, c.titre);
  });

  test('fichier de l\'épisode dans le torrent', () => {
    assert.equal(pickEpisodeFile([], 5), 1);
    assert.equal(pickEpisodeFile([{ id: 1, episode: null, length: 10 }, { id: 2, episode: null, length: 900 }], 5), 2);
    assert.equal(pickEpisodeFile([{ id: 1, episode: 5, length: 10 }, { id: 2, episode: null, length: 900 }], 5), 1);
  });

  test('préférences nettoyées', () => {
    assert.deepEqual(normalizePrefs({ lang: 'xx', resolution: '8k', groups: '[SubsPlease], subsplease ; Erai-raws' }),
      { lang: 'vostfr', resolution: 'any', groups: ['SubsPlease', 'Erai-raws'] });
    assert.equal(extractReleaseGroup('Titre.S01E05.1080p.WEB.x264-GRP.mkv'), 'GRP');
  });
});

describe('autoDownloader — stockage', () => {
  test('activer, lister, désactiver', () => {
    const store = freshStore();
    store.set(1, 42, { title: 'Your Anime', poster: 'javascript:alert(1)', lang: 'vf', groups: ['A'] }, NOW);
    const sub = store.get(1, 42);
    assert.equal(sub.lang, 'vf');
    assert.equal(sub.poster, null);
    assert.deepEqual(sub.groups, ['A']);
    assert.equal(store.countForUser(1), 1);
    store.set(1, 42, { title: 'Your Anime', lang: 'vostfr' }, NOW + 1);
    assert.equal(store.countForUser(1), 1);
    assert.equal(store.get(1, 42).lang, 'vostfr');
    assert.ok(store.remove(1, 42));
    assert.equal(store.get(1, 42), null);
  });
});

function harness({ torrents = [fresh('[SubsPlease] Kimi no Anime - 05 (1080p)')], airingAt = AIRED_S, kept = false, enqueueResult } = {}) {
  const store = freshStore();
  const enqueued = [];
  const searches = [];
  const downloader = createAutoDownloader({
    store,
    enqueue: (req, userId) => {
      enqueued.push({ req, userId });
      return enqueueResult || { item: { id: `dl${enqueued.length}` }, created: true };
    },
    isAlreadyKept: () => kept,
    getFiles: async () => ({ files: [{ id: 3, episode: 5, length: 100 }] }),
    fetchAnilist: async () => ({ Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ episode: 5, airingAt, media: MEDIA }] } }),
    searchTorrents: async (q, lang) => { searches.push({ q, lang }); return torrents; },
    now: () => NOW,
    log: {}
  });
  return { store, downloader, enqueued, searches };
}

describe('autoDownloader — cycle', () => {
  test('ajoute l\'épisode une seule fois, même suivi par deux comptes', async () => {
    const h = harness();
    h.store.set(1, 42, { lang: 'vostfr' }, NOW - 86400000);
    h.store.set(2, 42, { lang: 'vostfr' }, NOW - 1000);
    assert.equal((await h.downloader.runOnce()).queued, 1);
    assert.equal(h.enqueued.length, 1);
    assert.equal(h.enqueued[0].userId, 1);
    assert.equal(h.enqueued[0].req.fileIndex, 3);
    assert.equal(h.enqueued[0].req.mediaId, 42);
    assert.equal(h.enqueued[0].req.episode, 5);
    assert.equal(h.searches[0].lang, 'vostfr');
    assert.equal((await h.downloader.runOnce()).queued, 0);
    assert.equal(h.enqueued.length, 1);
  });

  test('une autre langue est un autre téléchargement', async () => {
    const h = harness();
    h.store.set(1, 42, { lang: 'vostfr' }, NOW - 1000);
    h.store.set(2, 42, { lang: 'vf' }, NOW - 1000);
    assert.equal((await h.downloader.runOnce()).queued, 2);
  });

  test('épisode diffusé bien avant l\'activation : ignoré', async () => {
    const h = harness({ airingAt: NOW_S - AUTO_DOWNLOAD_CONFIG.BEFORE_ENABLE_TOLERANCE_S - 7200 });
    h.store.set(1, 42, {}, NOW);
    assert.equal((await h.downloader.runOnce()).queued, 0);
    assert.equal(h.searches.length, 0);
  });

  test('déjà gardé à la main : rien de plus', async () => {
    const h = harness({ kept: true });
    h.store.set(1, 42, {}, NOW - 1000);
    await h.downloader.runOnce();
    assert.equal(h.enqueued.length, 0);
    assert.ok(h.store.wasHandled(42, 5, 'vostfr'));
  });

  test('pas encore de source : réessayé, puis abandonné après 48 h', async () => {
    const h = harness({ torrents: [] });
    h.store.set(1, 42, {}, NOW - 1000);
    await h.downloader.runOnce();
    assert.ok(!h.store.wasHandled(42, 5, 'vostfr'));

    const late = harness({ torrents: [], airingAt: NOW_S - AUTO_DOWNLOAD_CONFIG.GIVE_UP_AFTER_S - 60 });
    late.store.set(1, 42, {}, NOW - 3 * 86400000);
    await late.downloader.runOnce();
    assert.ok(late.store.wasHandled(42, 5, 'vostfr'));
  });

  test('refus du gestionnaire (disque plein…) : réessayé au passage suivant', async () => {
    const h = harness({ enqueueResult: { error: 'plein', status: 409 } });
    h.store.set(1, 42, {}, NOW - 1000);
    assert.equal((await h.downloader.runOnce()).queued, 0);
    assert.ok(!h.store.wasHandled(42, 5, 'vostfr'));
  });

  test('notification « prêt » pour les comptes qui suivent l\'anime', async () => {
    const h = harness();
    h.store.set(1, 42, {}, NOW - 1000);
    h.store.set(2, 42, {}, NOW - 1000);
    await h.downloader.runOnce();
    const ready = buildReadyPayload(h.store, { id: 'dl1', mediaId: 42, episode: 5, animeName: 'Your Anime' });
    assert.deepEqual(ready.users.sort(), [1, 2]);
    assert.match(ready.payload.url, /#\/anime\/42\?ep=5$/);
    // Téléchargement manuel : pas de notification
    assert.equal(buildReadyPayload(h.store, { id: 'manuel', mediaId: 42, episode: 6 }), null);
  });
});
