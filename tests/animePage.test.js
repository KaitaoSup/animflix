import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; }
  };
}

// Fiche anime : scripts classiques chargés dans un contexte isolé (préférences de release + page)
function loadAnimePage(storage = {}) {
  const ctx = vm.createContext({
    localStorage: makeStorage(storage),
    window: {},
    document: { getElementById: () => null },
    // Même règle que search.js
    isTorrentPack: (t) => /integrale|intégrale|pack|batch|complete/i.test(t.titre || '') ||
      /\b(?:e|ep|épisode|episode)\s*0*(\d+)\s*[-~]\s*0*(\d+)\b/i.test(t.titre || '')
  });
  vm.runInContext(read('public/js/release-prefs.js'), ctx);
  vm.runInContext(read('public/js/anilist/anime-page.js'), ctx);
  return ctx;
}

function loadRouter(hash = '') {
  const replaced = [];
  const ctx = vm.createContext({
    window: { addEventListener: () => {} },
    document: { readyState: 'complete', getElementById: () => null },
    history: { state: null, replaceState: (s, t, url) => replaced.push(url), pushState: () => {} },
    sessionStorage: makeStorage(),
    location: { hash, pathname: '/', search: '', href: '/' + hash },
    URLSearchParams
  });
  ctx.window.location = ctx.location;
  vm.runInContext(read('public/js/router.js').replace(/window\.location/g, 'location'), ctx);
  return { router: ctx.window.AppRouter, replaced };
}

const media = (title, extra = {}) => ({ id: 1, title: { english: title, romaji: title }, ...extra });

describe('Fiche anime : choix du torrent par épisode', () => {
  const lib = loadAnimePage({ animflix_pref_release_groups: 'SubsPlease' });

  test('prend le groupe préféré parmi les torrents vivants de l’épisode', () => {
    const torrents = [
      { titre: '[Erai-raws] Frieren - 05 [1080p]', seeders: 400 },
      { titre: '[SubsPlease] Frieren - 05 (1080p)', seeders: 30 },
      { titre: '[SubsPlease] Frieren - 06 (1080p)', seeders: 90 }
    ];
    const pick = lib.pickTorrentForEpisode(torrents, 5, media('Frieren'));
    assert.equal(pick.kind, 'single');
    assert.equal(pick.torrent.titre, '[SubsPlease] Frieren - 05 (1080p)');
  });

  test('ignore les torrents sans seeders et ceux d’une autre saison', () => {
    const torrents = [
      { titre: '[SubsPlease] Frieren S2 - 05 (1080p)', seeders: 0 },
      { titre: '[Group] Frieren - 05 [1080p]', seeders: 50 }
    ];
    assert.equal(lib.pickTorrentForEpisode(torrents, 5, media('Frieren Season 2')).torrent.titre, '[Group] Frieren - 05 [1080p]');
    assert.equal(lib.pickTorrentForEpisode([{ titre: '[A] Frieren S2 - 05', seeders: 10 }], 5, media('Frieren')), null);
    assert.equal(lib.pickTorrentForEpisode([{ titre: '[A] Frieren - 05', seeders: 0 }], 5, media('Frieren')), null);
  });

  test('sans numéro explicite, un torrent n’est pas pris pour l’épisode 1', () => {
    assert.equal(lib.pickTorrentForEpisode([{ titre: '[A] Frieren [1080p]', seeders: 10 }], 1, media('Frieren')), null);
  });

  test('se replie sur un pack qui contient l’épisode', () => {
    const torrents = [
      { titre: '[A] Frieren E01-E12 [1080p]', episode: 'Épisodes 1-12', seeders: 20 },
      { titre: '[B] Frieren - 03 [720p]', seeders: 5 }
    ];
    const pick = lib.pickTorrentForEpisode(torrents, 7, media('Frieren'));
    assert.equal(pick.kind, 'pack');
    assert.match(pick.torrent.titre, /E01-E12/);
  });
});

