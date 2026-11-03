import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'stream';
import { AssToVttStream } from '../src/services/subtitlesService.js';

describe('AssToVttStream Transform', () => {
  it('convertit les dialogues standard ASS en WebVTT propre', async () => {
    const assInput = [
      '[Script Info]',
      'Title: Test',
      'PlayResY: 1080',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:01:23.45,0:01:26.78,Default,,0,0,0,,Bonjour tout le monde !',
      'Dialogue: 0,0:01:27.00,0:01:29.50,Default,,0,0,0,,Deuxième ligne avec {\\b1}gras{\\b0} et \\Nnouvelle ligne.'
    ].join('\n');

    const stream = Readable.from([assInput]).pipe(new AssToVttStream());

    let output = '';
    for await (const chunk of stream) {
      output += chunk.toString('utf8');
    }

    assert.ok(output.startsWith('WEBVTT\n\n'));
    assert.ok(output.includes('00:01:23.450 --> 00:01:26.780 line:85% align:center'));
    assert.ok(output.includes('Bonjour tout le monde !'));
    assert.ok(output.includes('00:01:27.000 --> 00:01:29.500 line:85% align:center'));
    assert.ok(output.includes('Deuxième ligne avec gras et \nnouvelle ligne.'));
  });

  it('détecte et positionne les sous-titres en haut de l\'écran (\\an8 ou pancarte)', async () => {
    const assInput = [
      '[Script Info]',
      'PlayResY: 1080',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:10.00,0:00:15.00,Sign,,0,0,0,,{\\an8}[Panneau : Académie de Magie]'
    ].join('\n');

    const stream = Readable.from([assInput]).pipe(new AssToVttStream());

    let output = '';
    for await (const chunk of stream) {
      output += chunk.toString('utf8');
    }

    assert.ok(output.includes('line:8% align:center'));
    assert.ok(output.includes('[Panneau : Académie de Magie]'));
  });

  it('laisse passer un flux déjà au format WebVTT natif sans altération', async () => {
    const vttInput = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nDéjà WebVTT\n\n';
    const stream = Readable.from([vttInput]).pipe(new AssToVttStream());

    let output = '';
    for await (const chunk of stream) {
      output += chunk.toString('utf8');
    }

    assert.strictEqual(output, vttInput);
  });

  it('ignore les masques vectoriels ({\\p1}) des panneaux mais garde le texte', async () => {
    const assInput = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:01:46.67,0:01:48.17,signs,sign,0,0,0,,{\\clip(1227,59,1229,247)\\pos(960,540)\\an5\\p1\\c&HF6F7F4&}m 297.49 -376.15 l 407.12 -387.24 407.94 -209.43',
      'Dialogue: 0,0:01:50.00,0:01:52.00,signs,sign,0,0,0,,{\\p1}m 0 0 l 10 0 10 10{\\p0\\pos(960,200)}Boulangerie',
      'Dialogue: 0,0:01:25.02,0:01:27.03,signs,sign,0,0,0,,{\\fnNunito Bold\\pos(1004.8,247.2)}Renako'
    ].join('\n');

    const stream = Readable.from([assInput]).pipe(new AssToVttStream());
    let output = '';
    for await (const chunk of stream) output += chunk.toString('utf8');

    assert.ok(!output.includes('m 297.49'));
    assert.ok(!output.includes('00:01:46.670'));
    assert.ok(output.includes('Boulangerie'));
    assert.ok(!output.includes('l 10 0'));
    assert.ok(output.includes('Renako'));
  });
});
