import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const app = express();
const PORT = 3001;
const BASE_URL = 'https://anime-sama.tv'; // L'URL de base du site cible (peut changer, à vérifier)

// Configuration des headers pour tromper le serveur
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
};

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

// --- ROUTE DE RECHERCHE SUR ANIME-SAMA ---
app.get('/api/search-fr', async (req, res) => {
    const query = req.query.q;
    const browser = await puppeteer.launch({ 
        headless: "new", 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });

    try {
        const page = await browser.newPage();
        // On va sur la page catalogue
        await page.goto('https://anime-sama.fr/catalogue/', { waitUntil: 'networkidle2' });

        // On exécute un petit script DANS la page pour filtrer les animes
        const results = await page.evaluate((searchQuery) => {
            const items = [];
            // On cible les cartes d'animes (à ajuster selon les classes réelles du site)
            document.querySelectorAll('.cardAnime').forEach(el => {
                const title = el.querySelector('h1')?.innerText;
                if (title && title.toLowerCase().includes(searchQuery.toLowerCase())) {
                    items.push({
                        title: title,
                        link: el.querySelector('a')?.href,
                        img: el.querySelector('img')?.src
                    });
                }
            });
            return items;
        }, query);

        await browser.close();
        res.json({ results });

    } catch (error) {
        await browser.close();
        res.status(500).json({ error: "Puppeteer n'a pas pu lire la page." });
    }
});

app.get('/api/test-direct', async (req, res) => {
    try {
        // On essaie d'appeler directement le fichier PHP que tu as trouvé
        // Note: l'URL exacte dépend de l'anime, ici on teste une structure type
        const targetUrl = "https://anime-sama.fr/api/get-data.php";
        
        const response = await axios.get(targetUrl, {
            params: {
                // Ici il faudrait les paramètres exacts vus dans l'onglet 'Payload' ou 'Query String'
                // de ta requête get-data.php (ex: anime=frieren, ep=1, etc.)
                filever: "17483" 
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Referer': 'https://anime-sama.fr/',
                'Accept': '*/*'
            }
        });

        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Cloudflare bloque l'accès direct à l'API PHP." });
    }
});

// --- ROUTE POUR RÉCUPÉRER L'EPISODE ---
app.get('/api/watch-fr', async (req, res) => {
    const url = req.query.url; // URL de la page de l'anime sur Anime-Sama
    if (!url) return res.status(400).send("URL manquante");

    try {
        const response = await axios.get(url, { headers });
        const $ = cheerio.load(response.data);
        
        // C'est ici que ça se corse : Anime-Sama utilise souvent des scripts 
        // pour générer les boutons d'épisodes. On va chercher les balises <script>
        // ou les iframes directement présentes.
        let videoUrl = "";
        
        // Tentative d'extraction de l'iframe du lecteur
        $('iframe').each((i, el) => {
            const src = $(el).attr('src');
            if (src && (src.includes('sibnet') || src.includes('myvi'))) {
                videoUrl = src;
            }
        });

        if (videoUrl) {
            res.json({ videoUrl });
        } else {
            res.status(404).json({ error: "Lecteur vidéo non trouvé. Le site utilise peut-être du JavaScript dynamique." });
        }
    } catch (error) {
        res.status(500).json({ error: "Erreur lors de l'extraction de la vidéo" });
    }
});

app.listen(PORT, () => {
  console.log(`⚡ Serveur API Légère lancé sur le port ${PORT} !`);
});