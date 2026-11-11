import os from 'os';

/**
 * Extraction du hash SHA1 (btih) depuis un magnet link
 */
export function getTorrentHash(magnet) {
  if (!magnet) return 'unknown';
  const match = magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
  if (match) return match[1].toLowerCase();
  let hash = 0;
  for (let i = 0; i < magnet.length; i++) {
    hash = ((hash << 5) - hash) + magnet.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

/**
 * infoHash au format hexadécimal (celui renvoyé par TorrServer) : les magnets en base32
 * (32 caractères) sont convertis, les autres valeurs renvoyées telles quelles en minuscules
 */
export function toHexInfoHash(hash) {
  if (typeof hash !== 'string') return hash;
  const value = hash.toLowerCase();
  if (!/^[a-z2-7]{32}$/.test(value)) return value;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = '';
  for (const c of value) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i < 160; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

// infoHash BitTorrent v1 : 40 caractères hexadécimaux ou 32 caractères base32
const INFO_HASH_RE = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;
const MAX_MAGNET_LENGTH = 4096;

/**
 * Vérifie qu'une valeur est un infoHash BitTorrent valide
 */
export function isValidInfoHash(value) {
  return typeof value === 'string' && INFO_HASH_RE.test(value);
}

/**
 * Vérifie qu'une valeur est un lien magnet BitTorrent valide (refuse les URL http/file/etc.
 * que TorrServer accepterait sinon et irait télécharger côté serveur)
 */
export function isValidMagnet(value) {
  if (typeof value !== 'string' || value.length > MAX_MAGNET_LENGTH) return false;
  if (!value.toLowerCase().startsWith('magnet:?')) return false;
  const params = new URLSearchParams(value.slice('magnet:?'.length));
  return params.getAll('xt').some(xt => {
    const m = /^urn:btih:(.+)$/i.exec(xt);
    return m !== null && isValidInfoHash(m[1]);
  });
}

/**
 * Middleware Express : rejette toute requête dont les paramètres `magnet` / `hash`
 * (query ou body) sont présents mais invalides
 */
export function validateTorrentParams(req, res, next) {
  for (const source of [req.query, req.body]) {
    if (!source || typeof source !== 'object') continue;
    if (source.magnet !== undefined && source.magnet !== '' && !isValidMagnet(source.magnet)) {
      return res.status(400).json({ error: "Lien magnet invalide" });
    }
    if (source.hash !== undefined && source.hash !== '' && !isValidInfoHash(source.hash)) {
      return res.status(400).json({ error: "Hash de torrent invalide" });
    }
  }
  next();
}

/**
 * Détection des adresses IP locales (LAN Wi-Fi/Ethernet & Tailscale) pour Cast / AirPlay / TV
 */
export function getServerNetworkIps() {
  let lanIp = null;
  let tailscaleIp = null;
  try {
    const interfaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(interfaces)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          if (addr.address.startsWith('100.') || name.toLowerCase().includes('tailscale')) {
            if (!tailscaleIp) tailscaleIp = addr.address;
          } else if (
            addr.address.startsWith('192.168.') ||
            addr.address.startsWith('10.') ||
            /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr.address)
          ) {
            if (!lanIp) lanIp = addr.address;
          }
        }
      }
    }
  } catch (e) {}
  return { lanIp, tailscaleIp };
}

/**
 * Formatage lisible des débits réseau
 */
export function formatBytesSpeed(bytes) {
  if (!bytes || bytes <= 0) return '0 Ko/s';
  if (bytes < 1024) return `${bytes.toFixed(0)} o/s`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko/s`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} Mo/s`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go/s`;
}

/**
 * Formatage lisible des tailles de fichiers
 */
export function formatBytesSize(bytes) {
  if (!bytes || bytes <= 0) return '0 Mo';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} Go`;
}
