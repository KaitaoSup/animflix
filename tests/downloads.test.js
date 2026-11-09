import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import Database from 'better-sqlite3';
import {
  createDownloadStore,
  createDownloadManager,
  normalizeDownloadRequest,
  downloadId,
  initDownloadManager,
  mediaInputUrl
} from '../src/services/downloadService.js';

const HASH = 'a'.repeat(40);
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=test`;
const quiet = { log() {}, warn() {} };

function freshStore() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1);');
  return createDownloadStore(db);
}

/** Faux TorrServer : sert `content`, respecte Range, peut couper le flux après `cutAfter` octets */
function fakeHttp(content, { cutAfter = null, ignoreRange = false } = {}) {
  const calls = [];
  const httpGet = async (url, opts) => {
    calls.push({ url, range: opts.headers?.Range || null });
    const m = /bytes=(\d+)-/.exec(opts.headers?.Range || '');
    const start = m && !ignoreRange ? Number(m[1]) : 0;
    let body = content.subarray(start);
    const headers = start > 0
      ? { 'content-range': `bytes ${start}-${content.length - 1}/${content.length}`, 'content-length': String(body.length) }
      : { 'content-length': String(content.length) };
    const cut = cutAfter !== null && calls.length === 1;
    if (cut) body = body.subarray(0, cutAfter);
    return { status: start > 0 ? 206 : 200, headers, data: Readable.from([body]) };
  };
  return { httpGet, calls };
}

async function waitFor(fn, timeoutMs = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise(r => setTimeout(r, 10));
  }
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-dl-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); initDownloadManager({ store: freshStore(), dir }); });

describe('downloadService — validation', () => {
  test('identifiant basé sur l’infohash et l’index du fichier', () => {
    assert.equal(downloadId(MAGNET, 3), `${HASH}_f3`);
    assert.equal(downloadId(`magnet:?xt=urn:btih:${HASH.toUpperCase()}&tr=x`, '3'), `${HASH}_f3`);
    assert.equal(downloadId('http://exemple/x.torrent', 1), null);
  });

  test('refuse un magnet invalide, nettoie les champs', () => {
    assert.equal(normalizeDownloadRequest({ magnet: 'http://x' }), null);
    assert.equal(normalizeDownloadRequest(null), null);
    const req = normalizeDownloadRequest({ magnet: MAGNET, fileIndex: '2', title: '  Frieren\n', episode: 'x', mediaId: 154587, poster: 'javascript:alert(1)' });
    assert.equal(req.id, `${HASH}_f2`);
    assert.equal(req.fileIndex, 2);
    assert.equal(req.title, 'Frieren');
    assert.equal(req.episode, null);
    assert.equal(req.mediaId, 154587);
    assert.equal(req.poster, null);
  });
});

describe('downloadService — gestionnaire', () => {
  test('télécharge le fichier, le range sous son nom final et le sert aux lectures', async () => {
    const content = Buffer.from('x'.repeat(5000));
    const { httpGet } = fakeHttp(content);
    const manager = initDownloadManager({
      store: freshStore(), dir, httpGet, log: quiet,
      getFiles: async () => ({ files: [{ id: 1, name: 'Show - 01.mkv', length: content.length }] }),
      freeSpace: async () => 1e15
    });

    const { item, created } = manager.enqueue({ magnet: MAGNET, fileIndex: 1, title: 'Show 01', episode: 1, mediaId: 5 }, 1);
    assert.ok(created);
    assert.equal(item.id, `${HASH}_f1`);
    await waitFor(() => manager.get(item.id).status === 'done');

    const done = manager.get(item.id);
    assert.equal(done.size, content.length);
    assert.equal(done.progress, 1);
    assert.equal(done.fileName, 'Show - 01.mkv');
    const local = manager.localPath(MAGNET, 1);
    assert.equal(local, path.join(dir, `${HASH}_f1.mkv`));
    assert.deepEqual(fs.readFileSync(local), content);
    assert.ok(!fs.existsSync(path.join(dir, `${HASH}_f1.part`)));

    // Les lectures FFmpeg utilisent le fichier local ; un autre fichier du torrent reste en streaming
    assert.equal(mediaInputUrl(MAGNET, 1), `file:${local}`);
    assert.match(mediaInputUrl(MAGNET, 2), /\/stream\?link=.*&index=2&play$/);

    // Doublon : pas de second téléchargement
    assert.equal(manager.enqueue({ magnet: MAGNET, fileIndex: 1 }).created, false);
  });

  test('reprend avec Range après une coupure du flux', async () => {
    const content = Buffer.from('abcdefghij'.repeat(300));
    const { httpGet, calls } = fakeHttp(content, { cutAfter: 1000 });
    const manager = createDownloadManager({
      store: freshStore(), dir, httpGet, log: quiet, retryDelayMs: () => 1,
      getFiles: async () => ({ files: [{ id: 1, name: 'ep.mp4', length: content.length }] }),
      freeSpace: async () => 1e15
    });
    const { item } = manager.enqueue({ magnet: MAGNET, fileIndex: 1, title: 'ep' });
    await waitFor(() => manager.get(item.id).status === 'done');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].range, null);
    assert.equal(calls[1].range, 'bytes=1000-');
    assert.deepEqual(fs.readFileSync(path.join(dir, `${HASH}_f1.mp4`)), content);
  });

  test('repart de zéro si le serveur ignore la reprise', async () => {
    const content = Buffer.from('0123456789'.repeat(200));
    const { httpGet } = fakeHttp(content, { cutAfter: 500, ignoreRange: true });
    const completed = [];
    const manager = createDownloadManager({
      store: freshStore(), dir, httpGet, log: quiet, retryDelayMs: () => 1,
      getFiles: async () => ({ files: [{ id: 1, name: 'ep.mkv', length: content.length }] }),
      freeSpace: async () => 1e15,
      onComplete: (done) => completed.push(done)
    });
    const { item } = manager.enqueue({ magnet: MAGNET, fileIndex: 1, title: 'ep' });
    await waitFor(() => manager.get(item.id).status === 'done');
    assert.deepEqual(fs.readFileSync(path.join(dir, `${HASH}_f1.mkv`)), content);
    // Prévient le téléchargement automatique (notification « épisode prêt »)
    assert.equal(completed.length, 1);
    assert.equal(completed[0].id, item.id);
    assert.equal(completed[0].status, 'done');
  });

  test('refuse quand le disque est presque plein', async () => {
    const { httpGet, calls } = fakeHttp(Buffer.alloc(10));
    const manager = createDownloadManager({
      store: freshStore(), dir, httpGet, log: quiet,
      getFiles: async () => ({ files: [{ id: 1, name: 'ep.mkv', length: 10 * 1024 ** 3 }] }),
      freeSpace: async () => 11 * 1024 ** 3
    });
    const { item } = manager.enqueue({ magnet: MAGNET, fileIndex: 1, title: 'ep' });
    await waitFor(() => manager.get(item.id).status === 'error');
    assert.match(manager.get(item.id).error, /Espace disque insuffisant/);
    assert.equal(calls.length, 0);
    assert.equal(manager.localPath(MAGNET, 1), null);
  });

  test('supprimer efface la ligne et le fichier', async () => {
    const content = Buffer.from('z'.repeat(100));
    const { httpGet } = fakeHttp(content);
    const manager = createDownloadManager({
      store: freshStore(), dir, httpGet, log: quiet,
      getFiles: async () => ({ files: [{ id: 1, name: 'ep.mkv', length: content.length }] }),
      freeSpace: async () => 1e15
    });
    const { item } = manager.enqueue({ magnet: MAGNET, fileIndex: 1, title: 'ep' });
    await waitFor(() => manager.get(item.id).status === 'done');
    const local = manager.localPath(MAGNET, 1);
    assert.ok(manager.remove(item.id));
    await waitFor(() => !fs.existsSync(local));
    assert.equal(manager.get(item.id), null);
    assert.equal(manager.localPath(MAGNET, 1), null);
  });

  test('un fichier disparu du disque n’est plus servi en local', async () => {
    const content = Buffer.from('q'.repeat(100));
    const { httpGet } = fakeHttp(content);
    const manager = createDownloadManager({
      store: freshStore(), dir, httpGet, log: quiet,
      getFiles: async () => ({ files: [{ id: 1, name: 'ep.mkv', length: content.length }] }),
      freeSpace: async () => 1e15
    });
    const { item } = manager.enqueue({ magnet: MAGNET, fileIndex: 1, title: 'ep' });
    await waitFor(() => manager.get(item.id).status === 'done');
    fs.unlinkSync(manager.localPath(MAGNET, 1));
    assert.equal(manager.localPath(MAGNET, 1), null);
  });

  test('au redémarrage, un téléchargement interrompu repart', async () => {
    const store = freshStore();
    const req = normalizeDownloadRequest({ magnet: MAGNET, fileIndex: 1, title: 'ep' });
    store.insert(req, null);
    store.update(req.id, { status: 'downloading' });
    const content = Buffer.from('r'.repeat(300));
    const { httpGet } = fakeHttp(content);
    const manager = createDownloadManager({
      store, dir, httpGet, log: quiet,
      getFiles: async () => ({ files: [{ id: 1, name: 'ep.mkv', length: content.length }] }),
      freeSpace: async () => 1e15
    });
    manager.resume();
    await waitFor(() => manager.get(req.id).status === 'done');
  });
});
