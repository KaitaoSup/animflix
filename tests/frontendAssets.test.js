import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAssetVersion, renderVersioned, APP_VERSION } from '../src/utils/assetVersion.js';

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const swJs = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');

const localScripts = [...indexHtml.matchAll(/<script src="(\/js\/[^"?]+)/g)].map(m => m[1]);
const precached = [...swJs.matchAll(/^\s*'(\/[^']*)',?$/gm)].map(m => m[1]);

describe('Ressources du front', () => {
  test('chaque <script> de index.html existe sur le disque', () => {
    assert.ok(localScripts.length > 10);
    for (const src of localScripts) {
      assert.ok(fs.existsSync(path.join(PUBLIC_DIR, src)), `${src} introuvable`);
    }
  });

  test('chaque fichier JS du front est chargé par index.html (aucun oubli après un découpage)', () => {
    const onDisk = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) onDisk.push('/' + path.relative(PUBLIC_DIR, full).split(path.sep).join('/'));
    });
    walk(path.join(PUBLIC_DIR, 'js'));
    assert.deepEqual([...onDisk].sort(), [...localScripts].sort());
  });

  test('le pré-cache du service worker liste les mêmes scripts, dans le même ordre, et des fichiers existants', () => {
    assert.deepEqual(precached.filter(p => p.startsWith('/js/')), localScripts);
    for (const p of precached) {
      if (p === '/') continue;
      assert.ok(fs.existsSync(path.join(PUBLIC_DIR, p)), `pré-cache : ${p} introuvable`);
    }
  });

  test('index.html et sw.js utilisent le marqueur de version (plus de numéros manuels)', () => {
    assert.ok(!/\.(js|css)\?v=\d/.test(indexHtml.replace(/\/vendor\/[^"]+/g, '')), 'version manuelle restante dans index.html');
    assert.ok(swJs.includes("'animflix-shell-{{ASSET_VERSION}}'"));
    const rendered = renderVersioned(path.join(PUBLIC_DIR, 'sw.js'), PUBLIC_DIR);
    assert.ok(!rendered.includes('{{ASSET_VERSION}}'));
    assert.ok(rendered.includes(`animflix-shell-${APP_VERSION}-`));
  });
});

describe('Page hors ligne (service worker)', () => {
  const offlineHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'offline.html'), 'utf8');

  test('offline.html est pré-cachée et utilisée par le service worker', () => {
    assert.ok(precached.includes('/offline.html'));
    assert.ok(swJs.includes("const OFFLINE_URL = '/offline.html'"));
  });

  test('offline.html est autonome (aucun script ni feuille de style externe)', () => {
    assert.ok(!/<script[^>]+src=/i.test(offlineHtml));
    assert.ok(!/<link[^>]+rel="stylesheet"/i.test(offlineHtml));
    assert.ok(offlineHtml.includes('/api/ping'));
  });

  test('la sonde /api/ping n\'est jamais servie depuis le cache', () => {
    assert.ok(swJs.includes("if (url.pathname === '/api/ping') return;"));
  });
});

describe('getAssetVersion', () => {
  test('stable si rien ne change, différente dès qu\'un fichier du front change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animflix-assets-'));
    try {
      fs.mkdirSync(path.join(dir, 'js'));
      fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
      fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'let a = 1;');
      const v1 = getAssetVersion(dir);
      assert.equal(getAssetVersion(dir), v1);
      assert.match(v1, new RegExp(`^${APP_VERSION.replace(/\./g, '\\.')}-[0-9a-f]{10}$`));

      fs.writeFileSync(path.join(dir, 'js', 'a.js'), 'let a = 2;');
      const v2 = getAssetVersion(dir);
      assert.notEqual(v2, v1);

      fs.writeFileSync(path.join(dir, 'js', 'b.js'), '');
      assert.notEqual(getAssetVersion(dir), v2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
