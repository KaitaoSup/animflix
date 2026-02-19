import express from 'express';

const app = express();
const PORT = 3001;

// URL d'une instance publique de l'API Consumet (Provider: Gogoanime)
const CONSUMET_API = "https://api.consumet.org/meta/anilist";

// --- ROUTE 1 : L'INTERFACE WEB (FRONTEND) ---
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <title>Anime API (Version Légère) ⚡</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
        <style>
            body { background: #0f0f1a; color: white; font-family: sans-serif; margin: 0; padding: 20px; text-align: center; }
            h1 { color: #00d2ff; }
            .search-box { margin-bottom: 30px; }
            input[type="text"] { padding: 12px; width: 300px; border-radius: 5px; border: none; font-size: 16px; outline: none; }
            button { padding: 12px 20px; background: #00d2ff; color: #000; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; font-weight: bold; }
            
            #player-container { margin-top: 20px; display: none; background: #000; padding: 20px; border-radius: 10px; border: 1px solid #333; }
            video { width: 100%; max-width: 1000px; border: 1px solid #444; border-radius: 5px; background: #000; }
            
            .grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 15px; margin-top: 20px; }
            .card { background: #1a1a2e; padding: 15px; border-radius: 8px; width: 200px; cursor: pointer; transition: 0.2s; border: 1px solid #333; }
            .card:hover { transform: scale(1.05); background: #252542; }
            .card img { width: 100%; border-radius: 5px; height: 280px; object-fit: cover; }
            .card h3 { font-size: 14px; margin: 10px 0 0 0; }
            
            .episodes-container { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 5px; justify-content: center; max-width: 800px; margin: 20px auto; }
            .ep-btn { background: #333; color: white; border: none; padding: 10px; cursor: pointer; border-radius: 4px; }
            .ep-btn:hover { background: #00d2ff; color: black; }
        </style>
    </head>
    <body>
      <h1>Anime API (Zéro Transcodage) ⚡</h1>
      
      <div class="search-box">
          <input type="text" id="searchInput" placeholder="Ex: Jujutsu Kaisen..." onkeypress="if(event.key === 'Enter') searchAnime()">
          <button onclick="searchAnime()">Chercher</button>
      </div>

      <div id="player-container">
          <h2 id="now-playing">Lecteur Prêt</h2>
          <video id="videoPlayer" controls autoplay></video>
      </div>

      <div id="episodesList" class="episodes-container"></div>
      <div id="results" class="grid"></div>

      <script>
        // 1. CHERCHER L'ANIME
        async function searchAnime() {
            const query = document.getElementById('searchInput').value;
            const resultsDiv = document.getElementById('results');
            document.getElementById('episodesList').innerHTML = '';
            
            if (!query) return;
            resultsDiv.innerHTML = '<p>Recherche en cours sur Consumet... ⏳</p>';
            
            try {
                const response = await fetch('/api/search?q=' + encodeURIComponent(query));
                const data = await response.json();
                
                resultsDiv.innerHTML = '';
                data.results.forEach(anime => {
                    const card = document.createElement('div');
                    card.className = 'card';
                    card.onclick = () => loadEpisodes(anime.id, anime.title);
                    
                    // Concaténation classique pour éviter les erreurs d'échappement Node.js
                    card.innerHTML = 
                        '<img src="' + anime.image + '" alt="cover">' +
                        '<h3>' + anime.title + '</h3>' +
                        '<small>' + (anime.releaseDate || 'N/A') + '</small>';
                        
                    resultsDiv.appendChild(card);
                });
            } catch (err) {
                resultsDiv.innerHTML = '<p style="color:red;">Erreur lors de la recherche.</p>';
            }
        }

        // 2. CHARGER LES ÉPISODES DE L'ANIME SÉLECTIONNÉ
        async function loadEpisodes(animeId, title) {
            const epDiv = document.getElementById('episodesList');
            epDiv.innerHTML = '<p>Chargement des épisodes... ⏳</p>';
            window.scrollTo({ top: 0, behavior: 'smooth' });

            try {
                const response = await fetch('/api/info?id=' + encodeURIComponent(animeId));
                const data = await response.json();
                
                epDiv.innerHTML = '<h3>' + title + ' - Choisissez un épisode :</h3><br>';
                
                data.episodes.forEach(ep => {
                    const btn = document.createElement('button');
                    btn.className = 'ep-btn';
                    btn.innerText = "Ep " + ep.number;
                    btn.onclick = () => playEpisode(ep.id, title + ' - Episode ' + ep.number);
                    epDiv.appendChild(btn);
                });
            } catch (err) {
                epDiv.innerHTML = '<p style="color:red;">Erreur de chargement des épisodes.</p>';
            }
        }

        // 3. LANCER LA VIDÉO (AVEC HLS.JS)
        async function playEpisode(episodeId, fullName) {
            document.getElementById('player-container').style.display = 'block';
            document.getElementById('now-playing').innerText = "Récupération du lien de streaming... ⏳";
            
            try {
                const response = await fetch('/api/watch?id=' + encodeURIComponent(episodeId));
                const data = await response.json();
                
                const source = data.sources.find(s => s.quality === '1080p' || s.quality === 'default') || data.sources[0];
                const videoUrl = source.url;

                document.getElementById('now-playing').innerText = "Lecture : " + fullName;
                const video = document.getElementById('videoPlayer');

                if (Hls.isSupported()) {
                    const hls = new Hls();
                    hls.loadSource(videoUrl);
                    hls.attachMedia(video);
                    hls.on(Hls.Events.MANIFEST_PARSED, function() {
                        video.play();
                    });
                } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                    video.src = videoUrl;
                    video.addEventListener('loadedmetadata', function() {
                        video.play();
                    });
                }
            } catch (err) {
                document.getElementById('now-playing').innerText = "❌ Erreur : Lien mort ou bloqué.";
            }
        }
      </script>
    </body>
    </html>
  `);
});

// --- ROUTES BACKEND (PROXY VERS CONSUMET) ---

app.get('/api/search', async (req, res) => {
    try {
        const response = await fetch(`${CONSUMET_API}/${req.query.q}`);
        const data = await response.json();
        res.json(data);
    } catch (e) { res.status(500).json({ error: 'Erreur Serveur' }); }
});

app.get('/api/info', async (req, res) => {
    try {
        const response = await fetch(`${CONSUMET_API}/info/${req.query.id}`);
        const data = await response.json();
        res.json(data);
    } catch (e) { res.status(500).json({ error: 'Erreur Serveur' }); }
});

app.get('/api/watch', async (req, res) => {
    try {
        const response = await fetch(`${CONSUMET_API}/watch/${req.query.id}`);
        const data = await response.json();
        res.json(data);
    } catch (e) { res.status(500).json({ error: 'Erreur Serveur' }); }
});

app.listen(PORT, () => {
  console.log(`⚡ Serveur API Légère lancé sur le port ${PORT} !`);
});