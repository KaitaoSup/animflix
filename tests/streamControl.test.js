import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeClientFfmpegProcesses, activeHlsSessions, clientActiveHlsMap,
  buildStreamMeta, listActiveStreams, countUserStreams, stopClientStreams,
  getClientBlock, getPlayStopNotice, markPlayStopped, describeDevice, STREAM_CONTROL
} from '../src/utils/sessionManager.js';

// Faux processus FFmpeg : vivant tant qu'on ne l'a pas tué
function fakeProc() {
  return { exitCode: null, signalCode: null, killed: false, kill(sig) { this.killed = true; this.signalCode = sig; } };
}

const MAGNET = 'magnet:?xt=urn:btih:ABCDEF0123456789ABCDEF0123456789ABCDEF01&dn=%5BSubsPlease%5D%20Kimi%20no%20Anime%20-%2005';
const reqFor = (user, extra = {}) => ({
  user,
  query: extra.query || {},
  headers: { 'user-agent': extra.ua || 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36' }
});

function addProgressive(clientId, user, playId, extra) {
  const proc = fakeProc();
  proc.animflixMeta = buildStreamMeta(reqFor(user, extra), { clientId, playId, mode: 'direct', magnet: MAGNET });
  activeClientFfmpegProcesses.set(clientId, proc);
  return proc;
}

function addHls(clientId, user, playId) {
  const proc = fakeProc();
  activeHlsSessions.set(playId, {
    playId, clientId, ffmpegProcess: proc, dir: '/nonexistent', lastAccess: Date.now(),
    meta: buildStreamMeta(reqFor(user), { clientId, playId, mode: 'hls-copy', magnet: MAGNET })
  });
  if (!clientActiveHlsMap.has(clientId)) clientActiveHlsMap.set(clientId, new Set());
  clientActiveHlsMap.get(clientId).add(playId);
  return proc;
}

beforeEach(() => {
  activeClientFfmpegProcesses.clear();
  activeHlsSessions.clear();
  clientActiveHlsMap.clear();
});

const alice = { id: 1, username: 'alice' };
const bob = { id: 2, username: 'bob' };

describe('Lectures en cours — liste', () => {
  test('compte, appareil, titre et mode de chaque flux', () => {
    addProgressive('c_phone', alice, 'p1', { query: { title: 'Kimi no Anime · Ép. 5' } });
    addHls('c_tv', bob, 'h1');
    const list = listActiveStreams();
    assert.equal(list.length, 2);
    const phone = list.find(s => s.clientId === 'c_phone');
    assert.equal(phone.username, 'alice');
    assert.equal(phone.title, 'Kimi no Anime · Ép. 5');
    assert.equal(phone.device, 'Chrome · Android');
    assert.equal(phone.kind, 'progressive');
    assert.equal(phone.hash, 'abcdef0123456789abcdef0123456789abcdef01');
    const tv = list.find(s => s.clientId === 'c_tv');
    assert.equal(tv.title, '[SubsPlease] Kimi no Anime - 05'); // nom du torrent à défaut de titre
    assert.equal(tv.kind, 'hls');
  });

  test('un processus terminé ne compte plus', () => {
    const proc = addProgressive('c_phone', alice, 'p1');
    proc.exitCode = 0;
    assert.equal(listActiveStreams().length, 0);
  });

  test('lectures du compte sur ses autres appareils', () => {
    addProgressive('c_phone', alice, 'p1');
    addHls('c_pc', alice, 'h1');
    addHls('c_tv', bob, 'h2');
    assert.equal(countUserStreams(1), 2);
    assert.equal(countUserStreams(1, 'c_phone'), 1);
    assert.equal(countUserStreams(2), 1);
    assert.equal(countUserStreams(null), 0);
  });

  test('titre nettoyé et borné', () => {
    const meta = buildStreamMeta(reqFor(null, { query: { title: 'a\u0000b  ' + 'x'.repeat(500) } }), { clientId: 'c', mode: 'direct', magnet: 'magnet:?xt=urn:btih:aa' });
    assert.ok(meta.title.startsWith('a b x'));
    assert.equal(meta.title.length, STREAM_CONTROL.MAX_TITLE);
    assert.equal(meta.username, null);
  });
});

describe('Lectures en cours — arrêt par l\'administrateur', () => {
  test('coupe les flux de l\'appareil, bloque les relances 1 minute et prévient le lecteur', () => {
    const proc = addProgressive('c_phone', alice, 'p1');
    const other = addHls('c_tv', bob, 'h1');
    const now = Date.now();
    assert.equal(stopClientStreams('c_phone', { now }), 1);
    assert.ok(proc.killed);
    assert.ok(!other.killed);
    assert.equal(activeClientFfmpegProcesses.has('c_phone'), false);
    assert.deepEqual(getPlayStopNotice('p1', now), { message: STREAM_CONTROL.STOP_MESSAGE });
    assert.equal(getPlayStopNotice('h1', now), null);

    const block = getClientBlock('c_phone', now + 1000);
    assert.equal(block.message, STREAM_CONTROL.STOP_MESSAGE);
    assert.equal(block.retryAfterS, 59);
    assert.equal(getClientBlock('c_phone', now + STREAM_CONTROL.BLOCK_MS + 1), null);
    assert.equal(getClientBlock('c_tv', now), null);
  });

  test('session HLS coupée', () => {
    const proc = addHls('c_tv', bob, 'h9');
    assert.equal(stopClientStreams('c_tv'), 1);
    assert.ok(proc.killed);
    assert.equal(activeHlsSessions.has('h9'), false);
    assert.ok(getPlayStopNotice('h9'));
  });

  test('appareil sans lecture : rien à couper', () => {
    assert.equal(stopClientStreams('c_nobody'), 0);
  });

  test('le message expire', () => {
    const now = Date.now();
    markPlayStopped('pOld', 'x', now - STREAM_CONTROL.NOTICE_MS - 1);
    assert.equal(getPlayStopNotice('pOld', now), null);
  });
});

describe('Lectures en cours — appareils', () => {
  test('libellés lisibles', () => {
    assert.equal(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari · iPhone');
    assert.equal(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0'), 'Edge · Windows');
    assert.equal(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'), 'Firefox · Linux');
    assert.equal(describeDevice('VLC/3.0.20 LibVLC/3.0.20'), 'Lecteur externe');
    assert.equal(describeDevice(''), 'Appareil inconnu');
  });
});
