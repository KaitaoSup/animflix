// Chargement du fichier .env (optionnel), à importer EN PREMIER dans animflix.js.
// En ESM, les import sont évalués avant le corps du module : charger le .env dans animflix.js même
// arrivait trop tard, constants.js et database.js avaient déjà lu process.env (PORT, TMDB_API_KEY…).
// Les variables déjà définies (PM2, Docker, shell) restent prioritaires sur celles du fichier.
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch (e) {
    // Pas de .env : on garde l'environnement tel quel
  }
}
