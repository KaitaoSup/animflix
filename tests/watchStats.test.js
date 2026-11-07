import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { isValidNamespace } from '../src/services/syncStore.js';

// Les tableaux créés dans le contexte vm n'ont pas le prototype de ce module : comparaison sur une copie
const plain = (x) => JSON.parse(JSON.stringify(x));
const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
}

// stats.js dans un contexte isolé, avec un faux lecteur vidéo et une horloge contrôlée
function loadStats({ storage = {}, media = null, item = { animeName: 'Frieren' } } = {}) {
  const localStorage = makeStorage(storage);
  const video = { paused: false, ended: false, readyState: 4 };
  let now = Date.UTC(2026, 10, 7, 18, 0, 0);
  const calls = { sync: 0 };
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const ctx = vm.createContext({
    localStorage,
    window: { _currentPlayingEpisodeKey: 'ep-1' },
    document: { getElementById: (id) => (id === 'videoPlayer' ? video : null), addEventListener() {}, body: { contains: () => true } },
    Date: FakeDate,
    Intl, Math, JSON, Number, String, Array, Set, Map,
    currentAnilistMedia: media,
    currentAnimeItem: item,
    getAnimeDetails: () => ({}),
    getActiveProfile: () => ({ id: 'default' }),
    scheduleCloudSync: () => { calls.sync++; }
  });
  ctx.window.addEventListener = () => {};
  vm.runInContext(read('public/js/stats.js'), ctx);
  return { ctx, video, localStorage, calls, advance: (ms) => { now += ms; } };
}

function entries(localStorage, key = 'animflix_watch_stats') {
  return JSON.parse(localStorage.getItem(key) || '[]');
}

describe('Stats — comptage pendant la lecture', () => {
  const MEDIA = { id: 154587, title: { english: 'Frieren' }, coverImage: { large: 'f.jpg' }, genres: ['Adventure', 'Drama', 'Fantasy'] };

  // timeupdate toutes les 250 ms pendant `seconds` secondes
  function play(env, seconds, position = 100, duration = 1440) {
    for (let i = 0; i < seconds * 4; i++) {
      env.advance(250);
      env.ctx.recordWatchTick(position + i / 4, duration);
    }
  }

  test('temps réel de lecture compté, avec la fiche AniList', () => {
    const env = loadStats({ media: MEDIA });
    play(env, 90);
    env.ctx.flushWatchStats();
    const [e] = entries(env.localStorage);
    assert.ok(Math.abs(e.seconds - 90) <= 1, `${e.seconds} s`);
    assert.equal(e.animeKey, 'a154587');
    assert.equal(e.day, '2026-11-07');
    assert.deepEqual(plain(e.genres), MEDIA.genres);
    assert.equal(e.title, 'Frieren');
    assert.ok(env.calls.sync > 0);
  });

  test('pause et longues interruptions non comptées', () => {
    const env = loadStats({ media: MEDIA });
    play(env, 10);
    env.video.paused = true;
    play(env, 60);
    env.video.paused = false;
    env.advance(10 * 60 * 1000); // onglet en veille
    play(env, 10);
    env.ctx.flushWatchStats();
    const [e] = entries(env.localStorage);
    assert.ok(e.seconds >= 19 && e.seconds <= 21, `${e.seconds} s`);
  });

  test('épisode compté une seule fois à 85 %', () => {
    const env = loadStats({ media: MEDIA });
    env.advance(250);
    env.ctx.recordWatchTick(1000, 1440);
    env.advance(250);
    env.ctx.recordWatchTick(1230, 1440);
    env.advance(250);
    env.ctx.recordWatchTick(1300, 1440);
    env.ctx.flushWatchStats();
    assert.equal(entries(env.localStorage)[0].episodes, 1);
  });

  test('sans fiche AniList : nom de l\'anime, ou correspondance AniList mémorisée', () => {
    let env = loadStats({ item: { animeName: 'Sousou no Frieren' } });
    play(env, 5);
    env.ctx.flushWatchStats();
    assert.equal(entries(env.localStorage)[0].animeKey, 'nsousou no frieren');

    env = loadStats({ item: { animeName: 'Sousou no Frieren' }, storage: { 'anilist_map_sousou no frieren': '154587' } });
    play(env, 5);
    env.ctx.flushWatchStats();
    assert.equal(entries(env.localStorage)[0].animeKey, 'a154587');
  });

  test('une entrée par appareil : identifiant stable et dans la clé', () => {
    const env = loadStats({ media: MEDIA });
    play(env, 5);
    env.ctx.flushWatchStats();
    play(env, 5);
    env.ctx.flushWatchStats();
    const list = entries(env.localStorage);
    assert.equal(list.length, 1);
    const device = env.localStorage.getItem('animflix_device_id');
    assert.match(device, /^[a-z0-9]{6,16}$/);
    assert.equal(list[0].key, `2026-11-07|${device}|a154587`);
  });
});

