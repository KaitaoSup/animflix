#!/usr/bin/env bash
set -e

# ==============================================================================
# Script d'installation automatique multi-architecture pour TorrServer (MatriX)
# Supporte : x86_64 (amd64), aarch64 (arm64), armv7l (arm7)
# ==============================================================================

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        TS_ARCH="amd64"
        ;;
    aarch64|arm64)
        TS_ARCH="arm64"
        ;;
    armv7*|armhf)
        TS_ARCH="arm7"
        ;;
    *)
        echo "❌ Architecture non reconnue : $ARCH"
        exit 1
        ;;
esac

BINARY_NAME="TorrServer-linux-${TS_ARCH}"
TARGET_LINK="TorrServer"

echo "🔍 Détection de l'architecture : $ARCH ($TS_ARCH)"

# Récupération de la dernière release MatriX de TorrServer via l'API GitHub
echo "🌐 Recherche de la dernière version de TorrServer..."
LATEST_TAG=$(curl -s "https://api.github.com/repos/YouROK/TorrServer/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' || true)

if [ -z "$LATEST_TAG" ]; then
    LATEST_TAG="MatriX.133"
    echo "⚠️ Impossible de contacter l'API GitHub, utilisation du tag de repli : $LATEST_TAG"
else
    echo "✅ Version trouvée : $LATEST_TAG"
fi

DOWNLOAD_URL="https://github.com/YouROK/TorrServer/releases/download/${LATEST_TAG}/${BINARY_NAME}"

echo "⬇️ Téléchargement depuis : $DOWNLOAD_URL"
curl -L -f -o "$BINARY_NAME" "$DOWNLOAD_URL"
chmod +x "$BINARY_NAME"

# Créer un lien symbolique universel TorrServer -> binaire architectural
ln -sf "$BINARY_NAME" "$TARGET_LINK"

echo "🎉 TorrServer ($BINARY_NAME) installé avec succès !"
echo "👉 Pour le lancer directement : ./$BINARY_NAME"
