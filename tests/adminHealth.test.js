import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Base SQLite jetable : database.js lit DATABASE_PATH à l'import
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-admin-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'test.db');
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const { createUser, isAdminUser, sanitizeUser } = await import('../database.js');
const { requireAdmin } = await import('../src/utils/admin.js');
const { summarizeBackups, diskLevel, serviceLevel, worstLevel, HEALTH_THRESHOLDS } = await import('../src/services/healthService.js');

const HOUR = 60 * 60 * 1000;
const GB = 1024 ** 3;

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

describe('Administrateur', () => {
  const first = createUser('Premier', 'motdepasse1');
  const second = createUser('Second', 'motdepasse2');

  test('par défaut : le premier compte créé', () => {
    delete process.env.ANIMFLIX_ADMINS;
    assert.equal(isAdminUser(first), true);
    assert.equal(isAdminUser(second), false);
    assert.equal(isAdminUser(null), false);
    assert.equal(sanitizeUser(first).isAdmin, true);
    assert.equal(sanitizeUser(second).isAdmin, false);
  });

  test('ANIMFLIX_ADMINS remplace la règle (noms sans tenir compte de la casse)', () => {
    process.env.ANIMFLIX_ADMINS = ' second , autre ';
    try {
      assert.equal(isAdminUser(first), false);
      assert.equal(isAdminUser(second), true);
    } finally {
      delete process.env.ANIMFLIX_ADMINS;
    }
  });

  test('garde des routes : 401 sans session, 403 pour un autre compte', () => {
    let res = fakeRes();
    assert.equal(requireAdmin({}, res), false);
    assert.equal(res.statusCode, 401);

    res = fakeRes();
    assert.equal(requireAdmin({ user: second }, res), false);
    assert.equal(res.statusCode, 403);

    res = fakeRes();
    assert.equal(requireAdmin({ user: first }, res), true);
  });
});

describe('Santé du serveur — sauvegardes', () => {
  const now = Date.UTC(2026, 10, 8, 12);
  const file = (day, ageMs, size = 1000) => ({ name: `animflix-${day}.db`, size, mtimeMs: now - ageMs });

  test('la plus récente, son âge et le total', () => {
    const s = summarizeBackups([file('2026-11-06', 50 * HOUR), file('2026-11-08', 2 * HOUR, 3000), { name: 'autre.txt', size: 5, mtimeMs: now }], now);
    assert.equal(s.level, 'ok');
    assert.equal(s.count, 2);
    assert.equal(s.totalBytes, 4000);
    assert.equal(s.latest.day, '2026-11-08');
    assert.equal(s.latest.ageMs, 2 * HOUR);
  });

  test('sauvegarde quotidienne manquée : attention, puis problème', () => {
    assert.equal(summarizeBackups([file('2026-11-06', HEALTH_THRESHOLDS.BACKUP_WARN_AGE_MS + 1)], now).level, 'warn');
    assert.equal(summarizeBackups([file('2026-11-01', HEALTH_THRESHOLDS.BACKUP_ERROR_AGE_MS + 1)], now).level, 'error');
    assert.equal(summarizeBackups([], now).level, 'error');
  });
});

describe('Santé du serveur — niveaux', () => {
  test('disque : moins de 10 % ou 5 Go libres = attention, moins de 1 Go = problème', () => {
    assert.equal(diskLevel({ free: 200 * GB, total: 500 * GB }), 'ok');
    assert.equal(diskLevel({ free: 4 * GB, total: 20 * GB }), 'warn');
    assert.equal(diskLevel({ free: 40 * GB, total: 1000 * GB }), 'warn');
    assert.equal(diskLevel({ free: 0.5 * GB, total: 20 * GB }), 'error');
    assert.equal(diskLevel({ free: 0, total: 0 }), 'warn');
  });

  test('services : hors ligne, lent, désactivé', () => {
    assert.equal(serviceLevel({ ok: true, latencyMs: 300 }), 'ok');
    assert.equal(serviceLevel({ ok: true, latencyMs: HEALTH_THRESHOLDS.SLOW_MS + 1 }), 'warn');
    assert.equal(serviceLevel({ ok: false, error: 'x' }), 'error');
    assert.equal(serviceLevel({ enabled: false }), 'off');
  });

  test('niveau global = le pire (désactivé ne compte pas comme un problème)', () => {
    assert.equal(worstLevel(['ok', 'off', 'ok']), 'ok');
    assert.equal(worstLevel(['ok', 'warn', 'off']), 'warn');
    assert.equal(worstLevel(['warn', 'error', 'ok']), 'error');
  });
});
