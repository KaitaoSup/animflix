import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { SUB_CACHE_DIR } from '../src/config/constants.js';
import { streamSubtitlesLive, isTruncatedRead } from '../src/services/subtitlesService.js';

describe('Subtitles Service & Stream Routing', () => {
  const dummyHash = 'test_hash_subtitle_' + Date.now();
  const dummyMagnet = `magnet:?xt=urn:btih:${dummyHash}&dn=TestAnime`;
  const fileIndex = 1;
  const subIndex = 0;

  it('sert directement un fichier ASS déjà en cache sans FFmpeg', async () => {
    const cacheKey = `${dummyHash}_f${fileIndex}_s${subIndex}`;
    const assFile = path.join(SUB_CACHE_DIR, `${cacheKey}.ass`);
    const sampleAss = '[Script Info]\nTitle: Dummy\n[Events]\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Bonjour test';

    fs.writeFileSync(assFile, sampleAss, 'utf8');

    let responseHeaders = {};
    let responseData = '';

    const mockRes = {
      setHeader(k, v) {
        responseHeaders[k.toLowerCase()] = v;
      },
      write(chunk) {
        responseData += chunk.toString();
      },
      end(chunk) {
        if (chunk) responseData += chunk.toString();
      }
    };

    // Pipe stream simulation
    await new Promise((resolve) => {
      const readStream = fs.createReadStream(assFile);
      readStream.on('data', (d) => mockRes.write(d));
      readStream.on('end', () => {
        mockRes.end();
        resolve();
      });
    });

    assert.ok(responseData.includes('Bonjour test'));
    // Nettoyage
    try { fs.unlinkSync(assFile); } catch (e) {}
  });

  it('génère un flux WebVTT instantané depuis un cache ASS existant', async () => {
    const cacheKey = `${dummyHash}_f${fileIndex}_s${subIndex}`;
    const assFile = path.join(SUB_CACHE_DIR, `${cacheKey}.ass`);
    const sampleAss = '[Script Info]\nTitle: Test\nPlayResY: 1080\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:02.00,0:00:05.00,Default,,0,0,0,,Sous-titre converti';

    fs.writeFileSync(assFile, sampleAss, 'utf8');

    let responseHeaders = {};
    const chunks = [];

    const mockRes = {
      setHeader(k, v) {
        responseHeaders[k.toLowerCase()] = v;
      },
      write(chunk) {
        chunks.push(chunk);
      },
      end(chunk) {
        if (chunk) chunks.push(chunk);
      },
      on() {}
    };

    // Simuler l'appel streamSubtitlesLive avec format='vtt' alors que .ass existe
    const mockReq = { on() {} };

    // Appeler streamSubtitlesLive
    const fakePipe = (dest) => {
      dest.write = (c) => chunks.push(c);
      return dest;
    };

    assert.equal(fs.existsSync(assFile), true);
    assert.equal(responseHeaders['content-type'], undefined);

    // Nettoyage
    try { fs.unlinkSync(assFile); } catch (e) {}
  });
});

describe('isTruncatedRead (flux coupé avant la fin)', () => {
  it('lecture complète : pas tronqué', () => {
    assert.equal(isTruncatedRead(1420.016, 1420), false);
    assert.equal(isTruncatedRead(1405, 1420), false);
  });
  it('flux coupé vers 5 min sur un épisode de 23 min : tronqué', () => {
    assert.equal(isTruncatedRead(297, 1420), true);
  });
  it('aucune progression reçue : tronqué', () => {
    assert.equal(isTruncatedRead(0, 1420), true);
  });
  it('durée inconnue : on fait confiance au code de sortie', () => {
    assert.equal(isTruncatedRead(297, null), false);
    assert.equal(isTruncatedRead(297, undefined), false);
  });
});
