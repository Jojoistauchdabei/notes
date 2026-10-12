/* Federwerk: SHA-256 in reinem JavaScript.
 *
 * Warum es das gibt: der Browser gibt crypto.subtle nur in einem sicheren
 * Kontext frei - also ueber HTTPS oder auf localhost. Wer die App ueber
 * http://192.168.x.x:8080 oeffnet, hat kein subtle, und daran haengt der
 * komplette Sync: Content-Hashing fuer Dedupe, Konflikterkennung und die
 * Namenspruefung des Servers beim Upload. Ohne diesen Ersatz waere die App
 * ueber die lokale IP startklar und beim ersten Speichern blind.
 *
 * Korrektheit ist hier keine Nebensache. Der Server prueft beim Upload, ob
 * der Inhalt zum SHA-256 im Dateinamen passt, und lehnt Abweichung mit 422
 * ab. Ein falscher Hash faellt hier also sofort auf - aber ein Hash, der bei
 * grossen Bildern anders ist als beim Server, wuerde jedes Upload ablehnen.
 * Deshalb gegen die NIST-Vektoren getestet (tests/sha256.test.js) und
 * bewusst die Referenzformulierung, nicht eine "schnellere" Variante.
 */
(function () {
  'use strict';

  // Rundungskonstanten: die ersten 32 Bit der Bruchstuecke der Kubikwurzeln
  // der ersten 64 Primzahlen.
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  const HEX = '0123456789abcdef';
  const W = new Uint32Array(64);

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  /* bytes: Uint8Array - beliebiger Laenge. Liefert den Hex-String. */
  function sha256(bytes) {
    const len = bytes.length;
    const bitLen = len * 8;
    // Laengenangabe ist 64 Bit, unsere Eingabe ist aber hoechstens ein
    // 32-Bit-Array: hi = bitLen / 2^32, lo = bitLen mod 2^32.
    const hi = Math.floor(bitLen / 4294967296);
    const lo = bitLen >>> 0;

    // 1 Byte 0x80, auf 56 Byte Grenze fuellen, dann 8 Byte Laenge.
    const withPad = ((len + 8) >> 6) + 1;
    const total = withPad << 6;
    const buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    const view = new DataView(buf.buffer);
    view.setUint32(total - 8, hi);
    view.setUint32(total - 4, lo);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const a = W[i - 15], b = W[i - 2];
        const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
        const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }

      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }

      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
    }

    return hex32(h0) + hex32(h1) + hex32(h2) + hex32(h3) +
           hex32(h4) + hex32(h5) + hex32(h6) + hex32(h7);
  }

  function hex32(n) {
    let s = '';
    for (let i = 7; i >= 0; i--) s += HEX[(n >>> (i * 4)) & 15];
    return s;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = sha256;
  else if (typeof window !== 'undefined') window.FederwerkSha256 = sha256;
})();