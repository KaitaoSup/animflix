module.exports = {
  apps: [
    {
      name: 'torrserver',
      // Attend que le réseau soit prêt (sinon le DHT de TorrServer reste vide jusqu'au prochain redémarrage)
      script: './scripts/start-torrserver.sh',
      exec_mode: 'fork',
      interpreter: 'none',
      autorestart: true,
      // Le cache RAM de TorrServer (CacheSize, 200 Mo) est alloué PAR torrent : 2 torrents actifs
      // (épisode en cours + préchargement du suivant) + le runtime Go dépassent 500 Mo
      max_memory_restart: '1200M'
    },
    {
      name: 'animflix',
      script: './animflix.js',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
