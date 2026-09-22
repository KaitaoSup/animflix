#!/usr/bin/env bash
set -e

# Démarrage de TorrServer en arrière-plan
echo "🚀 Démarrage du moteur P2P TorrServer sur le port 8090..."
/app/TorrServer -p 8090 &
TS_PID=$!

# Attendre que TorrServer soit prêt
for i in {1..15}; do
  if curl -s http://127.0.0.1:8090/echo > /dev/null 2>&1; then
    echo "✅ TorrServer est prêt et répond !"
    break
  fi
  sleep 1
done

# Démarrage du serveur web Animflix
echo "🍿 Démarrage du serveur web Animflix..."
node animflix.js &
NODE_PID=$!

# Gestion propre des signaux d'arrêt SIGTERM et SIGINT
trap "kill -SIGTERM $NODE_PID $TS_PID; exit 0" SIGINT SIGTERM

wait -n
