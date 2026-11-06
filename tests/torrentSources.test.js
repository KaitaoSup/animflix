import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Base SQLite jetable : database.js lit DATABASE_PATH à l'import, d'où les imports dynamiques
// (des imports statiques seraient évalués avant cette affectation et ouvriraient animflix.db)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');

const { deduplicateTorrents } = await import('../src/services/torrentAggregator.js');
const { formatBytes } = await import('../src/services/torznabService.js');
const { db, getServerSetting, setServerSetting, getAllServerSettings } = await import('../database.js');

after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Torrent Sources & Résilience Multi-sources', () => {

  describe('formatBytes', () => {
    it('formate correctement les octets bruts en unités lisibles', () => {
      assert.equal(formatBytes(0), '0 B');
      assert.equal(formatBytes(1024), '1 KiB');
      assert.equal(formatBytes(1048576), '1 MiB');
      assert.equal(formatBytes(1500000000), '1.4 GiB');
      assert.equal(formatBytes('2147483648'), '2 GiB');
      assert.equal(formatBytes(null), 'N/A');
      assert.equal(formatBytes(undefined), 'N/A');
    });
  });

  describe('deduplicateTorrents', () => {
    it('déduplique les torrents ayant le même infoHash (insensible à la casse)', () => {
      const items = [
        {
          title: '[Erai-raws] Dandadan - 05 [1080p].mkv',
          infoHash: 'ABCD1234EF567890ABCD1234EF567890ABCD1234',
          seeders: 120,
          source: 'nyaa'
        },
        {
          title: '[Erai-raws] Dandadan - 05 (1080p)',
          infoHash: 'abcd1234ef567890abcd1234ef567890abcd1234', // même hash en minuscule
          seeders: 80,
          source: 'tokyotosho'
        }
      ];

      const deduplicated = deduplicateTorrents(items);
      assert.equal(deduplicated.length, 1);
      assert.equal(deduplicated[0].source, 'nyaa');
      assert.equal(deduplicated[0].seeders, 120);
    });

    it('déduplique les torrents ayant le même titre normalisé en conservant le plus vivant', () => {
      const items = [
        {
          title: '[SubsPlease] Dandadan - 05 (1080p) [F688B778].mkv',
          infoHash: '1111111111111111111111111111111111111111',
          seeders: 25,
          source: 'tokyotosho'
        },
        {
          title: '[SubsPlease] Dandadan - 05 (1080p) [F688B778].mkv',
          infoHash: '2222222222222222222222222222222222222222',
          seeders: 250,
          source: 'nyaa'
        }
      ];

      const deduplicated = deduplicateTorrents(items);
      assert.equal(deduplicated.length, 1);
      assert.equal(deduplicated[0].seeders, 250);
      assert.equal(deduplicated[0].source, 'nyaa');
    });

    it('ignore les éléments null ou sans titre', () => {
      const items = [
        null,
        {},
        { title: 'Titre Valide', infoHash: 'hash1', seeders: 10 }
      ];
      const deduplicated = deduplicateTorrents(items);
      assert.equal(deduplicated.length, 1);
      assert.equal(deduplicated[0].title, 'Titre Valide');
    });
  });

  describe('Server Settings Persistence (SQLite)', () => {
    it('enregistre et lit les paramètres persistants du serveur', () => {
      setServerSetting('test_mode_torrent', 'aggregate');
      assert.equal(getServerSetting('test_mode_torrent'), 'aggregate');

      setServerSetting('test_mode_torrent', 'resilient');
      assert.equal(getServerSetting('test_mode_torrent'), 'resilient');

      assert.equal(getServerSetting('cle_inexistante', 'defaut'), 'defaut');

      const all = getAllServerSettings();
      assert.equal(all.test_mode_torrent, 'resilient');
    });
  });

  describe('Torznab & TokyoTosho services', () => {
    it('testTorznabConnection signale immédiatement une URL manquante', async () => {
      const { testTorznabConnection } = await import('../src/services/torznabService.js');
      const res = await testTorznabConnection({ url: '', apiKey: '' });
      assert.equal(res.success, false);
      assert.match(res.message, /URL Torznab non renseignée/i);
    });

    it('fetchTokyoToshoRss renvoie un tableau vide sur requête vide', async () => {
      const { fetchTokyoToshoRss } = await import('../src/services/tokyoToshoService.js');
      const res = await fetchTokyoToshoRss('');
      assert.deepEqual(res, []);
    });

    it('fetchTorznab renvoie un tableau vide si Torznab n’est pas configuré', async () => {
      const { fetchTorznab } = await import('../src/services/torznabService.js');
      const res = await fetchTorznab('dandadan', 'vostfr', { url: '' });
      assert.deepEqual(res, []);
    });
  });

});
