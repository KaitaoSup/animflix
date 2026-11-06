import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { preloadTorrentFile, resetPreloadsForTests, PRELOAD_LIMITS } from '../src/services/torrserverService.js';

const magnet = (c) => `magnet:?xt=urn:btih:${c.repeat(40)}`;
const flush = () => new Promise(r => setImmediate(r));

// Requête TorrServer factice qu'on termine à la main
function controllableGet() {
  const calls = [];
  const httpGet = (url, opts) => new Promise((resolve, reject) => calls.push({ url, opts, resolve, reject }));
  return { calls, httpGet };
}

describe('preloadTorrentFile', () => {
  let origLog, origWarn;
  beforeEach(() => {
    resetPreloadsForTests();
    origLog = console.log;
    origWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
  });
  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
  });

  it('demande le préchargement du bon fichier à TorrServer, sans attendre la fin', async () => {
    const { calls, httpGet } = controllableGet();
    assert.deepEqual(preloadTorrentFile(magnet('a'), 3, { httpGet }), { status: 'started' });
    await flush();
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/stream\?link=magnet%3A%3Fxt%3Durn%3Abtih%3Aa{40}&index=3&preload$/);
    assert.equal(calls[0].opts.timeout, PRELOAD_LIMITS.TIMEOUT_MS);
    calls[0].resolve({ status: 200 });
    await flush();
  });

  it('pas de doublon pendant ni juste après un préchargement', async () => {
    const { calls, httpGet } = controllableGet();
    preloadTorrentFile(magnet('a'), 1, { httpGet });
    assert.equal(preloadTorrentFile(magnet('a'), 1, { httpGet }).status, 'running');
    await flush();
    calls[0].resolve({ status: 200 });
    await flush(); await flush();
    assert.equal(preloadTorrentFile(magnet('a'), 1, { httpGet }).status, 'done');
    // Un autre fichier du même torrent reste préchargeable
    assert.equal(preloadTorrentFile(magnet('a'), 2, { httpGet }).status, 'started');
    calls[1]?.resolve({ status: 200 });
    await flush();
  });

  it('limite le nombre de préchargements simultanés', async () => {
    const { calls, httpGet } = controllableGet();
    for (let i = 0; i < PRELOAD_LIMITS.MAX_PARALLEL; i++) {
      assert.equal(preloadTorrentFile(magnet('abcdef'[i]), 1, { httpGet }).status, 'started');
    }
    assert.equal(preloadTorrentFile(magnet('f'), 1, { httpGet }).status, 'busy');
    calls.forEach(c => c.resolve({ status: 200 }));
    await flush();
  });

  it('un échec libère la place et permet de réessayer', async () => {
    const { calls, httpGet } = controllableGet();
    preloadTorrentFile(magnet('a'), 1, { httpGet });
    await flush();
    calls[0].reject(new Error('timeout'));
    await flush(); await flush();
    assert.equal(preloadTorrentFile(magnet('a'), 1, { httpGet }).status, 'started');
    calls[1]?.resolve({ status: 200 });
    await flush();
  });
});
