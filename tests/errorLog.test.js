import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createErrorLogStore, ERROR_LOG_LIMITS } from '../src/services/errorLog.js';

describe('Journal des erreurs', () => {
  test('regroupe une erreur répétée dans les 10 minutes, puis en recrée une', () => {
    const log = createErrorLogStore(new Database(':memory:'));
    const t0 = 1_000_000;
    log.add({ source: 'ffmpeg', message: 'FFmpeg direct : Invalid data', details: 'a' }, t0);
    log.add({ source: 'ffmpeg', message: 'FFmpeg direct : Invalid data', details: 'b' }, t0 + 60_000);
    let items = log.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].count, 2);
    assert.equal(items[0].details, 'b');
    assert.equal(items[0].firstAt, t0);
    assert.equal(items[0].lastAt, t0 + 60_000);

    log.add({ source: 'ffmpeg', message: 'FFmpeg direct : Invalid data' }, t0 + 60_000 + ERROR_LOG_LIMITS.MERGE_WINDOW_MS + 1);
    items = log.list();
    assert.equal(items.length, 2);
    assert.equal(items[0].count, 1);
  });

  test('filtre par source, compte sur 24 h, source inconnue rangée dans « serveur »', () => {
    const log = createErrorLogStore(new Database(':memory:'));
    const now = 10 * 86_400_000;
    log.add({ source: 'lecture', message: 'Aucun pair : Frieren' }, now - 2 * 86_400_000);
    log.add({ source: 'lecture', message: 'Illisible : Dandadan' }, now - 1000);
    log.add({ source: 'inconnue', message: 'x'.repeat(1000) }, now);
    assert.equal(log.list({ source: 'lecture' }).length, 2);
    assert.deepEqual(log.countsSince(now - 86_400_000), { lecture: 1, serveur: 1 });
    const other = log.list({ source: 'serveur' })[0];
    assert.equal(other.message.length, ERROR_LOG_LIMITS.MAX_MESSAGE);
    assert.equal(log.clear(), 3);
    assert.equal(log.list().length, 0);
  });

  test('garde seulement les entrées les plus récentes', () => {
    const log = createErrorLogStore(new Database(':memory:'));
    for (let i = 0; i < ERROR_LOG_LIMITS.MAX_ROWS + 30; i++) log.add({ source: 'ffmpeg', message: `erreur ${i}` }, i);
    log.trim();
    const items = log.list({ limit: 10_000 });
    assert.equal(items.length, ERROR_LOG_LIMITS.MAX_ROWS);
    assert.equal(items[0].message, `erreur ${ERROR_LOG_LIMITS.MAX_ROWS + 29}`);
  });
});
