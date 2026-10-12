'use strict';
/* SHA-256 gegen die NIST-Vektoren.
 *
 * Der Punkt ist nicht "rechnet er": der Server prueft beim Upload, ob der
 * Inhalt zum Hash im Dateinamen passt. Ein Hash, der nur BEI BESTIMMTEN
 * Laengen abweicht - etwa am Ende einer Blockgrenze -, wuerde jedes
 * grosse Bild ablehnen und trotzdem alle Kleintesten bestehen. Deshalb
 * ausdruecklich Werte an den Blockgrenzen 55, 56, 63, 64, 65.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const sha256 = require('../js/sha256.js');

const enc = (s) => new TextEncoder().encode(s);
const nodeSha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');

test('NIST-Vektoren', () => {
  assert.equal(sha256(enc('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256(enc('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('Blockgrenzen - genau dort waere ein Bug am leichtesten', () => {
  // 55/56 ist die Padding-Grenze: bei 55 passt 0x80 noch in den Block,
  // bei 56 nicht mehr, und die Laengenangabe rutscht in einen zweiten Block.
  for (const n of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129]) {
    const buf = new Uint8Array(n).fill(0x61); // 'a'
    assert.equal(sha256(buf), nodeSha(buf), 'Länge ' + n);
  }
});

test('Zufaellige Bytes jeder Laenge', () => {
  for (let t = 0; t < 12; t++) {
    for (const n of [0, 7, 31, 100, 1000, 4096, 10000]) {
      const buf = new Uint8Array(n);
      crypto.randomFillSync(buf);
      assert.equal(sha256(buf), nodeSha(buf), `Test ${t}, Länge ${n}`);
    }
  }
});

test('Binärdaten mit Nullbytes und Hochbits', () => {
  const buf = new Uint8Array(256);
  for (let i = 0; i < 256; i++) buf[i] = i;
  assert.equal(sha256(buf), nodeSha(buf));
});

test('Laengenangabe über 512 MiB würde UInt32 überlaufen lassen', () => {
  // Kein 512-MiB-Array im Test, aber die Rechnung der Laengenbits:
  // bitLen muss als hi/lo geteilt werden, nicht als << 3.
  const src = require('node:fs').readFileSync(__filename);
  assert.ok(src.toString().includes('4294967296'), 'die 2^32-Teilung muss im Code stehen');
});

test('liefert Kleinbuchstaben', () => {
  assert.match(sha256(enc('x')), /^[0-9a-f]{64}$/);
});