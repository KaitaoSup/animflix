import { Router } from 'express';
import { searchAnime } from '../services/nyaaService.js';

const router = Router();

router.get('/api/search', async (req, res) => {
  const query = req.query.q?.trim();
  const type = req.query.type || 'vostfr';
  if (!query) return res.json([]);

  try {
    const videos = await searchAnime(query, type);
    res.json(videos);
  } catch (error) {
    console.error("⚠️ Erreur API Nyaa:", error.message);
    res.status(500).json([]);
  }
});

export default router;
