const Parser = require('rss-parser');

const parser = new Parser({
  customFields: {
    item: [
      ['nyaa:seeders', 'seeders'],
      ['nyaa:size', 'size']
    ],
  },
});

async function xmlToJson(searchTerm) {
  const query = encodeURIComponent(searchTerm);
  const url = `https://nyaa.si/?page=rss&q=${query}&c=1_2`;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'MonAppServeurAnime/1.0' }
    });

    if (!response.ok) throw new Error(`Erreur HTTP: ${response.status}`);
    
    const xmlText = await response.text();
    const feed = await parser.parseString(xmlText);

    // On transforme les données brutes en un format propre
    const videos = feed.items.map(torrent => ({
        titre: torrent.title,
        lienMagnet: torrent.link,
        taille: torrent.size,
        seeders: parseInt(torrent.seeders, 10)
    }));

    // On convertit le résultat en JSON formaté
    const jsonOutput = JSON.stringify(videos, null, 2);
    
    // On affiche le JSON dans le terminal
    console.log(jsonOutput);

  } catch (error) {
    console.error('Erreur:', error.message);
  }
}

// On lance la recherche (ici pour Frieren, mais vous pouvez changer)
xmlToJson('Frieren 1080p');