describe('Fiche anime : packs de saison', () => {
  const lib = loadAnimePage();

  test('« S2 - 05 » est un épisode de la saison 2, pas une plage de saisons', () => {
    const pick = lib.pickTorrentForEpisode([{ titre: '[A] Frieren S2 - 05 (1080p)', seeders: 10 }], 5, media('Frieren Season 2'));
    assert.equal(pick.kind, 'single');
  });

  test('saison 1 introuvable en épisodes seuls : pack mono-saison avant pack multi-saisons', () => {
    const torrents = [
      { titre: 'Frieren Beyond Journeys End S02E01 VOSTFR 1080p', seeders: 80 },
      { titre: '[X] Sousou No Frieren S01 + S02 BDRIP 1080p VOSTFR', seeders: 90 },
      { titre: 'Sousou.No.Frieren.S01.VOSTFR.1080p.WEBRiP.x265-KAF', seeders: 12 },
      { titre: 'Sousou.No.Frieren.S02.VOSTFR.1080p.WEBRiP.x265-KAF', seeders: 40 }
    ];
    const pick = lib.pickTorrentForEpisode(torrents, 1, media('Frieren'));
    assert.equal(pick.kind, 'pack');
    assert.equal(pick.torrent.titre, 'Sousou.No.Frieren.S01.VOSTFR.1080p.WEBRiP.x265-KAF');

    const multiOnly = lib.pickTorrentForEpisode(torrents.slice(0, 2), 3, media('Frieren'));
    assert.match(multiOnly.torrent.titre, /S01 \+ S02/);
  });

  test('disponibilité : un pack de saison couvre tous les épisodes diffusés', () => {
    const avail = lib.computeAvailability([
      { titre: 'Sousou.No.Frieren.S01.VOSTFR.1080p-KAF', seeders: 5 },
      { titre: '[A] Frieren - 03 [1080p]', seeders: 5 }
    ], media('Frieren'), 4);
    assert.deepEqual([...avail.entries()].sort((a, b) => a[0] - b[0]).map(([e, k]) => `${e}${k[0]}`), ['1p', '2p', '3s', '4p']);
  });
});

describe('Routeur', () => {
  test('parse les routes et ignore les hashs inconnus', () => {
    const { router } = loadRouter();
    const home = router.parse('/');
    assert.equal(home.name, 'home');
    assert.equal(home.tab, 'home');
    assert.equal(router.parse('/schedule').tab, 'schedule');
    assert.equal(router.parse('/search?q=Dan%20Da%20Dan&type=vf').query.q, 'Dan Da Dan');
    const anime = router.parse('/anime/154587?ep=5');
    assert.equal(anime.name, 'anime');
    assert.equal(anime.id, 154587);
    assert.equal(anime.query.ep, '5');
    const watch = router.parse('/watch/ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD/3');
    assert.equal(watch.name, 'watch');
    assert.equal(watch.hash, 'abcdefabcdefabcdefabcdefabcdefabcdefabcd');
    assert.equal(watch.fileIndex, 3);
    assert.equal(router.parse('/watch/pas-un-hash/1').name, 'home');
    assert.equal(router.parse('/n-importe-quoi').name, 'home');
  });

  test('construit des URL relisibles par parse', () => {
    const { router } = loadRouter();
    assert.equal(router.searchPath('Frieren', 'vostfr'), '/search?q=Frieren');
    assert.equal(router.searchPath('Frieren', 'vf'), '/search?q=Frieren&type=vf');
    assert.equal(router.animePath(12, 4), '/anime/12?ep=4');
    assert.equal(router.homePath('home'), '/');
    assert.equal(router.parse(router.searchPath('JoJo’s & co', 'vf')).query.q, 'JoJo’s & co');
  });

  test('un ancien lien #detail est nettoyé au chargement', () => {
    const { replaced } = loadRouter('#detail');
    assert.deepEqual(replaced, ['/']);
  });
});
