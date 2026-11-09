import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// theme.js est un script de navigateur : on l'exécute avec un document et un localStorage factices
function loadTheme() {
  const store = {};
  const attrs = {};
  const ctx = {
    window: {},
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    document: {
      documentElement: {
        style: { setProperty() {}, removeProperty() {} },
        setAttribute: (k, v) => { attrs[k] = v; },
        removeAttribute: (k) => { delete attrs[k]; }
      },
      querySelector: () => null,
      getElementById: () => null
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/js/theme.js', 'utf8'), ctx);
  return { ctx, store, attrs };
}

const luminance = (hex) => {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
};

describe('Thème — couleur propre à chaque anime', () => {
  test('couleur d\'affiche claire ramenée sous le seuil de lisibilité du texte blanc', () => {
    const { ctx } = loadTheme();
    for (const c of ['#e4a15d', '#f1e4a1', '#5da1e4']) {
      const style = ctx.animeAccentStyle(c);
      const primary = /--primary: (#[0-9a-f]{6})/.exec(style)?.[1];
      assert.ok(primary, `pas de --primary pour ${c}`);
      assert.ok(luminance(primary) <= 0.30 + 1e-6, `${c} -> ${primary} trop clair`);
      assert.match(style, /--primary-rgb: \d+, \d+, \d+;/);
    }
  });

  test('affiche grise, valeur invalide ou option coupée : accent de l\'interface conservé', () => {
    const { ctx, store } = loadTheme();
    assert.equal(ctx.animeAccentStyle('#e4e4e4'), '');
    assert.equal(ctx.animeAccentStyle(null), '');
    assert.equal(ctx.animeAccentStyle('red; background: url(x)'), '');
    store.animflix_anime_accent = 'off';
    assert.equal(ctx.animeAccentStyle('#e4a15d'), '');
  });
});

describe('Thème — fond Noir OLED', () => {
  test('appliqué sur <html> et mémorisé sur l\'appareil', () => {
    const { ctx, store, attrs } = loadTheme();
    assert.equal(ctx.getBackgroundTheme(), 'dark');
    assert.equal(attrs['data-bg'], undefined);
    ctx.setBackgroundTheme('oled');
    assert.equal(attrs['data-bg'], 'oled');
    assert.equal(store.animflix_bg_theme, 'oled');
    ctx.setBackgroundTheme('n importe quoi');
    assert.equal(attrs['data-bg'], undefined);
    assert.equal(store.animflix_bg_theme, undefined);
  });
});
