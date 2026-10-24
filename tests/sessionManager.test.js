import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClientId } from '../src/utils/sessionManager.js';

describe('Multi-Client Session Manager', () => {
  it('accepte un clientId valide depuis req.query', () => {
    const req = { query: { clientId: 'client_desktop_1234' } };
    const id = resolveClientId(req);
    assert.strictEqual(id, 'client_desktop_1234');
  });

  it('accepte un clientId valide depuis le header x-client-id', () => {
    const req = { headers: { 'x-client-id': 'client_mobile_9876' } };
    const id = resolveClientId(req);
    assert.strictEqual(id, 'client_mobile_9876');
  });

  it('génère un identifiant cryptographique unique si le clientId est absent', () => {
    const req1 = { query: {}, headers: {} };
    const req2 = { query: {}, headers: {} };

    const id1 = resolveClientId(req1);
    const id2 = resolveClientId(req2);

    assert.ok(id1.startsWith('anon_'));
    assert.ok(id2.startsWith('anon_'));
    // Isolation absolue : deux requêtes sans clientId n'auront jamais le même id
    assert.notStrictEqual(id1, id2);
  });

  it('rejette les identifiants avec des caractères dangereux ou espaces et génère un ID sain', () => {
    const req = { query: { clientId: 'bad; rm -rf /; id' } };
    const id = resolveClientId(req);

    assert.ok(id.startsWith('anon_'));
    assert.strictEqual(/^[a-zA-Z0-9_\-]+$/.test(id), true);
  });
});
