import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Version applicative (affichée dans les réglages) : source unique = package.json
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
export const APP_VERSION = PACKAGE_JSON.version;

const VERSIONED_DIRS = ['js', 'css'];
const VERSIONED_FILES = ['index.html', 'sw.js', 'manifest.json'];

function listFiles(publicDir) {
  const files = VERSIONED_FILES.map(f => path.join(publicDir, f)).filter(f => fs.existsSync(f));
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  VERSIONED_DIRS.forEach(d => walk(path.join(publicDir, d)));
  return files.sort();
}

/**
 * Empreinte du contenu du front (JS, CSS, HTML, SW).
 * Sert au paramètre ?v= des ressources ET au nom du cache du service worker : toute modification
 * d'un fichier du front invalide automatiquement le cache des navigateurs, sans numéro à incrémenter.
 * Recalculée à chaque appel (index.html / sw.js uniquement, ~2 ms) : une mise en cache basée sur la
 * date de modification raterait deux écritures de même taille dans le même tic d'horloge du noyau.
 */
export function getAssetVersion(publicDir) {
  const hash = crypto.createHash('sha256');
  for (const f of listFiles(publicDir)) {
    hash.update(path.relative(publicDir, f));
    hash.update('\0');
    hash.update(fs.readFileSync(f));
    hash.update('\0');
  }
  return `${APP_VERSION}-${hash.digest('hex').slice(0, 10)}`;
}

/**
 * Remplace le marqueur {{ASSET_VERSION}} dans un fichier texte du front
 */
export function renderVersioned(filePath, publicDir) {
  return fs.readFileSync(filePath, 'utf8').replaceAll('{{ASSET_VERSION}}', getAssetVersion(publicDir));
}
