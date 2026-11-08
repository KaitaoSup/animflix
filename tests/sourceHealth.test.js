import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSourceHealthStore, annotateTorrents, hashFromMagnet, SOURCE_HEALTH_CONFIG } from '../src/services/sourceHealth.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const magnet = (h) => `magnet:?xt=urn:btih:${h.toUpperCase()}&dn=x`;

describe('Santé des sources', () => {
  test('échec signalé jusqu’au prochain succès, par personnes distinctes', () => {
    const store = createSourceHealthStore(new Database(':memory:'));
    const t = 1_000_000_000;
    assert.ok(store.record({ hash: A, outcome: 'fail', reason: 'no_peers', reporter: 'u:1' }, t));
    // Doublon de la même personne dans les 6 h : ignoré
    assert.equal(store.record({ hash: A, outcome: 'fail', reason: 'stalled', reporter: 'u:1' }, t + 1000), false);
    assert.ok(store.record({ hash: A, outcome: 'fail', reason: 'unplayable', reporter: 'c:abcd' }, t + 2000));

    let s = store.statusFor([A, B], t + 3000);
    assert.equal(s.size, 1);
    assert.deepEqual({ ...s.get(A), lastFailAt: undefined }, { fails: 2, reason: 'unplayable', reasonLabel: 'Illisible', lastFailAt: undefined });

    // Quelqu'un réussit à la lire : la source n'est plus signalée
    store.record({ hash: A, outcome: 'ok', reporter: 'u:2' }, t + 4000);
    assert.equal(store.statusFor([A], t + 5000).size, 0);

    // Nouvel échec après le succès
    store.record({ hash: A, outcome: 'fail', reason: 'bidon', reporter: 'u:3' }, t + 6000);
    s = store.statusFor([A], t + 7000).get(A);
    assert.equal(s.fails, 1);
    assert.equal(s.reason, 'manual');
  });

  test('signalements invalides refusés, anciens oubliés', () => {
    const store = createSourceHealthStore(new Database(':memory:'));
    assert.equal(store.record({ hash: 'pas-un-hash', outcome: 'fail', reporter: 'u:1' }), false);
    assert.equal(store.record({ hash: A, outcome: 'peut-être', reporter: 'u:1' }), false);
    assert.equal(store.record({ hash: A, outcome: 'fail' }), false);
    store.record({ hash: A, outcome: 'fail', reporter: 'u:1' }, 0);
    const later = SOURCE_HEALTH_CONFIG.WINDOW_MS + 10;
    assert.equal(store.statusFor([A], later).size, 0);
    assert.equal(store.prune(later), 1);
  });

  test('annote les résultats de recherche sans modifier les autres', () => {
    const store = createSourceHealthStore(new Database(':memory:'));
    store.record({ hash: A, outcome: 'fail', reason: 'no_peers', reporter: 'u:1' }, 100);
    const results = [{ titre: 'a', lienMagnet: magnet(A) }, { titre: 'b', lienMagnet: magnet(B) }, { titre: 'c' }];
    const out = annotateTorrents(store, results, 200);
    assert.equal(out[0].reported.reasonLabel, 'Aucun pair');
    assert.equal(out[1].reported, undefined);
    assert.equal(out[2], results[2]);
    assert.equal(results[0].reported, undefined, 'les résultats en cache ne sont pas modifiés');
    assert.equal(hashFromMagnet(magnet(A)), A);
  });
});
