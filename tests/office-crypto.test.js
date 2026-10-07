'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Crypto = require('../office/js/crypto.js');

// PBKDF2-Runden in Tests niedrig halten: 210000 ist der Produktionswert, kostet
// hier aber pro Fall Zeit, ohne etwas ueber die Logik auszusagen.
const FAST = { iterations: 1000 };

describe('office/crypto', () => {
  it('seal/open Roundtrip erhaelt die Bytes', async () => {
    const vault = Crypto.createVault('passwort', FAST);
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255]);
    const env = await vault.seal(bytes);
    assert.deepEqual([...await vault.open(env)], [...bytes]);
  });

  it('seal erzeugt bei gleichem Klartext unterschiedliches Chiffretext', async () => {
    const vault = Crypto.createVault('passwort', FAST);
    const bytes = new Uint8Array([9, 9, 9]);
    const a = await vault.seal(bytes);
    const b = await vault.seal(bytes);
    assert.notEqual(a.dek, b.dek, 'DEK muss pro Dokument frisch sein');
    assert.notEqual(a.ciphertext, b.ciphertext, 'IV muss pro Verschluesselung frisch sein');
    assert.deepEqual([...await vault.open(a)], [...await vault.open(b)]);
  });

  it('falsche Passphrase scheitert an der Authentifizierung', async () => {
    const env = await Crypto.createVault('richtig', FAST).seal(new Uint8Array([1]));
    const falsch = Crypto.createVault('falsch', FAST);
    await assert.rejects(() => falsch.open(env));
  });

  it('manipuliertes Chiffretext wird erkannt', async () => {
    const vault = Crypto.createVault('passwort', FAST);
    const env = await vault.seal(new Uint8Array([1, 2, 3]));
    const bytes = Crypto.b64ToBytes(env.ciphertext);
    bytes[0] ^= 0xff;
    env.ciphertext = Crypto.bytesToB64(bytes);
    await assert.rejects(() => vault.open(env), 'GCM-Tag muss die Manipulation melden');
  });

  it('Salt bleibt ueber Envelopes stabil, damit der Tresor wieder aufgeht', async () => {
    const vault = Crypto.createVault('passwort', FAST);
    const a = await vault.seal(new Uint8Array([1]));
    const b = await vault.seal(new Uint8Array([2]));
    assert.equal(a.salt, b.salt);
    assert.equal(vault.salt(), a.salt);
  });

  it('Tresor laesst sich mit gespeichertem Salt neu oeffnen', async () => {
    const first = Crypto.createVault('passwort', FAST);
    const env = await first.seal(new Uint8Array([42]));
    const again = Crypto.createVault('passwort', { iterations: FAST.iterations, salt: env.salt });
    assert.deepEqual([...await again.open(env)], [42]);
  });

// Ein Tresor muss den KEK genau einmal ableiten, egal wie viele Dokumente er
// öffnet -- 210000 PBKDF2-Runden pro Dokument waeren unbrauchbar. Geprueft
  // wird ueber einen Ableitungszaehler statt ueber die Dauer: Timing-Schwellen
  // wackeln auf langsamen CI-Maschinen.
  it('der KEK wird fuer viele Dokumente nur einmal abgeleitet', async () => {
    const vault = Crypto.createVault('pw', FAST);
    const envelopes = [];
    for (let i = 0; i < 5; i++) envelopes.push(await vault.seal(new Uint8Array([i])));
    assert.equal(vault.derives(), 1, 'seal() ableitet einmal');
    for (let i = 0; i < envelopes.length; i++) {
      assert.deepEqual([...await vault.open(envelopes[i])], [i]);
    }
    assert.equal(vault.derives(), 1, 'oeffnen darf nicht neu ableiten');
  });

  it('wieder geoeffneter Tresor leitet einmal ab und oeffnet alle Dokumente', async () => {
    const first = Crypto.createVault('pw', FAST);
    const envelopes = [await first.seal(new Uint8Array([1])), await first.seal(new Uint8Array([2]))];
    const again = Crypto.createVault('pw', { iterations: FAST.iterations, salt: first.salt() });
    assert.equal(again.derives(), 0);
    assert.deepEqual([...await again.open(envelopes[0])], [1]);
    assert.equal(again.derives(), 1);
    assert.deepEqual([...await again.open(envelopes[1])], [2]);
    assert.equal(again.derives(), 1);
  });

  it('JSON-Roundtrip ueber die Serialisierung', async () => {
    const vault = Crypto.createVault('passwort', FAST);
    const env = await vault.seal(new Uint8Array([7, 7]));
    assert.deepEqual([...await vault.open(JSON.stringify(env))], [7, 7]);
  });

  it('Basis64 und Text-Kodierung', () => {
    const bytes = new Uint8Array([0, 127, 128, 255]);
    assert.deepEqual([...Crypto.b64ToBytes(Crypto.bytesToB64(bytes))], [...bytes]);
  });

  it('Text wird UTF-8-kodiert', async () => {
    const vault = Crypto.createVault('pw', FAST);
    const env = await vault.seal('Grüße äöü');
    assert.equal(new TextDecoder().decode(await vault.open(env)), 'Grüße äöü');
  });

  it('unbekanntes Envelope-Format wird abgelehnt', async () => {
    const vault = Crypto.createVault('pw', FAST);
    await assert.rejects(() => vault.open({ v: 99, alg: 'ROT13' }));
  });

  it('leere Passphrase wird abgelehnt', () => {
    assert.throws(() => Crypto.createVault(''), TypeError);
  });
});
