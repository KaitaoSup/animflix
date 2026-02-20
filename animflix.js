import express from 'express';
import Parser from 'rss-parser';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const app = express();
const execPromise = promisify(exec);

// --- CONFIGURATION ---
const TORRSERVER_IP = "192.168.1.55"; 
const TMDB_API_KEY = "3fdc6d0d7e26ee891af1f1ba1469a4e8"; 

const parser = new Parser({
  customFields: {
    item: [['nyaa:seeders', 'seeders'], ['nyaa:size', 'size']],
  },
});

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
            input[type="text"], select { padding: 10px; border-radius: 4px; border: 1px solid #333; background: #222; color: white; outline: none; }
            button { padding: 10px 20px; background: #e50914; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }

            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 25px; padding: 120px 50px 50px; }
            .card { cursor: pointer; transition: transform 0.3s; position: relative; border-radius: 8px; overflow: hidden; background: #141414; border: 1px solid #222; }
            .card:hover { transform: scale(1.05); z-index: 5; border-color: #e50914; }
            .card img { width: 100%; aspect-ratio: 2/3; object-fit: cover; display: block; }
            .card-info { padding: 12px; font-size: 13px; background: #141414; }
            .card-title { font-weight: bold; margin-bottom: 5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
            .stats { color: #aaa; font-size: 11px; }
            .seeders { color: #4caf50; font-weight: bold; }
            
            /* LOADER SPÉCIFIQUE FFPROBE */
            #ffprobe-loader { 
                position: fixed; inset: 0; background: rgba(0,0,0,0.95); 
                z-index: 300; display: none; flex-direction: column; 
                align-items: center; justify-content: center; 
            }
            .spinner {
                width: 60px; height: 60px; border: 6px solid #333;
                border-top: 6px solid #e50914; border-radius: 50%;
                animation: spin 1s linear infinite; margin-bottom: 20px;
            }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }

            #player-container { position: fixed; inset: 0; background: #000; z-index: 200; display: none; flex-direction: column; align-items: center; justify-content: center; }
            video { width: 85%; max-height: 80vh; border: 1px solid #333; }
            .close-btn { position: absolute; top: 20px; right: 40px; font-size: 40px; cursor: pointer; color: white; z-index: 210; }
            .vlc-btn { margin-top: 15px; color: #ff8800; text-decoration: none; font-weight: bold; cursor: pointer; border: 1px solid #ff8800; padding: 10px; border-radius: 5px; }
        </style>
    </head>
    <body>
      <div id="ffprobe-loader">
          <div class="spinner"></div>
          <p id="loader-text" style="font-size: 18px;">Analyse des sous-titres et préparation du flux... ⌛</p>
      </div>

      <div class="navbar">
          <a href="/" class="logo">ANIMEFLIX</a>
          <div class="search-box">
              <input type="text" id="searchInput" placeholder="Nom de l'anime..." onkeypress="if(event.key === 'Enter') searchNyaa()">
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
            resultsDiv.innerHTML = '<p style="padding: 120px">Interrogation de la base de données... ⏳</p>';
            try {
                const response = await fetch('/api/search?q=' + encodeURIComponent(query) + '&type=' + type);
                const torrents = await response.json();
                resultsDiv.innerHTML = '';
                torrents.forEach(t => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    const vlcUrl = "http://" + TORRSERVER_IP + ":8090/stream?link=" + encodeURIComponent(t.lienMagnet) + "&index=1&play";
                    
                    card.innerHTML = \`
                        <img src="\${t.poster}" onerror="this.src='https://via.placeholder.com/300x450/111/fff?text=No+Poster'">
                        <div class="card-info">
                            <span class="card-title" title="\${t.titre}">\${t.titre}</span>
                            <div class="stats">
                                ⭐ \${t.rating} | \${t.taille}<br>
                                <span class="seeders">Seeders: \${t.seeders}</span>
                            </div>
                        </div>\`;
                    card.onclick = () => startStreaming(t.lienMagnet, t.titre, vlcUrl);
                    resultsDiv.appendChild(card);
                });
            } catch (err) { resultsDiv.innerHTML = '<p style="color:red; padding: 120px">Erreur serveur.</p>'; }
        }

        async function startStreaming(magnet, titre, vlcUrl) {
            document.getElementById('ffprobe-loader').style.display = 'flex';
            const webUrl = '/play?magnet=' + encodeURIComponent(magnet);
            const video = document.getElementById('videoPlayer');
            
            video.src = webUrl;
            document.getElementById('now-playing').innerText = titre;
            document.getElementById('vlcLink').href = vlcUrl;

            video.oncanplay = () => {
                document.getElementById('ffprobe-loader').style.display = 'none';
                document.getElementById('player-container').style.display = 'flex';
            };

            video.onerror = () => {
                alert("Erreur lors du chargement du flux vidéo.");
                document.getElementById('ffprobe-loader').style.display = 'none';
            };
        }

        function closePlayer() {
            document.getElementById('player-container').style.display = 'none';
            const v = document.getElementById('videoPlayer');
            v.pause(); v.src = "";
        }

        function copyToClipboard(text) {
            navigator.clipboard.writeText(text).then(() => alert("Lien copié ! Colle-le dans VLC (Média > Ouvrir un flux réseau)"));
        }
      </script>
    </body>
    </html>
  `);
});

// --- API RECHERCHE + TMDB ---
app.get('/api/search', async (req, res) => {
  let query = req.query.q;
  const type = req.query.type || 'vostfr';
  if (!query) return res.json([]);

  let category = '1_0';
  if (type === 'vostfr') { query += ' vostfr'; category = '1_3'; } 
  else if (type === 'vf') { query += ' vf'; category = '1_3'; } 
  else if (type === 'multisub') { query += ' multi'; category = '1_2'; } 
  else if (type === 'sub') { category = '1_2'; }

  try {
    const response = await fetch(`https://nyaa.si/?page=rss&q=${encodeURIComponent(query)}&c=${category}`);
    const feed = await parser.parseString(await response.text());

    const videos = await Promise.all(feed.items.slice(0, 20).map(async (t) => {
        // Nettoyage de nom pour TMDB
        const cleanName = t.title.replace(/\[.*?\]/g, '').replace(/[._\-]/g, ' ').split('S0')[0].split('Episode')[0].trim();
        let poster = null; let rating = "N/A";
        try {
            const tmdb = await axios.get('https://api.themoviedb.org/3/search/multi', {
                params: { api_key: TMDB_API_KEY, query: cleanName, language: 'fr-FR' }, timeout: 2000
            });
            if (tmdb.data.results.length > 0) {
                const info = tmdb.data.results[0];
                poster = info.poster_path ? `https://image.tmdb.org/t/p/w500${info.poster_path}` : null;
                rating = info.vote_average ? info.vote_average.toFixed(1) : "N/A";
            }
        } catch (e) {}
        return { titre: t.title, lienMagnet: t.link, taille: t.size, seeders: parseInt(t.seeders, 10) || 0, poster, rating };
    }));
    res.json(videos);
  } catch (error) { res.status(500).json([]); }
});

// --- ANALYSEUR FFPROBE ---
async function getSubtitleConfig(videoUrl) {
    try {
        console.log("🔍 FFPROBE: Analyse du torrent en cours...");
        const cmd = `ffprobe -v error -select_streams s -show_entries stream=index:stream_tags=language -of json "${videoUrl}"`;
        const { stdout } = await execPromise(cmd, { timeout: 20000 });
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        
        for (let i = 0; i < streams.length; i++) {
            const lang = streams[i].tags?.language?.toLowerCase();
            if (lang === 'fre' || lang === 'fra') {
                console.log("✅ FFPROBE: Sous-titre FR trouvé à l'index:", i);
                return i;
            }
        }
        return streams.length > 0 ? 0 : null;
    } catch (e) { 
        console.log("⚠️ FFPROBE: Échec ou timeout."); 
        return 0; 
    }
}

// --- TRANSCODEUR FFMPEG ---
app.get('/play', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).send("Magnet manquant");
    
    const torrUrl = `http://${TORRSERVER_IP}:8090/stream?link=${encodeURIComponent(magnet)}&index=1&play`;
    
    // Analyse ffprobe
    const subIndex = await getSubtitleConfig(torrUrl);

    res.setHeader('Content-Type', 'video/mp4');
    
    let ffmpegArgs = ['-re', '-i', torrUrl];

    if (subIndex !== null) {
        console.log(`🎬 FFmpeg: Incrustation de la piste sous-titre n°${subIndex}`);
        const escapedUrl = torrUrl.replace(/:/g, '\\:');
        
        // Utilisation de filter_complex pour une incrustation propre
        ffmpegArgs.push(
            '-filter_complex', `[0:v]subtitles='${escapedUrl}':si=${subIndex}[v]`, 
            '-map', '[v]',
            '-map', '0:a:0', 
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-crf', '26',
            '-sn'
        );
    } else {
        console.log("🎬 FFmpeg: Pas de sous-titres trouvés, copie directe.");
        ffmpegArgs.push('-c:v', 'copy');
    }

    ffmpegArgs.push(
        '-c:a', 'aac',
        '-ac', '2',
        '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4',
        'pipe:1'
    );

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    
    ffmpeg.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Error')) console.log("⚠️ FFmpeg Log:", msg);
    });

    ffmpeg.stdout.pipe(res);
    
    req.on('close', () => {
        console.log("🛑 Flux arrêté.");
        ffmpeg.kill('SIGKILL');
    });
});

app.listen(3000, () => console.log('✅ Serveur Netflix-Torrent Ultime avec FFPROBE Loader prêt !'));