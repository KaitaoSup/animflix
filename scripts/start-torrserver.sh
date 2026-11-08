#!/bin/sh
# Lancement de TorrServer par PM2.
#
# TorrServer n'initialise son DHT (recherche de pairs sans tracker) qu'une seule fois, au démarrage.
# Au boot de la machine, PM2 le lance souvent avant que le réseau soit prêt : le DHT reste alors vide
# pour toute la session ("error bootstrapping dht: nothing resolved"). On attend donc que la
# résolution DNS fonctionne, au plus 90 s, avant de le démarrer.

cd "$(dirname "$0")/.." || exit 1

i=0
while [ "$i" -lt 90 ]; do
  if getent hosts router.bittorrent.com >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 0 ]; then
    echo "⏳ Réseau indisponible : attente avant le démarrage de TorrServer..."
  fi
  i=$((i + 1))
  sleep 1
done

# exec : TorrServer remplace le shell et reçoit directement les signaux de PM2
exec ./TorrServer-linux-amd64 "$@"
