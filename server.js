import express from 'express';
import Parser from 'rss-parser';
import { spawn } from 'child_process';

const app = express();

const TORRSERVER_IP = "192.168.1.55"; 

const parser = new Parser({
  customFields: {
    item: [['nyaa:seeders', 'seeders'], ['nyaa:size', 'size']],
  },
});

// --- ROUTE 1 : L'INTERFACE WEB (FRONTEND) ---
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Mon Netflix Anime 🍿</title>
        <style>
            body { background: #141414; color: white; font-family: sans-serif; margin: 0; padding: 20px; text-align: center; }
            h1 { color: #e50914; }
            .search-box { margin-bottom: 30px; }
            input[type="text"] { padding: 12px; width: 300px; border-radius: 5px; border: none; font-size: 16px; outline: none; color: #000; }
            button { padding: 12px 20px; background: #e50914; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; font-weight: bold; }
            
            #player-container { margin-top: 20px; display: none; background: #000; padding: 20px; border-radius: 10px; border: 1px solid #333; }
            video { width: 80%; max-width: 1000px; border: 1px solid #444; border-radius: 5px; background: #000; }
            
            .debug-tools { margin-top: 15px; display: flex; justify-content: center; gap: 10px; }
            .vlc-btn { background: #ff8800; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px; }
            .vlc-btn:hover { background: #e67a00; }

            #results { display: flex; flex-direction: column; gap: 10px; max-width: 800px; margin: 30px auto; }
            .torrent-card { background: #222; padding: 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; text-align: left; border: 1px solid #333; }
            .torrent-info h3 { margin: 0 0 5px 0; font-size: 16px; }
            .seeders { color: #4caf50; font-weight: bold; }
            .play-btn { background: #e50914; color: white; padding: 10px 15px; border-radius: 5px; cursor: pointer; border: none; font-weight: bold; }
        </style>
    </head>
    <body>
      <h1>Mon Netflix Anime 🍿</h1>
      
      <div class="search-box">
          <input type="text" id="searchInput" placeholder="Chercher un anime..." onkeypress="if(event.key === 'Enter') searchNyaa()">
          <button onclick="searchNyaa()">Chercher</button>
      </div>

      <div id="player-container">
          <h2 id="now-playing">Chargement...</h2>
          <video id="videoPlayer" controls autoplay></video>
          
          <div class="debug-tools">
              <a id="vlcLink" href="#" class="vlc-btn" onclick="copyToClipboard(this.href); return false;">
                🟠 Copier le lien brut pour VLC
              </a>
          </div>
      </div>

      <div id="results"></div>

      <script>
        // On injecte l'IP du serveur pour pouvoir générer le lien brut TorrServer
        const TORRSERVER_IP = "${TORRSERVER_IP}";

        async function searchNyaa() {
            const query = document.getElementById('searchInput').value;
            const resultsDiv = document.getElementById('results');
            if (!query) return;
            resultsDiv.innerHTML = '<p>Recherche en cours... ⏳</p>';
            try {
                const response = await fetch('/api/search?q=' + encodeURIComponent(query));
                const torrents = await response.json();
                resultsDiv.innerHTML = '';
                torrents.forEach(torrent => {
                    const card = document.createElement('div');
                    card.className = 'torrent-card';
                    
                    const magnetEncoded = encodeURIComponent(torrent.lienMagnet);
                    
                    // 1. URL pour le navigateur (Passe par Node.js et FFmpeg)
                    const webUrl = '/play?magnet=' + magnetEncoded;
                    
                    // 2. URL pour VLC (Passe directement par TorrServer, pur et sans transcodage)
                    const vlcUrl = \`http://\${TORRSERVER_IP}:8090/stream?link=\${magnetEncoded}&index=1&play\`;

                    card.innerHTML = \`
                        <div class="torrent-info">
                            <h3>\${torrent.titre}</h3>
                            <div class="torrent-stats">Taille: \${torrent.taille} | <span class="seeders">Seeders: \${torrent.seeders}</span></div>
                        </div>
                        <button class="play-btn" onclick="playVideo('\${webUrl}', '\${vlcUrl}', '\${torrent.titre.replace(/'/g, "\\\\'")}')">▶ Lire</button>
                    \`;
                    resultsDiv.appendChild(card);
                });
            } catch (err) {
                resultsDiv.innerHTML = '<p style="color:red;">Erreur de connexion au serveur.</p>';
            }
        }

        function playVideo(webUrl, vlcUrl, titre) {
            document.getElementById('player-container').style.display = 'block';
            document.getElementById('now-playing').innerText = "Lecture : " + titre;
            
            // On sépare les deux flux !
            document.getElementById('videoPlayer').src = webUrl;
            document.getElementById('vlcLink').href = vlcUrl; 
            
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert("Lien brut copié ! Colle-le dans VLC (Média > Ouvrir un flux réseau)");
            });
        }
      </script>
    </body>
    </html>
  `);
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.json([]);
  const targetUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=1_2`;
  try {
    const response = await fetch(targetUrl, { headers: { 'User-Agent': 'ServeurAnime/1.0' } });
    const xmlText = await response.text();
    const feed = await parser.parseString(xmlText);
    const videos = feed.items.map(t => ({ 
        titre: t.title, 
        lienMagnet: t.link, 
        taille: t.size, 
        seeders: parseInt(t.seeders, 10) || 0 
    }));
    res.json(videos);
  } catch (error) {
    res.status(500).json({ error: 'Erreur Nyaa' });
  }
});

// --- ROUTE 3 : LE TRANSCODEUR AVEC SOUS-TITRES (HARDCODING) ---
app.get('/play', (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).send("Lien magnet manquant");

    const torrUrl = `http://${TORRSERVER_IP}:8090/stream?link=${encodeURIComponent(magnet)}&index=1&play`;

    res.setHeader('Content-Type', 'video/mp4');

    // On utilise une syntaxe plus simple pour le filtre subtitles
    const ffmpeg = spawn('ffmpeg', [
        '-re',                       // Lit à la vitesse réelle (plus stable pour le streaming)
        '-i', torrUrl,
        '-vf', `subtitles=filename='${torrUrl}'`, 
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',      // Réduit le temps d'attente avant le début
        '-c:a', 'aac',
        '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4',
        'pipe:1'
    ]);

    ffmpeg.stdout.pipe(res);

    // AFFICHAGE DES ERREURS (Très important pour comprendre pourquoi ça bloque)
    ffmpeg.stderr.on('data', (data) => {
        console.log(`FFmpeg Log: ${data.toString()}`);
    });

    req.on('close', () => {
        ffmpeg.kill('SIGKILL');
    });
});

app.listen(3000, () => {
  console.log('✅ Serveur web lancé avec FFmpeg sur le port 3000 !');
});