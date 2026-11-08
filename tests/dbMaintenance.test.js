import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { backupDatabase, selectBackupsToKeep } from '../src/services/dbMaintenance.js';
import { createSyncStore } from '../src/services/syncStore.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-db-'));
}

describe('Sauvegarde quotidienne de la base', () => {
  test('crée une copie lisible, une seule par jour', async () => {
    const dir = tempDir();
    try {
      const db = new Database(path.join(dir, 'animflix.db'));
      db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('historique');");
      const backupDir = path.join(dir, 'backups');
      const day = new Date(2026, 10, 5, 10, 0);

      const created = await backupDatabase(db, { backupDir, now: day });
      assert.equal(path.basename(created), 'animflix-2026-11-05.db');
      const copy = new Database(created, { readonly: true });
      assert.equal(copy.prepare('SELECT v FROM t').get().v, 'historique');
      copy.close();

      assert.equal(await backupDatabase(db, { backupDir, now: new Date(2026, 10, 5, 23, 0) }), null);
      assert.deepEqual(fs.readdirSync(backupDir), ['animflix-2026-11-05.db']);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ne garde que les N sauvegardes les plus récentes et ignore les autres fichiers', async () => {
    const dir = tempDir();
    try {
      const db = new Database(':memory:');
      const backupDir = path.join(dir, 'backups');
      fs.mkdirSync(backupDir);
      fs.writeFileSync(path.join(backupDir, 'notes.txt'), 'à garder');
      for (let d = 1; d <= 5; d++) {
        await backupDatabase(db, { backupDir, keep: 3, now: new Date(2026, 10, d) });
      }
      assert.deepEqual(fs.readdirSync(backupDir).sort(), [
        'animflix-2026-11-03.db', 'animflix-2026-11-04.db', 'animflix-2026-11-05.db', 'notes.txt'
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Rétention par paliers', () => {
  const name = (d) => `animflix-${d.toISOString().slice(0, 10)}.db`;

  test('7 jours + la plus récente de 4 semaines + celle de 6 mois', () => {
    // 200 sauvegardes quotidiennes jusqu'au dimanche 8 novembre 2026
    const names = [];
    for (let i = 0; i < 200; i++) names.push(name(new Date(Date.UTC(2026, 10, 8 - i))));
    names.push('notes.txt');
    const keep = selectBackupsToKeep(names, { daily: 7, weekly: 4, monthly: 6 });
    const kept = [...keep].sort().map(n => n.slice(9, 19));
    assert.ok(!keep.has('notes.txt'));
    // Quotidiennes
    for (let d = 2; d <= 8; d++) assert.ok(kept.includes(`2026-11-0${d}`));
    // Hebdomadaires : dimanches des semaines précédentes
    for (const d of ['2026-11-01', '2026-10-25', '2026-10-18']) assert.ok(kept.includes(d), d);
    // Mensuelles : dernier jour des mois précédents
    for (const d of ['2026-10-31', '2026-09-30', '2026-08-31', '2026-07-31', '2026-06-30']) assert.ok(kept.includes(d), d);
    assert.ok(!kept.includes('2026-05-31'));
    assert.ok(kept.length <= 7 + 4 + 6);
  });

  test('backupDatabase applique les paliers par défaut', async () => {
    const dir = tempDir();
    try {
      const db = new Database(':memory:');
      const backupDir = path.join(dir, 'backups');
      for (let i = 60; i >= 0; i--) {
        await backupDatabase(db, { backupDir, retention: { daily: 3, weekly: 2, monthly: 2 }, now: new Date(2026, 10, 8 - i, 12) });
      }
      const files = fs.readdirSync(backupDir).sort();
      assert.ok(files.includes('animflix-2026-11-08.db'));
      assert.ok(files.includes('animflix-2026-10-31.db'), 'dernier jour du mois précédent');
      assert.ok(files.length <= 3 + 2 + 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Purge des suppressions de synchro', () => {
  test('supprime seulement les pierres tombales trop anciennes', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1);');
    const store = createSyncStore(db);
    const day = 24 * 3600 * 1000;
    const now = 200 * day;
    store.push(1, [
      { ns: 'favorites:default', key: 'vieux', deleted: true, updatedAt: now - 100 * day },
      { ns: 'favorites:default', key: 'recent', deleted: true, updatedAt: now - 10 * day },
      { ns: 'favorites:default', key: 'vivant', data: { id: 'vivant' }, updatedAt: now - 100 * day }
    ], now);
    assert.equal(store.pruneTombstones(90 * day, now), 1);
    assert.deepEqual(store.pull(1, 0).items.map(i => i.key).sort(), ['recent', 'vivant']);
  });
});
