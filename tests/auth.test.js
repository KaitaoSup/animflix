import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies, extractSessionToken } from '../src/routes/authRoutes.js';

describe('Auth Helpers & Session Extraction', () => {
  it('extrait correctement les cookies de la requête', () => {
    const req = {
      headers: {
        cookie: 'animflix_session=abc123xyz; other_cookie=hello%20world'
      }
    };
    const cookies = parseCookies(req);
    assert.equal(cookies.animflix_session, 'abc123xyz');
    assert.equal(cookies.other_cookie, 'hello world');
  });

  it('gère les requêtes sans cookie sans planter', () => {
    const req = { headers: {} };
    const cookies = parseCookies(req);
    assert.deepEqual(cookies, {});
  });

  it('extrait le token depuis le cookie animflix_session en priorité', () => {
    const req = {
      headers: {
        cookie: 'animflix_session=cookie_token_456',
        authorization: 'Bearer bearer_token_789'
      }
    };
    assert.equal(extractSessionToken(req), 'cookie_token_456');
  });

  it('extrait le token depuis le header Authorization Bearer si cookie absent', () => {
    const req = {
      headers: {
        authorization: 'Bearer bearer_token_789'
      }
    };
    assert.equal(extractSessionToken(req), 'bearer_token_789');
  });

  it('extrait le token depuis le header x-session-token si cookie et Bearer absents', () => {
    const req = {
      headers: {
        'x-session-token': 'header_token_123'
      }
    };
    assert.equal(extractSessionToken(req), 'header_token_123');
  });

  it('extrait le token depuis req.query.token en dernier recours', () => {
    const req = {
      headers: {},
      query: { token: 'query_token_999' }
    };
    assert.equal(extractSessionToken(req), 'query_token_999');
  });

  it('renvoie null si aucun jeton n\'est présent', () => {
    const req = { headers: {} };
    assert.equal(extractSessionToken(req), null);
  });
});
