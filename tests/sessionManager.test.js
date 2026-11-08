import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolveClientId, drainFfmpegStderr } from '../src/utils/sessionManager.js';

describe('Multi-Client Session Manager', () => {
  it('accepte un clientId valide depuis req.query', () => {
    const req = { query: { clientId: 'client_desktop_1234' } };
    const id = resolveClientId(req);
    assert.strictEqual(id, 'client_desktop_1234');
  });

  it('accepte un clientId valide depuis le header x-client-id', () => {
    const req = { headers: { 'x-client-id': 'client_mobile_9876' } };
    const id = resolveClientId(req);
    assert.strictEqual(id, 'client_mobile_9876');
  });

  it('génère un identifiant cryptographique unique si le clientId est absent', () => {
    const req1 = { query: {}, headers: {} };
    const req2 = { query: {}, headers: {} };

    const id1 = resolveClientId(req1);
    const id2 = resolveClientId(req2);

    assert.ok(id1.startsWith('anon_'));
    assert.ok(id2.startsWith('anon_'));
    // Isolation absolue : deux requêtes sans clientId n'auront jamais le même id
    assert.notStrictEqual(id1, id2);
  });

  it('rejette les identifiants avec des caractères dangereux ou espaces et génère un ID sain', () => {
    const req = { query: { clientId: 'bad; rm -rf /; id' } };
    const id = resolveClientId(req);

    assert.ok(id.startsWith('anon_'));
    assert.strictEqual(/^[a-zA-Z0-9_\-]+$/.test(id), true);
  });
});

import fs from 'fs';
import path from 'path';
import { HLS_CACHE_DIR } from '../src/config/constants.js';
import {
  countActiveStreams,
  cleanupHlsSession,
  activeClientFfmpegProcesses,
  activeHlsSessions
} from '../src/utils/sessionManager.js';

describe('Limite de flux et nettoyage HLS', () => {
  const fakeProc = (alive) => ({ exitCode: alive ? null : 0, signalCode: null, kill() {} });

  it('compte uniquement les processus FFmpeg encore vivants (direct + HLS)', () => {
    activeClientFfmpegProcesses.set('t_a', fakeProc(true));
    activeClientFfmpegProcesses.set('t_b', fakeProc(false));
    activeHlsSessions.set('t_hls1', { ffmpegProcess: fakeProc(true) });
    activeHlsSessions.set('t_hls2', { ffmpegProcess: fakeProc(false) });
    try {
      assert.strictEqual(countActiveStreams(), 2);
    } finally {
      ['t_a', 't_b'].forEach(k => activeClientFfmpegProcesses.delete(k));
      ['t_hls1', 't_hls2'].forEach(k => activeHlsSessions.delete(k));
    }
  });

  it('ne supprime jamais un dossier hors du cache HLS (traversée "..")', () => {
    // Dossier témoin à côté du cache HLS : il NE doit PAS être supprimé
    const victim = path.join(HLS_CACHE_DIR, '..', `victim_${process.pid}`);
    fs.mkdirSync(victim, { recursive: true });
    try {
      const playId = `../victim_${process.pid}`;
      activeHlsSessions.set(playId, { ffmpegProcess: fakeProc(false) });
      cleanupHlsSession(playId);
      assert.ok(fs.existsSync(victim), 'le dossier hors cache a été supprimé');
      assert.ok(!activeHlsSessions.has(playId));
    } finally {
      fs.rmSync(victim, { recursive: true, force: true });
    }
  });

  it('supprime bien le dossier d\'une session HLS légitime', () => {
    const playId = `testplay${process.pid}`;
    const dir = path.join(HLS_CACHE_DIR, playId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'seg_00000.ts'), 'x');
    activeHlsSessions.set(playId, { ffmpegProcess: fakeProc(true) });
    cleanupHlsSession(playId);
    assert.ok(!fs.existsSync(dir));
  });
});

describe('drainFfmpegStderr', () => {
  // Régression : un FFmpeg HLS dont personne ne lit le stderr se bloquait après ~100 segments
  // (tampon du socket plein), ce qui figeait la lecture et faisait tomber le débit torrent à 0.
  it('évite le blocage d\'un processus qui écrit beaucoup sur stderr', async () => {
    const script = "const l='x'.repeat(1023)+'\\n'; for (let i = 0; i < 2048; i++) process.stderr.write(l);";
    const proc = spawn(process.execPath, ['-e', script]);
    drainFfmpegStderr(proc, 'test');
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('processus bloqué sur stderr')); }, 10000);
      proc.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.strictEqual(code, 0);
  });

  it('ignore un processus sans stderr', () => {
    assert.doesNotThrow(() => drainFfmpegStderr(null));
    assert.doesNotThrow(() => drainFfmpegStderr({}));
  });
});
