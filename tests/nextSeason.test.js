import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(process.cwd(), 'public/js/player/next-episode.js'), 'utf8');
const flush = () => new Promise(r => setImmediate(r));

const edge = (relationType, id, format, status = 'FINISHED', english = `Anime ${id}`) =>
  ({ relationType, node: { id, type: 'ANIME', format, status, title: { english } } });

// Lecteur en fin de saison : épisode 12 sur 12 de l'anime AniList n°1
function loadPlayer({ edges = [], graphqlError = null } = {}) {
  const elements = {};
  const el = (id) => (elements[id] ||= { id, style: {}, textContent: '' });
  const calls = { graphql: 0, toasts: [], openAnimePage: [], playAnimeEpisode: [] };
  const timers = [];

  const ctx = vm.createContext({
    window: { _currentPlayingEpisodeKey: 'ep-12', _currentAnimePageId: null },
    document: { getElementById: el, querySelectorAll: () => [] },
    localStorage: { getItem: () => null },
    console: { log() {}, warn() {} },
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: () => {},
    currentAnimeItem: { titre: 'Anime 1 - 12' },
    currentDetectedEpisode: 12,
    currentAnilistMedia: { id: 1, episodes: 12 },
    showToast: (msg) => calls.toasts.push(msg),
    callAnilistGraphQL: async () => {
      calls.graphql++;
      if (graphqlError) throw new Error(graphqlError);
      return { Media: { relations: { edges } } };
    },
    openAnimePage: async (id, opts) => {
      calls.openAnimePage.push([id, opts]);
      ctx.window._currentAnimePageId = id;
    },
    playAnimeEpisode: (ep) => calls.playAnimeEpisode.push(ep)
  });
  vm.runInContext(source, ctx);
  return { ctx, elements, calls, timers };
}

describe('Saison suivante — choix de la suite AniList', () => {
  test('suite TV privilégiée ; préquelle, OVA, spécial et suite pas encore sortie ignorés', () => {
    const { ctx } = loadPlayer();
    const pick = ctx.pickSequelEdge([
      edge('PREQUEL', 10, 'TV'),
      edge('SEQUEL', 11, 'SPECIAL'),
      edge('SEQUEL', 12, 'MOVIE'),
      edge('SEQUEL', 13, 'TV', 'NOT_YET_RELEASED'),
      edge('SEQUEL', 14, 'TV'),
      edge('SIDE_STORY', 15, 'TV')
    ]);
    assert.equal(pick.node.id, 14);
    assert.equal(ctx.pickSequelEdge([edge('SEQUEL', 12, 'MOVIE')]).node.id, 12);
    assert.equal(ctx.pickSequelEdge([edge('SEQUEL', 13, 'TV', 'NOT_YET_RELEASED')]), null);
    assert.equal(ctx.pickSequelEdge(undefined), null);
  });
});

describe('Saison suivante — enchaînement en fin de saison', () => {
  test('propose la suite puis ouvre sa fiche et lance l\'épisode 1', async () => {
    const { ctx, elements, calls, timers } = loadPlayer({ edges: [edge('SEQUEL', 2, 'TV', 'RELEASING', 'Anime Season 2')] });
    ctx.triggerNextEpisodeOverlay();
    await flush();

    assert.equal(elements.playerNextEpOverlay.style.display, 'flex');
    assert.equal(elements.nextEpBadge.textContent, '📺 Saison suivante');
    assert.equal(elements.nextEpLabel.textContent, 'Anime Season 2');
    assert.equal(elements.nextEpCountdownSec.textContent, 10);
    assert.equal(timers.length, 1);

    ctx.playNextEpisodeNow();
    await flush();
    assert.equal(elements.playerNextEpOverlay.style.display, 'none');
    assert.deepEqual(JSON.parse(JSON.stringify(calls.openAnimePage)), [[2, { ep: 1 }]]);
    assert.deepEqual(calls.playAnimeEpisode, [1]);
  });

  test('sans suite : message de fin de saison, pas de compte à rebours', async () => {
    const { ctx, elements, calls, timers } = loadPlayer({ edges: [edge('PREQUEL', 3, 'TV')] });
    ctx.triggerNextEpisodeOverlay(true);
    await flush();
    assert.equal(timers.length, 0);
    assert.equal(elements.playerNextEpOverlay?.style.display, undefined);
    assert.match(calls.toasts[0], /terminé tous les épisodes/);
  });

  test('suite cherchée une seule fois (préchargement puis fin d\'épisode)', async () => {
    const { ctx, calls } = loadPlayer({ edges: [edge('SEQUEL', 2, 'TV')] });
    await ctx.findSequelMedia(1);
    await ctx.findSequelMedia(1);
    assert.equal(calls.graphql, 1);
  });

  test('erreur AniList : pas mise en cache, nouvel essai au prochain appel', async () => {
    const { ctx, calls } = loadPlayer({ graphqlError: 'réseau' });
    assert.equal(await ctx.findSequelMedia(1), null);
    assert.equal(await ctx.findSequelMedia(1), null);
    assert.equal(calls.graphql, 2);
  });

  test('un autre épisode lancé pendant la recherche : rien n\'est proposé', async () => {
    const { ctx, elements, calls } = loadPlayer({ edges: [edge('SEQUEL', 2, 'TV')] });
    ctx.triggerNextEpisodeOverlay();
    ctx.window._currentPlayingEpisodeKey = 'autre-episode';
    await flush();
    assert.equal(elements.playerNextEpOverlay?.style.display, undefined);
    assert.equal(calls.toasts.length, 0);
  });
});
