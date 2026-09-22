# Multi-Architecture Dockerfile pour Animflix (ServeurAnimeTorr)
FROM node:20-bookworm-slim

# Arguments de build Docker Buildx
ARG TARGETARCH

# Installation de FFmpeg, pilotes VAAPI matériels, curl et certificats SSL
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    va-driver-all \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Téléchargement automatique du binaire TorrServer adapté à l'architecture cible
RUN case "${TARGETARCH}" in \
      "amd64") TS_ARCH="amd64" ;; \
      "arm64") TS_ARCH="arm64" ;; \
      "arm/v7"|"arm") TS_ARCH="arm7" ;; \
      *) TS_ARCH="amd64" ;; \
    esac && \
    echo "Downloading TorrServer for ${TS_ARCH}..." && \
    curl -L -f -o /app/TorrServer "https://github.com/YouROK/TorrServer/releases/download/MatriX.133/TorrServer-linux-${TS_ARCH}" && \
    chmod +x /app/TorrServer

# Installation des dépendances npm
COPY package*.json ./
RUN npm install --omit=dev

# Copie de l'ensemble du projet
COPY . .
RUN chmod +x scripts/*.sh

# Création des dossiers de cache persistants
RUN mkdir -p /app/cache/subtitles

# Ports exposés : 3000 (Animflix Web), 8090 (TorrServer Engine)
EXPOSE 3000 8090

ENV PORT=3000
ENV TORRSERVER_URL=http://127.0.0.1:8090
ENV FFMPEG_HWACCEL=auto

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
