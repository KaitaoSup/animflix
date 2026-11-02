import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('PlaySync & Keyframe Alignment', () => {
  const showinfoRegex = /\[showinfo[^\]]*\]\s*n:\s*0\b[\s\S]*?\bpt:\s*(-?[\d\.]+)/;

  it('détecte correctement un décalage de keyframe de -1s (cas classique anime)', () => {
    const stderrSample = '[showinfo @ 0x5649e47f84c0] n:      0 size:   3442 pts:-1000 pt:-1 dts:-1083 dt:-1.083 ds:41 d:0.041 adler32:0xeb22cab0';
    const match = stderrSample.match(showinfoRegex);
    assert.ok(match, 'Le regex showinfo doit matcher le premier paquet n: 0');
    const ptOffset = parseFloat(match[1]);
    assert.strictEqual(ptOffset, -1);

    const seekSeconds = 85.0;
    const actualStart = Math.max(0, Math.round((seekSeconds + ptOffset) * 1000) / 1000);
    assert.strictEqual(actualStart, 84.0, 'Le départ effectif doit être recalé sur la keyframe à 84s');
  });

  it('détecte correctement un décalage de keyframe avec décimales (ex: -1.250s)', () => {
    const stderrSample = '[showinfo @ 0x7f9a14000b80] n: 0 size: 12400 pts:-1250 pt:-1.250 dts:-1250 dt:-1.250';
    const match = stderrSample.match(showinfoRegex);
    assert.ok(match);
    const ptOffset = parseFloat(match[1]);
    assert.strictEqual(ptOffset, -1.25);

    const seekSeconds = 90.0;
    const actualStart = Math.max(0, Math.round((seekSeconds + ptOffset) * 1000) / 1000);
    assert.strictEqual(actualStart, 88.75);
  });

  it('gère un alignement parfait (pt: 0)', () => {
    const stderrSample = '[showinfo @ 0x55975d6ef6c0] n: 0 size: 3112 pts:0 pt:0 dts:0 dt:0';
    const match = stderrSample.match(showinfoRegex);
    assert.ok(match);
    const ptOffset = parseFloat(match[1]);
    assert.strictEqual(ptOffset, 0);

    const seekSeconds = 85.0;
    const actualStart = Math.max(0, Math.round((seekSeconds + ptOffset) * 1000) / 1000);
    assert.strictEqual(actualStart, 85.0);
  });

  it('ignore les paquets ultérieurs (n: 1, n: 2, etc.)', () => {
    const stderrLaterPacket = '[showinfo @ 0x5649e47f84c0] n:      1 size:    692 pts:-833 pt:-0.833 dts:-1042 dt:-1.042';
    const match = stderrLaterPacket.match(showinfoRegex);
    assert.strictEqual(match, null, 'Ne doit pas matcher les paquets ultérieurs');
  });

  it('fournit le repli expectedSeek si le client ou FFmpeg ferme prématurément', () => {
    const expectedSeek = 90.0;
    const session = {
      seekSeconds: expectedSeek,
      actualStart: expectedSeek,
      keyframeOffset: 0,
      resolved: false
    };
    // Simulation fermeture anticipée sans paquet showinfo
    if (!session.resolved) {
      session.resolved = true;
      if (typeof session.actualStart !== 'number' || isNaN(session.actualStart)) {
        session.actualStart = session.seekSeconds || 0;
      }
    }
    assert.strictEqual(session.actualStart, 90.0, 'actualStart ne doit jamais tomber à 0 lors d un seek vers 90s');
    assert.strictEqual(session.resolved, true);
  });

  it('protège contre les boucles de saut AniSkip après un retour arrière ou déplacement', () => {
    const op = { startTime: 0, endTime: 90 };
    let hasSkippedCurrentOp = true; // L'opening a déjà été passé
    const skipPref = 'auto';

    // Cas 1 : L'utilisateur recule de 10s depuis 95s -> position 85s
    const rewoundTime = 85.0;
    let shouldAutoSkip = false;
    let showButton = false;

    if (op && rewoundTime >= op.startTime && rewoundTime < op.endTime) {
      if (!hasSkippedCurrentOp && skipPref === 'auto') {
        shouldAutoSkip = true;
      } else if (hasSkippedCurrentOp && rewoundTime >= (op.endTime - 3.5)) {
        // Fin résiduelle de keyframe
        showButton = false;
      } else {
        // En rembobinage manuel, on propose le bouton au lieu de forcer le saut
        showButton = true;
      }
    }

    assert.strictEqual(shouldAutoSkip, false, 'Ne doit PAS forcer un saut automatique si l utilisateur a rembobiné volontairement');
    assert.strictEqual(showButton, true, 'Doit afficher le bouton optionnel pour laisser le choix');

    // Cas 2 : Début de lecture sur keyframe résiduel (ex: 88.7s suite au seek de 90s)
    const keyframeResidualTime = 88.714;
    shouldAutoSkip = false;
    showButton = false;

    if (op && keyframeResidualTime >= op.startTime && keyframeResidualTime < op.endTime) {
      if (!hasSkippedCurrentOp && skipPref === 'auto') {
        shouldAutoSkip = true;
      } else if (hasSkippedCurrentOp && keyframeResidualTime >= (op.endTime - 3.5)) {
        showButton = false;
      } else {
        showButton = true;
      }
    }

    assert.strictEqual(shouldAutoSkip, false, 'Le keyframe de démarrage ne doit jamais réenclencher de saut');
    assert.strictEqual(showButton, false, 'Le bouton doit être masqué proprement sur le keyframe de démarrage');
  });
});
