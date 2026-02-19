import express from 'express';
import Parser from 'rss-parser';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const app = express();
const execPromise = promisify(exec);

// --- CONFIGURATION ---
const TORRSERVER_IP = "192.168.1.55"; 
const TMDB_API_KEY = "3fdc6d0d7e26ee891af1f1ba1469a4e8"; // <--- METS TA CLÉ ICI

const parser = new Parser({
  customFields: {
    item: [['nyaa:seeders', 'seeders'], ['nyaa:size', 'size']],
  },
});

// --- ROUTE 1 : L'INTERFACE WEB (DESIGN NETFLIX + FILTRES) ---
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Mon Netflix Anime 🍿</title>
        <style>
            body { background: #0b0b0b; color: white; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; margin: 0; padding: 0; }
            .navbar { background: rgba(0,0,0,0.9); padding: 15px 50px; position: fixed; width: 100%; z-index: 100; display: flex; align-items: center; gap: 20px; box-sizing: border-box;}
            .logo { color: #e50914; font-size: 24px; font-weight: bold; text-decoration: none; }
            
            .search-box { display: flex; gap: 10px; }
            input[type="text"] { padding: 10px; width: 250px; border-radius: 4px; border: 1px solid #333; background: #222; color: white; outline: none; }
            select { padding: 10px; border-radius: 4px; border: 1px solid #333; background: #222; color: white; cursor: pointer; }
            button { padding: 10px 20px; background: #e50914; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }

            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 25px; padding: 120px 50px 50px; }
            .card { cursor: pointer; transition: transform 0.3s; position: relative; border-radius: 8px; overflow: hidden; background: #141414; border: 1px solid #222; }
            .card:hover { transform: scale(1.05); z-index: 5; border-color: #e50914; }
            .card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; display: block; }
            .card-info { padding: 12px; font-size: 13px; background: #141414; }
            .card-title { font-weight: bold; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
            .stats { color: #aaa; font-size: 11px; }
            .seeders { color: #4caf50; font-weight: bold; }

            #player-container { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); z-index: 200; display: none; flex-direction: column; align-items: center; justify-content: center; }
            video { width: 85%; max-height: 80vh; border: 2px solid #333; }
            .close-btn { position: absolute; top: 20px; right: 40px; font-size: 40px; cursor: pointer; color: white; }
            .vlc-btn { margin-top: 15px; color: #ff8800; text-decoration: none; font-weight: bold; }
        </style>
    </head>
    <body>
      <div class="navbar">
          <a href="/" class="logo">ANIMEFLIX</a>
          <div class="search-box">
              <input type="text" id="searchInput" placeholder="Chercher un anime..." onkeypress="if(event.key === 'Enter') searchNyaa()">
              <select id="searchType">
                  <option value="vostfr">VOSTFR</option>
                  <option value="vf">VF</option>
                  <option value="multisub">Multi-Sub</option>
                  <option value="sub">VOSTA</option>
              </select>
              <button onclick="searchNyaa()">Chercher</button>
          </div>
      </div>

      <div id="results" class="grid"></div>

      <div id="player-container">
          <span class="close-btn" onclick="closePlayer()">&times;</span>
          <h2 id="now-playing" style="margin-bottom: 10px;"></h2>
          <video id="videoPlayer" controls autoplay></video>
          <a id="vlcLink" href="#" class="vlc-btn" onclick="copyToClipboard(this.href); return false;">🟠 Copier le lien brut pour VLC</a>
      </div>

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
                
                torrents.forEach(t => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    const webUrl = '/play?magnet=' + encodeURIComponent(t.lienMagnet);
                    const vlcUrl = \`http://\${TORRSERVER_IP}:8090/stream?link=\${encodeURIComponent(t.lienMagnet)}&index=1&play\`;

                    card.innerHTML = \`
                        <img src="\${t.poster}" onerror="this.src='https://via.placeholder.com/200x300?text=Pas+d+image'">
                        <div class="card-info">
                            <span class="card-title" title="\${t.titre}">\${t.titre}</span>
                            <div class="stats">
                                ⭐ \${t.rating} | \${t.taille}<br>
                                <span class="seeders">Seeders: \${t.seeders}</span>
                            </div>
                        </div>
                    \`;
                    card.onclick = () => playVideo(webUrl, vlcUrl, t.titre);
                    resultsDiv.appendChild(card);
                });
            } catch (err) { resultsDiv.innerHTML = '<p style="color:red;">Erreur de connexion.</p>'; }
        }

        function playVideo(webUrl, vlcUrl, titre) {
            document.getElementById('player-container').style.display = 'flex';
            document.getElementById('now-playing').innerText = "Lecture : " + titre;
            document.getElementById('videoPlayer').src = webUrl;
            document.getElementById('vlcLink').href = vlcUrl;
        }

        function closePlayer() {
            document.getElementById('player-container').style.display = 'none';
            document.getElementById('videoPlayer').pause();
            document.getElementById('videoPlayer').src = "";
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => alert("Lien VLC copié !"));
        }
      </script>
    </body>
    </html>
  `);
});

// --- ROUTE 2 : RECHERCHE NYAA + LOGIQUE FILTRES + TMDB ---
app.get('/api/search', async (req, res) => {
  let query = req.query.q;
  const type = req.query.type || 'vostfr';
  if (!query) return res.json([]);

  let category = '1_0';
  if (type === 'vostfr') { query += ' vostfr'; category = '1_3'; } 
  else if (type === 'vf') { query += ' vf'; category = '1_3'; } 
  else if (type === 'multisub') { query += ' multi'; category = '1_2'; } 
  else if (type === 'sub') { category = '1_2'; }

  const targetUrl = `https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=${category}`;
  
  try {
    const response = await fetch(targetUrl, { headers: { 'User-Agent': 'ServeurAnime/1.0' } });
    const xmlText = await response.text();
    const feed = await parser.parseString(xmlText);

    // ANALYSE TMDB POUR CHAQUE TORRENT
    const videos = await Promise.all(feed.items.slice(0, 20).map(async (t) => {
        // Nettoyage du nom pour TMDB
        const cleanName = t.title.replace(/\[.*?\]/g, '').split('-')[0].trim();
        let poster = "https://via.placeholder.com/500x750?text=No+Poster";
        let rating = "N/A";

        try {
            const tmdb = await axios.get('https://api.themoviedb.org/3/search/multi', {
                params: { api_key: TMDB_API_KEY, query: cleanName, language: 'fr-FR' }
            });
            if (tmdb.data.results.length > 0) {
                const info = tmdb.data.results[0];
                poster = info.poster_path ? `https://image.tmdb.org/t/p/w500${info.poster_path}` : poster;
                rating = info.vote_average || rating;
            }
        } catch (e) {}

        return { 
            titre: t.title, 
            lienMagnet: t.link, 
            taille: t.size, 
            seeders: parseInt(t.seeders, 10) || 0,
            poster,
            rating
        };
    }));
    res.json(videos);
  } catch (error) { res.status(500).json({ error: 'Erreur Nyaa' }); }
});

// --- FONCTION INTELLIGENTE : TROUVER LE FRANÇAIS ---
async function getSubtitleConfig(videoUrl) {
    try {
        const cmd = `ffprobe -v error -select_streams s -show_entries stream=index:stream_tags=language -of json "${videoUrl}"`;
        const { stdout } = await execPromise(cmd, { timeout: 15000 });
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        if (streams.length === 0) return null;
        for (let i = 0; i < streams.length; i++) {
            const lang = streams[i].tags?.language?.toLowerCase();
            if (lang === 'fre' || lang === 'fra') return i;
        }
        return 0;
    } catch (error) { return 0; }
}

// --- ROUTE 3 : TRANSCODAGE FFMPEG ---
app.get('/play', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).send("Lien magnet manquant");
    const torrUrl = `http://${TORRSERVER_IP}:8090/stream?link=${encodeURIComponent(magnet)}&index=1&play`;
    const subIndex = await getSubtitleConfig(torrUrl);

    res.setHeader('Content-Type', 'video/mp4');
    let ffmpegArgs = ['-re', '-i', torrUrl];

    if (subIndex !== null) {
        const escapedUrl = torrUrl.replace(/:/g, '\\:');
        ffmpegArgs.push('-vf', `subtitles='${escapedUrl}':si=${subIndex}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency');
    } else {
        ffmpegArgs.push('-c:v', 'copy');
    }

    ffmpegArgs.push('-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1');
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    ffmpeg.stdout.pipe(res);
    req.on('close', () => ffmpeg.kill('SIGKILL'));
});

app.listen(3000, () => console.log('✅ Serveur Ultimate lancé sur le port 3000 !'));