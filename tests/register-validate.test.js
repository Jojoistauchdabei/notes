'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const F = require('../js/appwrite-files.js');

describe('register/validateRegister', () => {
  it('akzeptiert gültige Eingaben (Name optional)', () => {
    assert.deepEqual(F.validateRegister({
      name: 'Ada', email: 'ada@beispiel.de', password: 'Geheim123!', confirm: 'Geheim123!',
    }), { ok: true, errors: [] });
    assert.equal(F.validateRegister({
      name: '', email: ' a@b.de ', password: '12345678', confirm: '12345678',
    }).ok, true);
  });
  it('lehnt ungültige E-Mail ab', () => {
    for (const email of ['', 'keine-mail', 'a@b', 'a @b.de', 'a@b de']) {
      const r = F.validateRegister({ email, password: 'Geheim123!', confirm: 'Geheim123!' });
      assert.equal(r.ok, false, email);
      assert.ok(r.errors.length >= 1);
    }
  });
  it('fordert min. 8 Zeichen und gleiche Wiederholung', () => {
    const short = F.validateRegister({ email: 'a@b.de', password: 'kurz', confirm: 'kurz' });
    assert.equal(short.ok, false);
    assert.match(short.errors.join(' '), /8 Zeichen/);
    const mismatch = F.validateRegister({ email: 'a@b.de', password: 'Geheim123!', confirm: 'anders123!' });
    assert.equal(mismatch.ok, false);
    assert.match(mismatch.errors.join(' '), /überein/);
  });
  it('begrenzt Namenslänge, crasht nicht bei leeren/defensiven Eingaben', () => {
    const long = F.validateRegister({ name: 'x'.repeat(129), email: 'a@b.de', password: 'Geheim123!', confirm: 'Geheim123!' });
    assert.equal(long.ok, false);
    assert.equal(F.validateRegister(null).ok, false);
    assert.equal(F.validateRegister({}).ok, false);
    assert.equal(F.validateRegister(undefined).ok, false);
  });
});

describe('register/passwordStrength', () => {
  it('bewertet leer bis sehr stark monoton', () => {
    assert.equal(F.passwordStrength('').score, 0);
    assert.equal(F.passwordStrength('kurz').score, 0);
    const schwach = F.passwordStrength('abcdefgh');
    const mittel = F.passwordStrength('Abcdefgh');
    const stark = F.passwordStrength('Abcdefgh1!');
    const top = F.passwordStrength('Abcdefghij12!$');
    assert.ok(schwach.score <= mittel.score, 'monoton');
    assert.ok(mittel.score <= stark.score, 'monoton');
    assert.ok(stark.score <= top.score, 'monoton');
    assert.equal(top.score, 4);
    assert.equal(top.label, 'sehr stark');
    assert.ok(schwach.hint && stark.hint);
  });
  it('liefert Score 0–4 mit Label', () => {
    for (const pw of ['', 'a', 'abcdefgh', 'Abcdefgh1!', 'SehrLangesPasswort123!$']) {
      const s = F.passwordStrength(pw);
      assert.ok(s.score >= 0 && s.score <= 4);
      assert.ok(typeof s.label === 'string' && s.label.length > 0);
    }
  });
});

describe('register/registerAccount', () => {
  const mem = new Map();
  const backend = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
  };
  let origFetch;
  beforeEach(() => {
    origFetch = global.fetch;
    mem.clear();
    F._internals._setLsBackend(backend);
  });
  afterEach(() => {
    global.fetch = origFetch;
    F._internals._resetLs();
  });

  /* Frueher: POST /account mit userId 'unique()' und danach ein zweiter
   *   Aufruf fuer die Session, deren Secret in den localStorage wanderte.
   * Jetzt: EIN Aufruf. Der Server vergibt die ID und legt die Session in
   * einem Rutsch an; das HttpOnly-Cookie nimmt der Browser entgegen. Der
   * Test prueft deshalb jetzt das Wegbleiben des Secrets - ein Secret im
   * localStorage waere fuer jeden XSS-Pfad auslesbar. */
  it('registriert mit einem Aufruf und legt kein Secret ab', async () => {
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, opts });
      const body = opts && opts.body ? JSON.parse(opts.body) : {};
      if (url.endsWith('/api/auth/register') && opts.method === 'POST') {
        assert.equal(body.email, 'neu@beispiel.de');
        assert.equal(body.password, 'Geheim123!');
        assert.equal(body.name, 'Neu');
        assert.equal(body.userId, undefined, 'die ID vergibt der Server');
        return {
          ok: true, status: 201,
          headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
          json: async () => ({ user: { id: 'u1', email: 'neu@beispiel.de' } }),
        };
      }
      throw new Error('unerwarteter Call ' + url);
    };
    const j = await F.registerAccount({ name: 'Neu', email: 'neu@beispiel.de', password: 'Geheim123!' });
    assert.equal(j.user.id, 'u1');
    assert.equal(j.secret, undefined, 'kein Secret in der Antwort');
    assert.equal(F.loadSession(), null, 'kein Secret im localStorage');
    assert.equal(calls.length, 1, 'Registrierung und Anmeldung fallen zusammen');
  });

  it('meldet bei bereits vergebener Adresse die Anmeldung statt eines Fehlers', async () => {
    // Der Server meldet 409. Ein erneuter Registrierungsklick soll den
    // Nutzer nicht mit "gibt es schon" abschrecken, sondern einloggen.
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push(url);
      if (url.endsWith('/api/auth/register')) {
        return { ok: false, status: 409, headers: { get: () => 'application/json' }, json: async () => ({ error: 'bereits registriert' }) };
      }
      if (url.endsWith('/api/auth/login')) {
        return {
          ok: true, status: 200,
          headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
          json: async () => ({ user: { id: 'u1', email: 'neu@beispiel.de' } }),
        };
      }
      throw new Error('unerwarteter Call ' + url);
    };
    const j = await F.registerAccount({ email: 'neu@beispiel.de', password: 'Geheim123!' });
    assert.equal(j.user.id, 'u1');
    assert.equal(calls.length, 2, 'zuerst 409, dann der Anmeldeversuch');
  });

  it('validiert vor dem Netz: ohne E-Mail/Passwort und kurzes Passwort', async () => {
    global.fetch = async () => { throw new Error('darf nicht aufgerufen werden'); };
    await assert.rejects(() => F.registerAccount({ email: '', password: 'Geheim123!' }), /E-Mail/);
    await assert.rejects(() => F.registerAccount({ email: 'a@b.de', password: 'kurz' }), /8 Zeichen/);
  });
});
