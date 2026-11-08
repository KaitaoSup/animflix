import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSkipChapters } from '../src/services/chapters.js';

const ch = (start, end, title) => ({ start_time: String(start), end_time: String(end), tags: title === undefined ? {} : { title } });

describe('detectSkipChapters', () => {
  test('chapitres classiques de fansub (Prologue / Opening / Partie A / Ending / Preview)', () => {
    const result = detectSkipChapters([
      ch(0, 95.5, 'Prologue'),
      ch(95.5, 185.5, 'Opening'),
      ch(185.5, 800, 'Part A'),
      ch(800, 1290, 'Part B'),
      ch(1290, 1380, 'Ending'),
      ch(1380, 1420, 'Preview')
    ], 1420);
    assert.deepEqual(result, {
      op: { startTime: 95.5, endTime: 185.5 },
      ed: { startTime: 1290, endTime: 1380 },
      preview: { startTime: 1380, endTime: 1420 }
    });
  });

  test('récap en début d’épisode et aperçu du prochain épisode', () => {
    const result = detectSkipChapters([
      ch(0, 60, 'Recap'),
      ch(60, 150, 'OP'),
      ch(150, 1300, 'Episode'),
      ch(1300, 1390, 'ED'),
      ch(1390, 1420, 'Next Episode')
    ], 1420);
    assert.deepEqual(result.recap, { startTime: 0, endTime: 60 });
    assert.deepEqual(result.preview, { startTime: 1390, endTime: 1420 });
    assert.ok(detectSkipChapters([ch(0, 45, 'Résumé')], 1400).recap);
    assert.ok(detectSkipChapters([ch(0, 45, 'Précédemment')], 1400).recap);
    assert.ok(detectSkipChapters([ch(1370, 1400, 'Prochain épisode')], 1400).preview);
    assert.ok(detectSkipChapters([ch(1370, 1400, 'Avant-première')], 1400).preview);
  });

  test('récap ou aperçu mal placés ou de durée improbable ignorés', () => {
    // « Recap » au milieu de l'épisode, « Preview » en début : chapitres mal nommés
    assert.equal(detectSkipChapters([ch(700, 760, 'Recap'), ch(10, 40, 'Preview')], 1400), null);
    assert.equal(detectSkipChapters([ch(1380, 1382, 'Preview')], 1400), null);
    assert.equal(detectSkipChapters([ch(0, 600, 'Recap')], 1400), null);
    // « Resume » ne doit pas attraper un titre de chapitre comme « Résurrection »
    assert.equal(detectSkipChapters([ch(0, 60, 'Résurrection')], 1400), null);
  });

  test('variantes de noms : OP1 / ED, français accentué, « Opening Song »', () => {
    assert.ok(detectSkipChapters([ch(0, 90, 'OP1')], 1400).op);
    assert.ok(detectSkipChapters([ch(0, 90, 'OP')], 1400).op);
    assert.ok(detectSkipChapters([ch(0, 90, 'Opening Song')], 1400).op);
    assert.ok(detectSkipChapters([ch(0, 90, 'Générique de début')], 1400).op);
    assert.ok(detectSkipChapters([ch(1300, 1390, 'ED')], 1400).ed);
    assert.ok(detectSkipChapters([ch(1300, 1390, 'Générique de fin')], 1400).ed);
    assert.ok(detectSkipChapters([ch(1300, 1390, 'Credits')], 1400).ed);
  });

  test("n'interprète pas des titres qui ressemblent seulement à OP / ED", () => {
    assert.equal(detectSkipChapters([ch(0, 90, 'Opera'), ch(1300, 1390, 'Edition spéciale'), ch(500, 590, 'Episode')], 1400), null);
  });

  test('écarte les chapitres trop courts, trop longs ou sans titre', () => {
    assert.equal(detectSkipChapters([ch(0, 5, 'Opening')], 1400), null);
    assert.equal(detectSkipChapters([ch(0, 600, 'Opening')], 1400), null);
    assert.equal(detectSkipChapters([ch(0, 90)], 1400), null);
    assert.equal(detectSkipChapters([], 1400), null);
    assert.equal(detectSkipChapters(undefined, 1400), null);
  });

  test('ignore un ending placé avant l’opening et borne la fin à la durée', () => {
    const result = detectSkipChapters([ch(0, 60, 'Ending'), ch(60, 150, 'Opening'), ch(1350, 1500, 'Ending')], 1420);
    assert.deepEqual(result, { op: { startTime: 60, endTime: 150 }, ed: { startTime: 1350, endTime: 1420 } });
  });
});
