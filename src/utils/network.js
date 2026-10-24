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
