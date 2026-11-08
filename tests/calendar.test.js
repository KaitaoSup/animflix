import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  createCalendarStore,
  buildCalendarIcs,
  foldIcsLine,
  escapeIcsText,
  fetchUserAirings,
  createCalendarBuilder,
  isValidCalendarToken,
  CALENDAR_CONFIG
} from '../src/services/calendarService.js';

function freshStore() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users (id) VALUES (1), (2);');
  return createCalendarStore(db);
}

const media = { id: 154587, episodes: 12, duration: 24, title: { userPreferred: 'Frieren; le voyage, suite' } };

describe('Agenda — jetons', () => {
  test('un jeton stable par compte, révocable', () => {
    const store = freshStore();
    const t1 = store.getOrCreateToken(1);
    assert.ok(isValidCalendarToken(t1));
    assert.equal(store.getOrCreateToken(1), t1);
    assert.notEqual(store.getOrCreateToken(2), t1);
    assert.equal(store.userIdForToken(t1), 1);

    const t2 = store.resetToken(1);
    assert.notEqual(t2, t1);
    assert.equal(store.userIdForToken(t1), null);
    assert.equal(store.userIdForToken(t2), 1);
    assert.equal(store.userIdForToken('../etc'), null);
  });
});

describe('Agenda — format iCalendar', () => {
  test('échappement et découpage des lignes (75 octets, sans couper un caractère)', () => {
    assert.equal(escapeIcsText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');
    const long = 'SUMMARY:' + 'é'.repeat(80);
    const folded = foldIcsLine(long);
    for (const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part, 'utf8') <= 75);
    assert.equal(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join(''), long);
  });

  test('un événement par diffusion, heure UTC, durée et lien vers la fiche', () => {
    const ics = buildCalendarIcs([
      { id: 99, episode: 12, airingAt: Date.UTC(2026, 10, 14, 15, 0) / 1000, media },
      { id: 98, episode: 11, airingAt: Date.UTC(2026, 10, 7, 15, 0) / 1000, media }
    ], { baseUrl: 'https://animflix.example.ts.net', now: Date.UTC(2026, 10, 9) });

    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    // Tri chronologique
    assert.ok(ics.indexOf('UID:anilist-airing-98@animflix') < ics.indexOf('UID:anilist-airing-99@animflix'));
    assert.match(ics, /DTSTART:20261114T150000Z/);
    assert.match(ics, /DTEND:20261114T152400Z/);
    assert.match(ics, /SUMMARY:Frieren\\; le voyage\\, suite · Ép\. 12 \(final\)/);
    const unfolded = ics.replace(/\r\n /g, '');
    assert.match(unfolded, /URL:https:\/\/animflix\.example\.ts\.net\/#\/anime\/154587\?ep=12/);
    assert.ok(!ics.replace(/\r\n/g, '').includes('\n'), 'fins de ligne CRLF uniquement');
  });
});

describe('Agenda — données AniList', () => {
  const user = { id: 1, anilist_id: 42, anilist_token: 'tok' };

  test('ne garde que les animes en diffusion / à venir et pagine le planning', async () => {
    const calls = [];
    const fetchAnilist = async (query, vars, token) => {
      calls.push({ vars, token });
      if (query.includes('MediaListCollection')) {
        return { MediaListCollection: { lists: [{ entries: [
          { media: { id: 1, status: 'RELEASING' } },
          { media: { id: 2, status: 'FINISHED' } },
          { media: { id: 3, status: 'NOT_YET_RELEASED' } }
        ] }] } };
      }
      return { Page: {
        pageInfo: { hasNextPage: vars.page === 1 },
        airingSchedules: [{ id: vars.page, episode: vars.page, airingAt: 1000 + vars.page, media: { id: 1 } }]
      } };
    };
    const now = 1_800_000_000_000;
    const airings = await fetchUserAirings(user, { fetchAnilist, now });
    assert.equal(airings.length, 2);
    assert.deepEqual(calls[0].vars.statuses, ['CURRENT', 'REPEATING']);
    assert.equal(calls[0].token, 'tok');
    assert.deepEqual(calls[1].vars.ids, [1, 3]);
    assert.equal(calls[1].vars.from, now / 1000 - CALENDAR_CONFIG.PAST_WINDOW_S);
    assert.equal(calls[1].vars.to, now / 1000 + CALENDAR_CONFIG.FUTURE_WINDOW_S);

    await fetchUserAirings(user, { fetchAnilist, now, includePlanning: true });
    assert.deepEqual(calls[3].vars.statuses, ['CURRENT', 'REPEATING', 'PLANNING']);
  });

  test('cache de 30 min, et dernière version servie si AniList tombe', async () => {
    let t = 0;
    let fail = false;
    let listCalls = 0;
    const fetchAnilist = async (query) => {
      if (fail) throw new Error('AniList hors ligne');
      if (query.includes('MediaListCollection')) {
        listCalls++;
        return { MediaListCollection: { lists: [{ entries: [{ media: { id: 1, status: 'RELEASING' } }] }] } };
      }
      return { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ id: 5, episode: 3, airingAt: 2000, media }] } };
    };
    const calendarForUser = createCalendarBuilder({ fetchAnilist, now: () => t });
    const first = await calendarForUser(user);
    assert.match(first, /Ép\. 3/);
    await calendarForUser(user);
    assert.equal(listCalls, 1);

    t += CALENDAR_CONFIG.CACHE_TTL_MS + 1;
    fail = true;
    assert.equal(await calendarForUser(user), first);
    await assert.rejects(calendarForUser({ ...user, id: 2 }), /hors ligne/);
  });
});
