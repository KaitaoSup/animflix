import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAnimeTitle, parseAnimeDetails, extractFileEpisodeNumber } from '../src/utils/animeParser.js';

describe('Anime Parser Utils', () => {
  describe('cleanAnimeTitle', () => {
    it('retire les tags fansub et résolutions standards', () => {
      const raw = '[SubsPlease] Sousou no Frieren - 05 (1080p) [ABCD1234].mkv';
      const cleaned = cleanAnimeTitle(raw);
      assert.strictEqual(cleaned, 'Sousou no Frieren');
    });

    it('retire les mentions de saisons et épisodes', () => {
      const raw = '[Erai-raws] Jujutsu Kaisen 2nd Season - 14 [1080p][MULTi].mkv';
      const cleaned = cleanAnimeTitle(raw);
      assert.strictEqual(cleaned, 'Jujutsu Kaisen');
    });

    it('gère les points et underscores de séparation', () => {
      const raw = 'Oshi.no.Ko.S02E01.VOSTFR.1080p.WEB-DL.x264.mkv';
      const cleaned = cleanAnimeTitle(raw);
      assert.strictEqual(cleaned, 'Oshi no Ko');
    });

    it('renvoie une chaîne vide si l\'entrée est nulle ou vide', () => {
      assert.strictEqual(cleanAnimeTitle(''), '');
      assert.strictEqual(cleanAnimeTitle(null), '');
    });
  });

  describe('parseAnimeDetails', () => {
    it('détecte correctement l\'anime, la saison, l\'épisode et la résolution', () => {
      const raw = '[SubsPlease] Mushoku Tensei S02E15 (1080p) [B7C2A15D].mkv';
      const details = parseAnimeDetails(raw);

      assert.strictEqual(details.animeName, 'Mushoku Tensei');
      assert.strictEqual(details.season, 'Saison 2');
      assert.strictEqual(details.episode, 'Épisode 15');
      assert.strictEqual(details.resolution, '1080p Full HD');
      assert.strictEqual(details.audioLang, 'VOSTFR');
    });

    it('classe un « S01 » sans numéro d\'épisode comme saison complète, pas comme Épisode 1', () => {
      const details = parseAnimeDetails('Miru.Tights.S01.1080p.BluRay.REMUX.AVC.FLAC.2.0-StaFer');
      assert.strictEqual(details.season, 'Saison 1');
      assert.strictEqual(details.episode, 'Saison Complète');
      // Sans aucune indication de saison ni d'épisode, on garde le repli « Épisode 1 »
      assert.strictEqual(parseAnimeDetails('[ASW] Some Anime [1080p HEVC]').episode, 'Épisode 1');
    });

    it('ne prend pas « S2 - 03 » / « Saison 2 - 05 » pour une plage de saisons', () => {
      const erai = parseAnimeDetails('[Erai-raws] Kaiju No 8 S2 - 03 [1080p]');
      assert.strictEqual(erai.season, 'Saison 2');
      assert.strictEqual(erai.episode, 'Épisode 3');
      const fr = parseAnimeDetails('[Group] Anime Saison 2 - 05 VOSTFR');
      assert.strictEqual(fr.season, 'Saison 2');
      assert.strictEqual(fr.episode, 'Épisode 5');
      // Les vraies plages restent reconnues
      assert.strictEqual(parseAnimeDetails('Anime S1 - S3 BD').season, 'Saisons 1 à 3');
      assert.strictEqual(parseAnimeDetails('Anime S01-02 1080p').season, 'Saisons 1 à 2');
      assert.strictEqual(parseAnimeDetails('Anime S1 & S2').season, 'Saisons 1 & 2');
      assert.strictEqual(parseAnimeDetails('Anime Saisons 1 à 3 VF').season, 'Saisons 1 à 3');
    });

    it('détecte les packs et intégrales multi-saisons', () => {
      const raw = '[Anime-Fans] Attack on Titan S01-S04 Complete Pack 1080p MULTI';
      const details = parseAnimeDetails(raw);

      assert.match(details.season, /Saisons 1/);
      assert.match(details.episode, /Intégrale|Pack/);
      assert.strictEqual(details.audioLang, 'MULTI (VF / VOSTFR)');
    });

    it('détecte la langue VF', () => {
      const raw = 'Solo Leveling - 08 VF 1080p';
      const details = parseAnimeDetails(raw);

      assert.strictEqual(details.audioLang, 'VF');
      assert.strictEqual(details.episode, 'Épisode 8');
    });

    it('détecte les plages d\'épisodes (ex: 01-12)', () => {
      const raw = 'Danmachi Season 4 - EP 01-11 VOSTFR 720p';
      const details = parseAnimeDetails(raw);

      assert.strictEqual(details.season, 'Saison 4');
      assert.strictEqual(details.episode, 'Épisodes 1-11');
      assert.strictEqual(details.resolution, '720p HD');
    });
  });

  describe('extractFileEpisodeNumber', () => {
    it('extrait le numéro depuis S01E05', () => {
      assert.strictEqual(extractFileEpisodeNumber('/media/Anime_S01E05_1080p.mkv'), 5);
    });

    it('extrait le numéro depuis un tiret standard (ex: Anime - 12.mkv)', () => {
      assert.strictEqual(extractFileEpisodeNumber('Frieren - 08 (1080p).mkv'), 8);
    });

    it('extrait le numéro depuis la mention EP / Episode', () => {
      assert.strictEqual(extractFileEpisodeNumber('[Batch] One_Piece_EP_1071.mp4'), 1071);
    });

    it('renvoie null si aucun numéro d\'épisode n\'est identifiable', () => {
      assert.strictEqual(extractFileEpisodeNumber('Menu_and_Extras.mkv'), null);
      assert.strictEqual(extractFileEpisodeNumber(null), null);
    });
  });
});
