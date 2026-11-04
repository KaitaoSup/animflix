import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createSyncStore, normalizeSyncItem, isValidNamespace, SYNC_LIMITS } from '../src/services/syncStore.js';

function freshStore() {
  const db = new Database(':memory:'); // better-sqlite3 active les clés étrangères : la table users doit exister
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1), (2);');
  return createSyncStore(db);
}

describe('syncStore — validation', () => {
  test('espaces de noms autorisés uniquement', () => {
    assert.ok(isValidNamespace('profiles'));
    assert.ok(isValidNamespace('prefs'));
    assert.ok(isValidNamespace('history:default'));
    assert.ok(isValidNamespace('favorites:p_lx3k9a'));
    assert.ok(!isValidNamespace('history:'));
    assert.ok(!isValidNamespace('history:../x'));
    assert.ok(!isValidNamespace('users'));
    assert.ok(!isValidNamespace(42));
  });

  test('rejette clé, horodatage ou données invalides', () => {
    const now = 1_000_000;
    assert.equal(normalizeSyncItem({ ns: 'prefs', key: '', data: {}, updatedAt: 1 }, now), null);
    assert.equal(normalizeSyncItem({ ns: 'prefs', key: 'k'.repeat(SYNC_LIMITS.MAX_KEY_LENGTH + 1), data: {}, updatedAt: 1 }, now), null);
    assert.equal(normalizeSyncItem({ ns: 'prefs', key: 'k', data: {}, updatedAt: 'x' }, now), null);
    assert.equal(normalizeSyncItem({ ns: 'prefs', key: 'k', data: 'texte', updatedAt: 1 }, now), null);
    assert.equal(normalizeSyncItem({ ns: 'prefs', key: 'k', data: { v: 'x'.repeat(SYNC_LIMITS.MAX_DATA_BYTES) }, updatedAt: 1 }, now), null);
    assert.deepEqual(normalizeSyncItem({ ns: 'prefs', key: 'k', deleted: true, updatedAt: 5 }, now), { ns: 'prefs', key: 'k', data: null, updatedAt: 5 });
  });

  test("borne l'horodatage d'un appareil dont l'horloge avance", () => {
    const now = 1_000_000;
    const item = normalizeSyncItem({ ns: 'prefs', key: 'k', data: {}, updatedAt: now + 10 * 24 * 3600 * 1000 }, now);
    assert.equal(item.updatedAt, now + SYNC_LIMITS.MAX_CLOCK_AHEAD_MS);
  });
});

describe('syncStore — envoi / réception', () => {
  test('aller-retour et réception incrémentale par révision', () => {
    const store = freshStore();
    const r1 = store.push(1, [
      { ns: 'history:default', key: 'abc_f1', data: { currentTime: 120 }, updatedAt: 100 },
      { ns: 'prefs', key: 'animflix_aniskip_mode', data: { value: 'auto' }, updatedAt: 100 }
    ]);
    assert.deepEqual({ rev: r1.rev, accepted: r1.accepted, rejected: r1.rejected }, { rev: 2, accepted: 2, rejected: 0 });

    const all = store.pull(1, 0);
    assert.equal(all.items.length, 2);
    assert.equal(all.rev, 2);
    assert.deepEqual(all.items[0].data, { currentTime: 120 });

    store.push(1, [{ ns: 'history:default', key: 'abc_f1', data: { currentTime: 300 }, updatedAt: 200 }]);
    const delta = store.pull(1, all.rev);
    assert.equal(delta.items.length, 1);
    assert.deepEqual(delta.items[0].data, { currentTime: 300 });
    assert.equal(store.pull(1, delta.rev).items.length, 0);
  });

  test('le plus récent gagne, et le serveur renvoie sa version en cas de conflit', () => {
    const store = freshStore();
    store.push(1, [{ ns: 'history:default', key: 'k', data: { currentTime: 500 }, updatedAt: 300 }]);
    const stale = store.push(1, [{ ns: 'history:default', key: 'k', data: { currentTime: 10 }, updatedAt: 200 }]);
    assert.equal(stale.accepted, 0);
    assert.equal(stale.rejected, 1);
    assert.deepEqual(stale.conflicts, [{ ns: 'history:default', key: 'k', data: { currentTime: 500 }, deleted: false, updatedAt: 300 }]);
    assert.deepEqual(store.pull(1, 0).items[0].data, { currentTime: 500 });
  });

  test('une suppression est propagée sous forme de pierre tombale', () => {
    const store = freshStore();
    store.push(1, [{ ns: 'favorites:default', key: 'frieren', data: { id: 'frieren' }, updatedAt: 100 }]);
    const { rev } = store.pull(1, 0);
    store.push(1, [{ ns: 'favorites:default', key: 'frieren', deleted: true, updatedAt: 150 }]);
    const delta = store.pull(1, rev);
    assert.equal(delta.items.length, 1);
    assert.equal(delta.items[0].deleted, true);
    assert.equal(delta.items[0].data, null);
  });

  test('les données de chaque utilisateur sont séparées', () => {
    const store = freshStore();
    store.push(1, [{ ns: 'prefs', key: 'a', data: { value: '1' }, updatedAt: 1 }]);
    store.push(2, [{ ns: 'prefs', key: 'a', data: { value: '2' }, updatedAt: 1 }]);
    assert.deepEqual(store.pull(1, 0).items.map(i => i.data.value), ['1']);
    assert.deepEqual(store.pull(2, 0).items.map(i => i.data.value), ['2']);
  });

  test('réception paginée (more) sans perte', () => {
    const store = freshStore();
    store.push(1, Array.from({ length: 5 }, (_, i) => ({ ns: 'prefs', key: `k${i}`, data: { value: String(i) }, updatedAt: 1 })));
    const p1 = store.pull(1, 0, 3);
    assert.equal(p1.items.length, 3);
    assert.equal(p1.more, true);
    const p2 = store.pull(1, p1.rev, 3);
    assert.equal(p2.items.length, 2);
    assert.equal(p2.more, false);
    assert.deepEqual([...p1.items, ...p2.items].map(i => i.key), ['k0', 'k1', 'k2', 'k3', 'k4']);
  });
});
