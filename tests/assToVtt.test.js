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
});
