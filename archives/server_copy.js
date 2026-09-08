import express from 'express';
import Parser from 'rss-parser';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const app = express();
const execPromise = promisify(exec);

// --- CONFIGURATION ---
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
            .search-box { margin-bottom: 30px; display: flex; justify-content: center; align-items: center; gap: 10px; flex-wrap: wrap; }
            input[type="text"] { padding: 12px; width: 300px; border-radius: 5px; border: none; font-size: 16px; outline: none; color: #000; }
            select { padding: 12px; border-radius: 5px; font-size: 16px; border: none; outline: none; color: #000; background: white; cursor: pointer; }
            button { padding: 12px 20px; background: #e50914; color: white; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; font-weight: bold; }
            button:hover { background: #f40612; }
            
            #player-container { margin-top: 20px; display: none; background: #000; padding: 20px; border-radius: 10px; border: 1px solid #333; }
            video { width: 100%; max-width: 1000px; border: 1px solid #444; border-radius: 5px; background: #000; }
            
            .debug-tools { margin-top: 15px; display: flex; justify-content: center; gap: 10px; }
            .vlc-btn { background: #ff8800; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px; font-weight: bold; font-size: 14px; }
            .vlc-btn:hover { background: #e67a00; }
            
            #results { display: flex; flex-direction: column; gap: 10px; max-width: 800px; margin: 30px auto; }
            .torrent-card { background: #222; padding: 15px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; text-align: left; border: 1px solid #333; }
            .torrent-info h3 { margin: 0 0 5px 0; font-size: 16px; }
            .seeders { color: #4caf50; font-weight: bold; }
            .play-btn { background: #e50914; color: white; padding: 10px 15px; border-radius: 5px; cursor: pointer; border: none; font-weight: bold; min-width: 80px; text-align: center;}
        </style>
    </head>
    <body>
      <h1>Mon Netflix Anime 🍿</h1>
      
      <div class="search-box">
          <input type="text" id="searchInput" placeholder="Chercher un anime..." onkeypress="if(event.key === 'Enter') searchNyaa()">
          
          <select id="searchType">
              <option value="vostfr">VOSTFR (Sous-titres FR)</option>
              <option value="vf">VF (Voix Françaises)</option>
              <option value="multisub">Multi-Sub (International)</option>
              <option value="sub">VOSTA (Sous-titres Anglais)</option>
              <option value="dub">DUB (Voix Anglaises)</option>
          </select>

          <button onclick="searchNyaa()">Chercher</button>
      </div>

      <div id="player-container">
          <h2 id="now-playing">Chargement... (Cela peut prendre 15 à 30 secondes)</h2>
          <video id="videoPlayer" controls autoplay></video>
          
          <div class="debug-tools">
              <a id="vlcLink" href="#" class="vlc-btn" onclick="copyToClipboard(this.href); return false;">
                🟠 Copier le lien brut pour VLC
              </a>
          </div>
      </div>

      <div id="results"></div>

      <script>
        const TORRSERVER_IP = "${TORRSERVER_IP}";

        async function searchNyaa() {
            const query = document.getElementById('searchInput').value;
            const type = document.getElementById('searchType').value;
            const resultsDiv = document.getElementById('results');
            
            if (!query) return;
            resultsDiv.innerHTML = '<p>Recherche en cours... ⏳</p>';
            
            try {
                const response = await fetch('/api/search?q=' + encodeURIComponent(query) + '&type=' + type);
                const torrents = await response.json();
                
                resultsDiv.innerHTML = '';
                
                if (torrents.length === 0) {
                    resultsDiv.innerHTML = '<p>Aucun résultat trouvé pour cette catégorie.</p>';
                    return;
                }
                
                torrents.forEach(torrent => {
                    const card = document.createElement('div');
                    card.className = 'torrent-card';
                    
                    const magnetEncoded = encodeURIComponent(torrent.lienMagnet);
                    const webUrl = '/play?magnet=' + magnetEncoded;
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
                resultsDiv.innerHTML = '<p style="color:red;">Erreur de connexion.</p>';
            }
        }

        function playVideo(webUrl, vlcUrl, titre) {
            document.getElementById('player-container').style.display = 'block';
            document.getElementById('now-playing').innerText = "Lecture : " + titre + " (Analyse en cours...)";
            document.getElementById('videoPlayer').src = webUrl;
            document.getElementById('vlcLink').href = vlcUrl; 
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => {
                alert("Lien copié ! Colle-le dans VLC (Média > Ouvrir un flux réseau)");
            });
        }
      </script>
    </body>
    </html>
  `);
});

// --- ROUTE 2 : LA RECHERCHE NYAA INTELLIGENTE ---
app.get('/api/search', async (req, res) => {
  let query = req.query.q;
  const type = req.query.type || 'vostfr';
  
  if (!query) return res.json([]);

  let category = '1_0';

  if (type === 'vostfr') {
      query += ' vostfr';
      category = '1_3'; 
  } else if (type === 'vf') {
      query += ' vf';
      category = '1_3'; 
  } else if (type === 'multisub') {
      query += ' multi';
      category = '1_2'; 
  } else if (type === 'sub') {
      category = '1_2'; 
  } else if (type === 'dub') {
      query += ' dub';
      category = '1_2'; 
  }

  const targetUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=${category}`;
  
  try {
    const response = await fetch(targetUrl, { headers: { 'User-Agent': 'ServeurAnime/1.0' } });
    const xmlText = await response.text();
    const feed = await parser.parseString(xmlText);
    const videos = feed.items.map(t => ({ 
        titre: t.title, lienMagnet: t.link, taille: t.size, seeders: parseInt(t.seeders, 10) || 0 
    }));
    res.json(videos);
  } catch (error) {
    console.error("Erreur Nyaa:", error);
    res.status(500).json({ error: 'Erreur Nyaa' });
  }
});

// --- FONCTION INTELLIGENTE : TROUVER LE FRANÇAIS ---
async function getSubtitleConfig(videoUrl) {
    try {
        console.log("🔍 Lancement de ffprobe pour analyser les langues...");
        const cmd = `ffprobe -v error -select_streams s -show_entries stream=index:stream_tags=language -of json "${videoUrl}"`;
        
        const { stdout } = await execPromise(cmd, { timeout: 15000 });
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        
        if (streams.length === 0) {
            console.log("ℹ️ Aucun sous-titre trouvé.");
            return null;
        }

        for (let i = 0; i < streams.length; i++) {
            const lang = streams[i].tags?.language?.toLowerCase();
            if (lang === 'fre' || lang === 'fra') {
                console.log(`✅ Sous-titre Français trouvé à l'index relatif : ${i}`);
                return i;
            }
        }
        
        console.log("⚠️ Pas de Français trouvé. Utilisation du sous-titre par défaut (0).");
        return 0;
    } catch (error) {
        console.error("❌ Erreur ffprobe :", error.message);
        return 0; // En cas de doute, on lance l'index 0
    }
}

// --- ROUTE 3 : LE TRANSCODEUR FFMPEG DYNAMIQUE ---
app.get('/play', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).send("Lien magnet manquant");

    const torrUrl = `http://${TORRSERVER_IP}:8090/stream?link=${encodeURIComponent(magnet)}&index=1&play`;

    // Analyse intelligente des sous-titres via ffprobe
    const subIndex = await getSubtitleConfig(torrUrl);

    res.setHeader('Content-Type', 'video/mp4');

    let ffmpegArgs = [
        '-re',
        '-i', torrUrl
    ];

    // Si on a trouvé des sous-titres, on ajoute le filtre d'incrustation
    if (subIndex !== null) {
        // Échappement des ':' pour que le filtre FFmpeg fonctionne
        const escapedUrl = torrUrl.replace(/:/g, '\\:');
        ffmpegArgs.push('-vf', `subtitles='${escapedUrl}':si=${subIndex}`);
        ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency');
    } else {
        // Pas de sous-titres (ex: VF pur) = Copie directe de la vidéo (soulage le processeur)
        ffmpegArgs.push('-c:v', 'copy');
    }

    // Conversion audio AAC et paramètres web
    ffmpegArgs.push(
        '-c:a', 'aac',
        '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4',
        'pipe:1'
    );

    console.log("🎬 Lancement de FFmpeg...");

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stdout.pipe(res);

    req.on('close', () => {
        console.log("🛑 Utilisateur déconnecté, arrêt de FFmpeg.");
        ffmpeg.kill('SIGKILL');
    });
});

// --- LANCEMENT DU SERVEUR ---
app.listen(3000, () => {
  console.log('✅ Serveur web lancé sur le port 3000 ! (Netflix Anime Ultimate)');
});