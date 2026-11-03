import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidMagnet, isValidInfoHash, validateTorrentParams } from '../src/utils/network.js';

const HEX = 'a'.repeat(40);
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
const NYAA_MAGNET = `magnet:?xt=urn:btih:${HEX}&dn=%5BSubsPlease%5D%20Test%20-%2001&tr=http%3A%2F%2Fnyaa.tracker.wf%3A7777%2Fannounce`;

describe('isValidInfoHash', () => {
  test('accepte hex 40 et base32 32', () => {
    assert.equal(isValidInfoHash(HEX), true);
    assert.equal(isValidInfoHash(HEX.toUpperCase()), true);
    assert.equal(isValidInfoHash(B32), true);
  });
  test('refuse le reste', () => {
    for (const v of ['', 'abc', HEX + 'a', 'g'.repeat(40), undefined, null, 42, [HEX]]) {
      assert.equal(isValidInfoHash(v), false, String(v));
    }
  });
});

describe('isValidMagnet', () => {
  test('accepte un magnet Nyaa', () => {
    assert.equal(isValidMagnet(NYAA_MAGNET), true);
    assert.equal(isValidMagnet(`MAGNET:?xt=urn:btih:${B32}`), true);
  });
  test('refuse URL, fichiers et magnets sans btih valide', () => {
    for (const v of [
      'http://127.0.0.1:8080/evil.torrent',
      'https://nyaa.si/download/1.torrent',
      'file:///etc/passwd',
      HEX,
      'magnet:?dn=test',
      'magnet:?xt=urn:btih:zzz',
      `magnet:?xt=urn:sha1:${HEX}`,
      `magnet:?xt=urn:btih:${HEX}` + '&x='.repeat(2000),
      [NYAA_MAGNET],
      undefined
    ]) {
      assert.equal(isValidMagnet(v), false, String(v).slice(0, 60));
    }
  });
});

describe('validateTorrentParams', () => {
  function run(query = {}, body = undefined) {
    let status = null, nextCalled = false;
    const res = { status(c) { status = c; return this; }, json() { return this; } };
    validateTorrentParams({ query, body }, res, () => { nextCalled = true; });
    return { status, nextCalled };
  }

  test('laisse passer les requêtes sans magnet/hash ou valides', () => {
    assert.equal(run({}).nextCalled, true);
    assert.equal(run({ magnet: NYAA_MAGNET, fileIndex: '2' }).nextCalled, true);
    assert.equal(run({}, { hash: HEX }).nextCalled, true);
    assert.equal(run({ magnet: '' }).nextCalled, true); // laissé aux routes (400 "manquant")
  });

  test('rejette en 400 les valeurs invalides (query ou body)', () => {
    assert.deepEqual(run({ magnet: 'http://evil/x.torrent' }), { status: 400, nextCalled: false });
    assert.deepEqual(run({ magnet: [NYAA_MAGNET, NYAA_MAGNET] }), { status: 400, nextCalled: false });
    assert.deepEqual(run({}, { hash: '../../etc' }), { status: 400, nextCalled: false });
  });
});
