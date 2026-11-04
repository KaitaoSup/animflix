import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

// Script classique du front : chargé dans un contexte isolé avec un localStorage factice
function loadReleasePrefs(storage = {}) {
  const localStorage = {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; }
  };
  const ctx = vm.createContext({ localStorage, window: {}, document: { getElementById: () => null } });
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'public/js/release-prefs.js'), 'utf8'), ctx);
  return ctx;
}

describe('Préférences de release', () => {
  const lib = loadReleasePrefs();

  test('extractReleaseGroup : crochets en tête ou suffixe « -GROUPE »', () => {
    assert.equal(lib.extractReleaseGroup('[Erai-raws] Frieren - 01 [1080p][Multiple Subtitle]'), 'Erai-raws');
    assert.equal(lib.extractReleaseGroup('【SubsPlease】 Dandadan - 05 (1080p)'), 'SubsPlease');
    assert.equal(lib.extractReleaseGroup('Frieren.S01E01.VOSTFR.1080p.WEB.x264-Tsundere.mkv'), 'Tsundere');
    assert.equal(lib.extractReleaseGroup('Frieren 01 VOSTFR'), null);
    assert.equal(lib.extractReleaseGroup(null), null);
  });

  test('parseReleaseGroupList : nettoie, dédoublonne sans tenir compte de la casse ni des tirets', () => {
    assert.deepEqual([...lib.parseReleaseGroupList(' Erai-raws, [SubsPlease] ; erai raws\nTsundere-Raws ,, ')],
      ['Erai-raws', 'SubsPlease', 'Tsundere-Raws']);
  });

  test('tri : vivant > groupe préféré (dans l’ordre) > résolution voulue > seeders', () => {
    const prefs = { groups: ['SubsPlease', 'Erai-raws'], resolution: '1080p' };
    const torrents = [
      { titre: '[Random] Ep 01 [1080p]', seeders: 900 },
      { titre: '[Erai-raws] Ep 01 [1080p]', seeders: 50 },
      { titre: '[SubsPlease] Ep 01 (720p)', seeders: 10 },
      { titre: '[SubsPlease] Ep 01 (1080p)', seeders: 5 },
      { titre: '[SubsPlease] Ep 01 (1080p) dead', seeders: 0 },
      { titre: '[Random] Ep 01 [720p]', seeders: 2000 }
    ];
    const sorted = [...torrents].sort((a, b) => lib.compareByReleasePrefs(a, b, prefs)).map(t => t.titre);
    assert.deepEqual(sorted, [
      '[SubsPlease] Ep 01 (1080p)',
      '[SubsPlease] Ep 01 (720p)',
      '[Erai-raws] Ep 01 [1080p]',
      '[Random] Ep 01 [1080p]',
      '[Random] Ep 01 [720p]',
      '[SubsPlease] Ep 01 (1080p) dead'
    ]);
  });

  test('tri par défaut « Mes préférences » seulement si des préférences existent', () => {
    assert.equal(loadReleasePrefs({}).getDefaultSearchSort(), 'seeders');
    assert.equal(loadReleasePrefs({ animflix_pref_release_groups: 'Erai-raws' }).getDefaultSearchSort(), 'preferred');
    assert.equal(loadReleasePrefs({ animflix_pref_resolution: '720p' }).getDefaultSearchSort(), 'preferred');
    assert.equal(loadReleasePrefs({ animflix_pref_resolution: 'any' }).getDefaultSearchSort(), 'seeders');
  });
});
