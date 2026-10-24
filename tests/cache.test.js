import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExpiringLRUCache } from '../src/utils/cache.js';

describe('ExpiringLRUCache', () => {
  it('enregistre et récupère des valeurs avec succès', () => {
    const cache = new ExpiringLRUCache({ maxEntries: 10, defaultTTL: 5000 });
    cache.set('anime_1', { title: 'Frieren' });

    assert.deepStrictEqual(cache.get('anime_1'), { title: 'Frieren' });
    assert.strictEqual(cache.has('anime_1'), true);
  });

  it('évince le plus ancien élément quand la capacité max est atteinte (LRU)', () => {
    const cache = new ExpiringLRUCache({ maxEntries: 3, defaultTTL: 10000 });
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');
    cache.set('k3', 'v3');

    // Accéder à k1 pour qu'il devienne récemment utilisé (l'ordre devient: k2, k3, k1)
    cache.get('k1');

    // Ajouter k4 : k2 doit être évincé car c'est le plus ancien non utilisé
    cache.set('k4', 'v4');

    assert.strictEqual(cache.get('k2'), undefined);
    assert.strictEqual(cache.get('k1'), 'v1');
    assert.strictEqual(cache.get('k3'), 'v3');
    assert.strictEqual(cache.get('k4'), 'v4');
    assert.strictEqual(cache.size, 3);
  });

  it('expire les éléments selon le TTL', async () => {
    const cache = new ExpiringLRUCache({ maxEntries: 10, defaultTTL: 50 }); // 50ms
    cache.set('temp', 'passager');

    assert.strictEqual(cache.get('temp'), 'passager');

    // Attendre l'expiration
    await new Promise(r => setTimeout(r, 65));

    assert.strictEqual(cache.get('temp'), undefined);
    assert.strictEqual(cache.has('temp'), false);
  });

  it('purgeExpired nettoie les entrées expirées', async () => {
    const cache = new ExpiringLRUCache({ maxEntries: 10, defaultTTL: 40 });
    cache.set('a', 1);
    cache.set('b', 2);

    await new Promise(r => setTimeout(r, 55));
    cache.purgeExpired();

    assert.strictEqual(cache.size, 0);
  });
});
