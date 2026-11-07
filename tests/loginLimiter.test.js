import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoginLimiter, getClientIp, formatLockDelay, LOGIN_LIMITS } from '../src/utils/loginLimiter.js';

const MIN = 60 * 1000;

function makeLimiter(limits = LOGIN_LIMITS) {
  let t = 1_000_000;
  const limiter = createLoginLimiter({ now: () => t, limits });
  return { limiter, advance: (ms) => { t += ms; } };
}

const keys = (user = 'alice', ip = '1.2.3.4') => [`user:${user}`, `ip:${ip}`];

describe('loginLimiter — blocage progressif', () => {
  test('essais gratuits avec décompte, puis blocage d\'une minute', () => {
    const { limiter } = makeLimiter();
    for (let i = 1; i < LOGIN_LIMITS.USER_FREE_ATTEMPTS; i++) {
      assert.ok(limiter.check(keys()).allowed);
      assert.deepEqual(limiter.recordFailure(keys()), { remaining: LOGIN_LIMITS.USER_FREE_ATTEMPTS - i });
    }
    assert.deepEqual(limiter.recordFailure(keys()), { lockedMs: MIN });
    const gate = limiter.check(keys());
    assert.equal(gate.allowed, false);
    assert.equal(gate.retryAfterMs, MIN);
  });

  test('le blocage double à chaque nouvel échec, plafonné', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < LOGIN_LIMITS.USER_FREE_ATTEMPTS; i++) limiter.recordFailure(keys());
    const locks = [];
    for (let i = 0; i < 6; i++) {
      advance(LOGIN_LIMITS.MAX_LOCK_MS); // fin du blocage, pas assez pour l'oubli
      assert.ok(limiter.check(keys()).allowed);
      locks.push(limiter.recordFailure(keys()).lockedMs / MIN);
    }
    assert.deepEqual(locks, [2, 4, 8, 15, 15, 15]);
  });

  test('blocage levé après le délai, compteur oublié après une période calme', () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < LOGIN_LIMITS.USER_FREE_ATTEMPTS; i++) limiter.recordFailure(keys());
    advance(MIN);
    assert.ok(limiter.check(keys()).allowed);
    advance(LOGIN_LIMITS.RESET_AFTER_MS + 1);
    // Compteur remis à zéro : de nouveau tous les essais gratuits
    assert.deepEqual(limiter.recordFailure(keys()), { remaining: LOGIN_LIMITS.USER_FREE_ATTEMPTS - 1 });
  });

  test('la connexion réussie efface le compteur du compte, pas celui de l\'IP', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.recordFailure(keys());
    limiter.recordSuccess('user:alice');
    assert.deepEqual(limiter.recordFailure(keys()), { remaining: LOGIN_LIMITS.USER_FREE_ATTEMPTS - 1 });
  });

  test('compte bloqué quelle que soit l\'IP (attaque distribuée)', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < LOGIN_LIMITS.USER_FREE_ATTEMPTS; i++) limiter.recordFailure(keys('alice', `10.0.0.${i}`));
    assert.equal(limiter.check(keys('alice', '99.99.99.99')).allowed, false);
    assert.ok(limiter.check(keys('bob', '99.99.99.99')).allowed);
  });

  test('IP bloquée quel que soit le compte visé (essais sur plein de comptes)', () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < LOGIN_LIMITS.IP_FREE_ATTEMPTS; i++) limiter.recordFailure(keys(`user${i}`, '6.6.6.6'));
    assert.equal(limiter.check(keys('nouveau', '6.6.6.6')).allowed, false);
    assert.ok(limiter.check(keys('nouveau', '7.7.7.7')).allowed);
  });

  test('mémoire bornée', () => {
    const { limiter } = makeLimiter({ ...LOGIN_LIMITS, MAX_ENTRIES: 50 });
    for (let i = 0; i < 200; i++) limiter.recordFailure(keys(`u${i}`, `ip${i}`));
    assert.ok(limiter.size() <= 50);
  });
});

describe('loginLimiter — adresse IP du client', () => {
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });

  test('connexion directe : adresse de la socket, X-Forwarded-For ignoré', () => {
    assert.equal(getClientIp(req('192.168.1.20')), '192.168.1.20');
    assert.equal(getClientIp(req('::ffff:192.168.1.20', '1.1.1.1')), '192.168.1.20');
  });

  test('derrière un proxy local : dernière entrée de X-Forwarded-For (celle ajoutée par le proxy)', () => {
    assert.equal(getClientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
    assert.equal(getClientIp(req('::1', 'falsifiée, 203.0.113.7')), '203.0.113.7');
    assert.equal(getClientIp(req('::ffff:127.0.0.1')), '127.0.0.1');
  });

  test('délai lisible', () => {
    assert.equal(formatLockDelay(30 * 1000), '1 minute');
    assert.equal(formatLockDelay(4 * MIN), '4 minutes');
    assert.equal(formatLockDelay(4 * MIN + 1), '5 minutes');
  });
});
