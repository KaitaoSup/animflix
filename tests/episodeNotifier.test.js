import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Base SQLite jetable : database.js (importé par pushService) lit DATABASE_PATH à l'import
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-notifier-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const { createPushStore, normalizeSubscription, isAllowedPushEndpoint, PUSH_LIMITS } = await import('../src/services/pushStore.js');
const {
  createEpisodeNotifier, torrentTitleHasEpisode, searchTitlesForMedia, buildEpisodePayload, NOTIFIER_CONFIG
} = await import('../src/services/episodeNotifier.js');

const FCM = 'https://fcm.googleapis.com/fcm/send/abc';
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

function freshStore() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, anilist_id INTEGER, anilist_token TEXT);
           INSERT INTO users VALUES (1, 111, 'tok1'), (2, 222, 'tok2'), (3, NULL, NULL);`);
  return createPushStore(db);
}

describe('pushStore — validation des abonnements', () => {
  test('seuls les services de push connus, en HTTPS', () => {
    assert.ok(isAllowedPushEndpoint(FCM));
    assert.ok(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
    assert.ok(isAllowedPushEndpoint('https://web.push.apple.com/QGx'));
    assert.ok(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=x'));
    assert.ok(!isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'));
    assert.ok(!isAllowedPushEndpoint('https://evil.example.com/fcm.googleapis.com'));
    assert.ok(!isAllowedPushEndpoint('https://fcm.googleapis.com.evil.com/x'));
    assert.ok(!isAllowedPushEndpoint('https://127.0.0.1:8090/stream'));
    assert.ok(!isAllowedPushEndpoint('https://fcm.googleapis.com/' + 'x'.repeat(PUSH_LIMITS.MAX_ENDPOINT_LENGTH)));
  });

  test('clés obligatoires et langue normalisée', () => {
    assert.deepEqual(normalizeSubscription({ endpoint: FCM, keys: KEYS }, 'vf'), { endpoint: FCM, ...KEYS, lang: 'vf' });
    assert.equal(normalizeSubscription({ endpoint: FCM, keys: KEYS }, 'klingon').lang, 'vostfr');
    assert.equal(normalizeSubscription({ endpoint: FCM, keys: { p256dh: KEYS.p256dh } }), null);
    assert.equal(normalizeSubscription({ endpoint: FCM, keys: { ...KEYS, auth: 'a b' } }), null);
    assert.equal(normalizeSubscription(null), null);
  });
});

describe('pushStore — stockage', () => {
  test('abonnement, réattribution à un autre compte, désabonnement', () => {
    const store = freshStore();
    store.subscribe(1, { endpoint: FCM, ...KEYS, lang: 'vostfr' }, 1000);
    assert.ok(store.isSubscribed(1, FCM));

    // Même appareil, autre compte : il change de propriétaire et repart de zéro
    store.subscribe(2, { endpoint: FCM, ...KEYS, lang: 'vf' }, 5000);
    assert.ok(!store.isSubscribed(1, FCM));
    assert.equal(store.listForUser(2)[0].created_at, 5000);

    // Un autre compte ne peut pas retirer l'abonnement
    assert.equal(store.unsubscribe(1, FCM), false);
    assert.equal(store.unsubscribe(2, FCM), true);
    assert.equal(store.listForUser(2).length, 0);
  });

  test('le renouvellement par le même compte garde la date d\'origine', () => {
    const store = freshStore();
    store.subscribe(1, { endpoint: FCM, ...KEYS, lang: 'vostfr' }, 1000);
    store.subscribe(1, { endpoint: FCM, ...KEYS, lang: 'vf' }, 9000);
    const [sub] = store.listForUser(1);
    assert.equal(sub.created_at, 1000);
    assert.equal(sub.lang, 'vf');
  });

  test('nombre d\'appareils limité par compte (les plus anciens sont retirés)', () => {
    const store = freshStore();
    for (let i = 0; i < PUSH_LIMITS.MAX_SUBSCRIPTIONS_PER_USER + 3; i++) {
      store.subscribe(1, { endpoint: `${FCM}${i}`, ...KEYS, lang: 'vostfr' }, 1000 + i);
    }
    const subs = store.listForUser(1);
    assert.equal(subs.length, PUSH_LIMITS.MAX_SUBSCRIPTIONS_PER_USER);
    assert.ok(!subs.some(s => s.endpoint === `${FCM}0`));
  });

  test('seuls les comptes abonnés avec AniList lié sont surveillés', () => {
    const store = freshStore();
    store.subscribe(1, { endpoint: FCM + 'a', ...KEYS, lang: 'vostfr' }, 2000);
    store.subscribe(1, { endpoint: FCM + 'b', ...KEYS, lang: 'vf' }, 3000);
    store.subscribe(3, { endpoint: FCM + 'c', ...KEYS, lang: 'vostfr' }, 2000);
    const users = store.usersToNotify();
    assert.equal(users.length, 1);
    assert.equal(users[0].id, 1);
    assert.equal(users[0].since, 2000); // plus ancien appareil
    assert.equal(users[0].lang, 'vf');  // langue de l'appareil le plus récent
  });

  test('épisodes notifiés : mémorisés puis purgés', () => {
    const store = freshStore();
    store.markNotified(1, 42, 5, 1000);
    assert.ok(store.wasNotified(1, 42, 5));
    assert.ok(!store.wasNotified(2, 42, 5));
    assert.equal(store.pruneNotified(1000 + PUSH_LIMITS.NOTIFIED_MAX_AGE_MS + 1), 1);
    assert.ok(!store.wasNotified(1, 42, 5));
  });
});

describe('episodeNotifier — reconnaissance des torrents', () => {
  test('épisode seul reconnu dans les formats courants', () => {
    assert.ok(torrentTitleHasEpisode('[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv', 5));
    assert.ok(torrentTitleHasEpisode('[Erai-raws] Sousou no Frieren - 05v2 [1080p][Multiple Subtitle]', 5));
    assert.ok(torrentTitleHasEpisode('Sousou no Frieren S01E05 VOSTFR 1080p', 5));
    assert.ok(torrentTitleHasEpisode('Frieren Episode 12 VOSTFR', 12));
    assert.ok(torrentTitleHasEpisode('[Tsundere-Raws] Frieren - 105 [1080p]', 105));
  });

  test('autre épisode, packs et batchs écartés', () => {
    assert.ok(!torrentTitleHasEpisode('[SubsPlease] Sousou no Frieren - 15 (1080p)', 5));
    assert.ok(!torrentTitleHasEpisode('[SubsPlease] Sousou no Frieren - 05 (1080p)', 50));
    assert.ok(!torrentTitleHasEpisode('[Judas] Sousou no Frieren (01-12) [1080p] [Batch]', 5));
    assert.ok(!torrentTitleHasEpisode('Sousou no Frieren - 01 ~ 12 [1080p]', 1));
    assert.ok(!torrentTitleHasEpisode('Sousou no Frieren - 01-12 [1080p]', 1));
    assert.ok(!torrentTitleHasEpisode('Sousou no Frieren EP01-12 VOSTFR', 1));
    assert.ok(!torrentTitleHasEpisode('', 1));
    assert.ok(!torrentTitleHasEpisode('Frieren - 05', 0));
  });

  test('titres de recherche : rōmaji puis anglais, sans doublon ni ponctuation gênante', () => {
    assert.deepEqual(
      searchTitlesForMedia({ title: { romaji: 'Sousou no Frieren', english: "Frieren: Beyond Journey’s End", userPreferred: 'Sousou no Frieren' } }),
      ['Sousou no Frieren', "Frieren Beyond Journey's End"]
    );
  });

  test('notification : fiche de l\'anime sur le bon épisode', () => {
    const p = buildEpisodePayload({ id: 154587, title: { english: 'Frieren' }, coverImage: { large: 'c.jpg' } }, 5, true);
    assert.equal(p.url, '/#/anime/154587?ep=5');
    assert.equal(p.tag, 'animflix-ep-154587-5');
    assert.equal(p.icon, 'c.jpg');
    assert.match(p.body, /épisode 5 est disponible/);
    assert.match(buildEpisodePayload({ id: 1, title: {} }, 2, false).body, /pas encore de source/);
  });
});

describe('episodeNotifier — cycle de vérification', () => {
  const NOW_S = 2_000_000_000;
  const MEDIA = { id: 42, episodes: 12, title: { romaji: 'Kimi no Anime', english: 'Your Anime' }, coverImage: { large: 'x.jpg' } };

  function setup({ progress = 4, airingAgoS = 3600, torrents = [], since = (NOW_S - 86400) * 1000, episode = 5 } = {}) {
    const store = freshStore();
    store.subscribe(1, { endpoint: FCM, ...KEYS, lang: 'vostfr' }, since);
    const sent = [];
    const searches = [];
    const notifier = createEpisodeNotifier({
      store,
      now: () => NOW_S * 1000,
      log: { warn() {} },
      fetchAnilist: async (query, vars, token) => {
        if (query.includes('MediaListCollection')) {
          assert.equal(vars.userId, 111);
          assert.equal(token, 'tok1');
          return { MediaListCollection: { lists: [{ entries: [{ progress, media: MEDIA }] }] } };
        }
        assert.deepEqual(vars.ids, [42]);
        assert.equal(vars.to - vars.from, NOTIFIER_CONFIG.LOOKBACK_S);
        return { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ mediaId: 42, episode, airingAt: NOW_S - airingAgoS }] } };
      },
      searchTorrents: async (q, lang) => { searches.push([q, lang]); return torrents; },
      sendPush: async (userId, payload) => { sent.push({ userId, payload }); return 1; }
    });
    return { store, notifier, sent, searches };
  }

  const freshTorrent = { title: '[SubsPlease] Kimi no Anime - 05 (1080p)', pubDate: new Date((NOW_S - 1800) * 1000).toUTCString() };

  test('source trouvée : notification « disponible », une seule fois', async () => {
    const { notifier, sent, searches } = setup({ torrents: [freshTorrent] });
    assert.deepEqual(await notifier.runOnce(), { sent: 1 });
    assert.equal(sent[0].userId, 1);
    assert.match(sent[0].payload.body, /disponible/);
    assert.deepEqual(searches[0], ['Kimi no Anime', 'vostfr']);

    assert.deepEqual(await notifier.runOnce(), { sent: 0 });
    assert.equal(sent.length, 1);
  });

  test('pas encore de source : on attend, puis « sorti » après le délai de grâce', async () => {
    let ctx = setup({ airingAgoS: 3600 });
    assert.deepEqual(await ctx.notifier.runOnce(), { sent: 0 });

    ctx = setup({ airingAgoS: NOTIFIER_CONFIG.NO_SOURCE_GRACE_S + 60 });
    assert.deepEqual(await ctx.notifier.runOnce(), { sent: 1 });
    assert.match(ctx.sent[0].payload.body, /pas encore de source/);
  });

  test('un ancien torrent du même numéro (publié avant la diffusion) ne compte pas', async () => {
    const old = { title: '[SubsPlease] Kimi no Anime - 05 (1080p)', pubDate: new Date((NOW_S - 400 * 86400) * 1000).toUTCString() };
    const { notifier, sent } = setup({ torrents: [old] });
    assert.deepEqual(await notifier.runOnce(), { sent: 0 });
    assert.equal(sent.length, 0);
  });

  test('épisode déjà vu, ou diffusé avant l\'abonnement : pas de notification', async () => {
    let ctx = setup({ progress: 5, torrents: [freshTorrent] });
    assert.deepEqual(await ctx.notifier.runOnce(), { sent: 0 });

    ctx = setup({ since: NOW_S * 1000, torrents: [freshTorrent] });
    assert.deepEqual(await ctx.notifier.runOnce(), { sent: 0 });
  });

  test('envoi échoué sur tous les appareils : réessayé au cycle suivant', async () => {
    const ctx = setup({ torrents: [freshTorrent] });
    const store = ctx.store;
    const notifier = createEpisodeNotifier({
      store,
      now: () => NOW_S * 1000,
      log: { warn() {} },
      fetchAnilist: async (query) => query.includes('MediaListCollection')
        ? { MediaListCollection: { lists: [{ entries: [{ progress: 4, media: MEDIA }] }] } }
        : { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ mediaId: 42, episode: 5, airingAt: NOW_S - 3600 }] } },
      searchTorrents: async () => [freshTorrent],
      sendPush: async () => 0
    });
    assert.deepEqual(await notifier.runOnce(), { sent: 0 });
    assert.ok(!store.wasNotified(1, 42, 5));
  });

  test('erreur AniList : le cycle s\'arrête proprement', async () => {
    const store = freshStore();
    store.subscribe(1, { endpoint: FCM, ...KEYS, lang: 'vostfr' }, 0);
    const notifier = createEpisodeNotifier({
      store,
      log: { warn() {} },
      fetchAnilist: async () => { throw new Error('429 Too Many Requests'); },
      searchTorrents: async () => [],
      sendPush: async () => 1
    });
    assert.deepEqual(await notifier.runOnce(), { sent: 0 });
  });
});
