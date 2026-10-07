/* Office Crypto -- Envelope-Verschluesselung fuer Dokumente (AES-GCM).
 *
 * Ziel: Das Backend (heute lokal, spaeter selbst gehostet) sieht ausschliesslich
 * Chiffretext. Schluessel entstehen nie im Klartext gespeichert.
 *
 * Aufbau je Dokument:
 *   DEK (Data Encryption Key)  = 32 Zufallsbytes, pro Dokument frisch
 *   Chiffretext                = AES-GCM(DEK, Dokumentbytes)
 *   gewickelter DEK            = AES-GCM(KEK, DEK)
 *   KEK                        = PBKDF2-SHA256(Passphrase, Salt, 210000)
 *
 * Der KEK wird einmal pro Tresor aus einer Passphrase abgeleitet (fester Salt im
 * Tresor, nicht je Dokument) -- sonst wuerde jedes Speichern 210000 Runden
 * kosten. Pro Dokument trotzdem eigener DEK + eigener IV: derselbe Klartext
 * erzeugt nie zweimal dasselbe Chiffretext, und ein Dokument laesst sich einzeln
 * rotieren, ohne den ganzen Tresor anzufassen.
 */
(function () {
  'use strict';

  const SUBTLE = () => globalThis.crypto.subtle;
  const PBKDF2_ITERATIONS = 210000; // OWASP-Empfehlung fuer PBKDF2-HMAC-SHA256
  const KEY_BYTES = 32;
  const IV_BYTES = 12; // AES-GCM: 96-Bit-Nonce ist der empfohlene Wert
  const FORMAT_VERSION = 1;

  function bytesToB64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  function b64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
      // Blob ist asynchron -> Aufrufer muss await toBytes(...) nutzen.
      return input.arrayBuffer().then((b) => new Uint8Array(b));
    }
    if (typeof input === 'string') return new TextEncoder().encode(input);
    throw new TypeError('toBytes: nicht unterstuetzter Typ ' + typeof input);
  }

  async function deriveKek(passphrase, salt, iterations) {
    const base = await SUBTLE().importKey(
      'raw', await toBytes(passphrase), 'PBKDF2', false, ['deriveKey'],
    );
    return SUBTLE().deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /* Tresor: haelt KEK + Salt fuer die Lebensdauer einer Sitzung. Das Salt
   * selbst wird mitgespeichert (public), damit derselbe Tresor nach einem
   * Neuladen wieder geoeffnet werden kann. */
  function createVault(passphrase, options) {
    const opts = options || {};
    const iterations = opts.iterations || PBKDF2_ITERATIONS;
    if (typeof passphrase !== 'string' || !passphrase) {
      throw new TypeError('createVault: Passphrase fehlt.');
    }
    let kek = null;
    let saltB64 = opts.salt || null;
    // Der Cache-Schluessel merkt sich, fuer welche Parameter der aktuelle KEK
    // tatsaechlich abgeleitet wurde. Ohne das wuerde open() bei jedem Dokument
    // neu ableiten, sobald Parameter und Envelope auseinanderlaufen.
    let kekSalt = null;
    let kekIterations = null;
    let derives = 0;

    async function ready() {
      if (kek) return kek;
      if (!globalThis.crypto || !SUBTLE()) {
        throw new Error('WebCrypto nicht verfuegbar (kein sicherer Kontext).');
      }
      if (!saltB64) {
        saltB64 = bytesToB64(globalThis.crypto.getRandomValues(new Uint8Array(16)));
      }
      kek = await deriveKek(passphrase, b64ToBytes(saltB64), iterations);
      kekSalt = saltB64;
      kekIterations = iterations;
      derives++;
      return kek;
    }

    return {
      // Zum Persistieren: derselbe Tresor laesst sich damit wiederherstellen.
      salt: () => saltB64,
      iterations: () => iterations,
      // Zaehler fuer Tests und Diagnose: wie oft wurde der KEK tatsaechlich
      // abgeleitet? Ein korrekt gecachter Tresor bleibt bei genau 1, egal wie
      // viele Dokumente geoeffnet werden.
      derives: () => derives,

      async seal(input) {
        const key = await ready();
        const plain = await toBytes(input);
        const dek = await SUBTLE().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        const dekRaw = new Uint8Array(await SUBTLE().exportKey('raw', dek));

        const dekIv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const wrapped = new Uint8Array(await SUBTLE().encrypt(
          { name: 'AES-GCM', iv: dekIv }, key, dekRaw,
        ));
        const dataIv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
        const body = new Uint8Array(await SUBTLE().encrypt(
          { name: 'AES-GCM', iv: dataIv }, dek, plain,
        ));

        return {
          v: FORMAT_VERSION,
          alg: 'AES-GCM',
          kdf: 'PBKDF2-SHA256',
          iterations,
          salt: saltB64,
          dekIv: bytesToB64(dekIv),
          dek: bytesToB64(wrapped),
          dataIv: bytesToB64(dataIv),
          ciphertext: bytesToB64(body),
        };
      },

      async open(envelope) {
        const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
        if (!env || env.v !== FORMAT_VERSION || env.alg !== 'AES-GCM') {
          throw new Error('Unbekanntes Envelope-Format.');
        }
        // Salt/Iteration gehoeren zum Envelope: so laesst sich ein Tresor
        // weiterverwenden, auch wenn die Parameter einmal geaendert wurden.
        // Nur bei echter Abweichung neu ableiten -- sonst kostet jedes
        // Dokument 210000 Runden extra.
        if (kek === null || kekSalt !== env.salt || kekIterations !== env.iterations) {
          saltB64 = env.salt;
          kek = await deriveKek(passphrase, b64ToBytes(env.salt), env.iterations);
          kekSalt = env.salt;
          kekIterations = env.iterations;
          derives++;
        }
        const key = await ready();

        const dekRaw = new Uint8Array(await SUBTLE().decrypt(
          { name: 'AES-GCM', iv: b64ToBytes(env.dekIv) }, key, b64ToBytes(env.dek),
        ));
        const dek = await SUBTLE().importKey('raw', dekRaw, 'AES-GCM', false, ['decrypt']);
        return new Uint8Array(await SUBTLE().decrypt(
          { name: 'AES-GCM', iv: b64ToBytes(env.dataIv) }, dek, b64ToBytes(env.ciphertext),
        ));
      },
    };
  }

  const Crypto = { createVault, bytesToB64, b64ToBytes, toBytes, PBKDF2_ITERATIONS };

  if (typeof window !== 'undefined') window.OfficeCrypto = Crypto;
  if (typeof module !== 'undefined' && module.exports) module.exports = Crypto;
})();
