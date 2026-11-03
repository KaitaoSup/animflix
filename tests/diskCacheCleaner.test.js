import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { cleanCacheDir } from '../src/utils/diskCacheCleaner.js';

const DAY = 24 * 60 * 60 * 1000;

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-cache-test-'));
}

function writeFile(dir, name, size, ageMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(size));
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(p, t, t);
  return p;
}

test('supprime les fichiers expirés et garde les récents', async () => {
  const dir = makeDir();
  const old = writeFile(dir, 'old.ass', 10, 8 * DAY);
  const fresh = writeFile(dir, 'fresh.ass', 10, 1 * DAY);
  const r = await cleanCacheDir(dir, { maxAgeMs: 7 * DAY, maxSizeBytes: 1e9 });
  assert.equal(r.removed, 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('applique la limite de taille en supprimant les moins récents', async () => {
  const dir = makeDir();
  const a = writeFile(dir, 'a.ass', 100, 3 * DAY);
  const b = writeFile(dir, 'b.ass', 100, 2 * DAY);
  const c = writeFile(dir, 'c.ass', 100, 1 * DAY);
  await cleanCacheDir(dir, { maxAgeMs: 7 * DAY, maxSizeBytes: 250 });
  assert.equal(fs.existsSync(a), false);
  assert.equal(fs.existsSync(b), true);
  assert.equal(fs.existsSync(c), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('mode all : vide tout sauf les .tmp en cours', async () => {
  const dir = makeDir();
  const done = writeFile(dir, 'x.ass', 10, 0);
  const tmpActive = writeFile(dir, 'x.abc.ass.tmp', 10, 0);
  const tmpStale = writeFile(dir, 'y.abc.ass.tmp', 10, 2 * 60 * 60 * 1000);
  await cleanCacheDir(dir, { all: true });
  assert.equal(fs.existsSync(done), false);
  assert.equal(fs.existsSync(tmpActive), true);
  assert.equal(fs.existsSync(tmpStale), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
