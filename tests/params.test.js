import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaybackParams, parseTrackIndex, parseFileIndex, isValidPlayId } from '../src/utils/params.js';

describe('parsePlaybackParams', () => {
  test('valeurs par défaut si absentes', () => {
    assert.deepEqual(parsePlaybackParams({}), { fileIndex: 1, audioIndex: null, seekSeconds: 0, audioOffset: 0 });
  });

  test('valeurs valides conservées', () => {
    assert.deepEqual(
      parsePlaybackParams({ fileIndex: '3', audioIndex: '1', ss: '125.5', audioOffset: '-0.3' }),
      { fileIndex: 3, audioIndex: 1, seekSeconds: 125.5, audioOffset: -0.3 }
    );
  });

  test('valeurs illisibles → défaut (jamais NaN/Infinity transmis à FFmpeg)', () => {
    assert.deepEqual(
      parsePlaybackParams({ fileIndex: 'abc', audioIndex: 'NaN', ss: 'Infinity', audioOffset: '1e999' }),
      { fileIndex: 1, audioIndex: null, seekSeconds: 0, audioOffset: 0 }
    );
    assert.equal(parsePlaybackParams({ audioIndex: 'undefined' }).audioIndex, null);
    assert.equal(parsePlaybackParams({ audioIndex: ['1', '2'] }).audioIndex, null);
    assert.equal(parsePlaybackParams({ ss: '10s' }).seekSeconds, 0);
  });

  test('valeurs hors bornes ramenées dans l\'intervalle', () => {
    assert.deepEqual(
      parsePlaybackParams({ fileIndex: '-5', audioIndex: '-1', ss: '-30', audioOffset: '500' }),
      { fileIndex: 1, audioIndex: 0, seekSeconds: 0, audioOffset: 60 }
    );
    assert.equal(parsePlaybackParams({ ss: '9999999' }).seekSeconds, 48 * 3600);
    assert.equal(parseTrackIndex('1000'), 99);
    assert.equal(parseFileIndex('2.9'), 2);
  });
});

describe('isValidPlayId', () => {
  test('accepte les identifiants générés par le lecteur', () => {
    const playId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    assert.equal(isValidPlayId(playId), true);
    assert.equal(isValidPlayId('abc_DEF-123'), true);
  });
  test('refuse toute traversée de répertoire ou valeur exotique', () => {
    for (const v of ['..', '../..', '../../src', 'a/b/c/d', 'abc\\def', '.hidden', '', 'abc', 'x'.repeat(65), undefined, ['abcdef']]) {
      assert.equal(isValidPlayId(v), false, String(v));
    }
  });
});
