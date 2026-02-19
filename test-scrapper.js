import axios from 'axios';
import * as cheerio from 'cheerio';

async function lancerRobot() {
    console.log("🚀 Lancement du robot espion vers Anime-Sama...");

    // L'URL cible. Attention, l'extension d'Anime-Sama change souvent (.fr, .net, .me...)
    const url = 'https://anime-sama.tv/';

    try {
        // 1. On tente de télécharger la page en se déguisant en vrai PC Windows
        const reponse = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        });

        console.log("✅ Accès autorisé ! Le site a répondu.");

        // 2. On donne le code HTML brut à Cheerio pour pouvoir le fouiller
        const $ = cheerio.load(reponse.data);

        // 3. On extrait le vrai titre de la page
        const titrePage = $('title').text();
        console.log("📌 Titre du site trouvé :", titrePage);

        // 4. On essaie de trouver tous les liens (balises <a>) de la page
        console.log("\n🔍 Recherche de liens d'animes sur la page d'accueil :");
        let count = 0;
        $('a').each((index, element) => {
            const lien = $(element).attr('href');
            const texte = $(element).text().trim();
            
            // On filtre pour ne garder que les vrais liens d'animes (qui ont du texte)
            if (lien && lien.includes('catalogue') && texte && count < 5) {
                console.log(`- Anime trouvé : ${texte} (Lien: ${lien})`);
                count++;
            }
        });

        if (count === 0) {
            console.log("⚠️ Le robot est passé, mais n'a pas trouvé les liens. Le site utilise peut-être du JavaScript pour charger son contenu (C'est le boss final du scraping).");
        }

    } catch (erreur) {
        // C'est ici qu'on voit si on s'est fait attraper par les gardes (Cloudflare)
        console.log("\n❌ ALARME ! Le robot a été bloqué.");
        if (erreur.response) {
            console.log("🛑 Code d'erreur du serveur :", erreur.response.status);
            if (erreur.response.status === 403) {
                console.log("🛡️ Explication : C'est l'erreur 403 Forbidden. Cloudflare (le pare-feu du site) a détecté que vous étiez un robot Node.js et a fermé la porte.");
            }
        } else {
            console.log("🛑 Erreur technique :", erreur.message);
        }
    }
}

// On lance la fonction
lancerRobot();