describe('Stats — calcul', () => {
  const { ctx } = loadStats();
  const e = (day, animeKey, seconds, extra = {}) => ({ key: `${day}|dev|${animeKey}`, day, animeKey, seconds, episodes: 0, ...extra });

  test('totaux, fenêtres de 7 et 30 jours, plusieurs appareils additionnés', () => {
    const s = ctx.computeWatchStats([
      e('2026-11-07', 'a1', 1200, { episodes: 1 }),
      { ...e('2026-11-07', 'a1', 600), key: '2026-11-07|tel|a1', episodes: 1 },
      e('2026-11-02', 'a2', 3000),
      e('2026-10-01', 'a2', 6000)
    ], '2026-11-07');
    assert.equal(s.totalSeconds, 10800);
    assert.equal(s.totalEpisodes, 2);
    assert.equal(s.weekSeconds, 4800);
    assert.equal(s.monthSeconds, 4800);
    assert.equal(s.activity.length, 30);
    assert.equal(s.activity[29].day, '2026-11-07');
    assert.equal(s.activity[29].seconds, 1800);
    assert.equal(s.animeCount, 2);
  });

  test('séries de jours : en cours (jusqu\'à hier) et record, au-delà d\'un changement de mois', () => {
    const days = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-04', '2026-11-05', '2026-11-06'];
    const s = ctx.computeWatchStats(days.map(d => e(d, 'a1', 600)), '2026-11-07');
    assert.equal(s.longestStreak, 5);
    assert.equal(s.currentStreak, 3); // rien aujourd'hui : la série d'hier compte encore

    const broken = ctx.computeWatchStats([e('2026-11-05', 'a1', 600)], '2026-11-07');
    assert.equal(broken.currentStreak, 0);

    const tooShort = ctx.computeWatchStats([e('2026-11-07', 'a1', 30)], '2026-11-07');
    assert.equal(tooShort.currentStreak, 0); // moins d'une minute
  });

  test('animes classés par temps, métadonnées les plus récentes', () => {
    const s = ctx.computeWatchStats([
      e('2026-11-01', 'a1', 100, { title: 'Ancien titre', updatedAt: 1 }),
      e('2026-11-02', 'a1', 100, { title: 'Frieren', mediaId: 1, cover: 'f.jpg', updatedAt: 2 }),
      e('2026-11-02', 'a2', 500, { title: 'Dandadan', updatedAt: 3 })
    ], '2026-11-07');
    assert.deepEqual(plain(s.topAnime.map(a => [a.title, a.seconds])), [['Dandadan', 500], ['Frieren', 200]]);
    assert.equal(s.topAnime[1].mediaId, 1);
    assert.equal(s.topAnime[1].lastDay, '2026-11-02');
  });

  test('genres pondérés par le temps regardé', () => {
    const s = ctx.computeWatchStats([
      e('2026-11-01', 'a1', 300, { genres: ['Action', 'Fantasy'] }),
      e('2026-11-01', 'a2', 100, { genres: ['Romance'] }),
      e('2026-11-01', 'a3', 999) // sans genres : ignoré dans les parts
    ], '2026-11-07');
    assert.deepEqual(plain(s.topGenres.map(g => g.genre)), ['Action', 'Fantasy', 'Romance']);
    assert.equal(s.topGenres[0].share, 0.75);
    assert.equal(s.topGenres[2].share, 0.25);
  });

  test('durées lisibles', () => {
    assert.equal(ctx.formatWatchDuration(0), '0 min');
    assert.equal(ctx.formatWatchDuration(45 * 60), '45 min');
    assert.equal(ctx.formatWatchDuration(3600), '1 h');
    assert.equal(ctx.formatWatchDuration(3600 + 5 * 60), '1 h 05');
  });

  test('journal borné, journées les plus anciennes oubliées', () => {
    const list = [];
    for (let i = 0; i < 3100; i++) list.push(e(ctx.statsShiftDay('2026-11-07', -i), 'a1', 60));
    const kept = ctx.trimWatchStats(list);
    assert.equal(kept.length, 3000);
    assert.equal(kept[0].day, '2026-11-07');
  });
});

describe('Stats — synchronisation', () => {
  test('l\'espace de noms stats:<profil> est accepté par le serveur', () => {
    assert.ok(isValidNamespace('stats:default'));
    assert.ok(isValidNamespace('stats:p_lx3k9a'));
    assert.ok(!isValidNamespace('stats:'));
    assert.ok(!isValidNamespace('stats:../x'));
  });
});
