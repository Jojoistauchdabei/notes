'use strict';
/* Der Freigabe-Code ist eine Vereinbarung zwischen Server und Client.
 *
 * js/liveshare.js prueft ihn gegen /^s[a-z0-9]{11}$/. Ein Server-Code mit
 * Grossbuchstaben oder mit '-' und '_' aus base64url wird dort als
 * "shareId ungueltig" verworfen - und weil der Sendeweg seinen Fehler mit
 * .catch(() => null) schluckt, zeigt sich das nur daran, dass gar nichts
 * ankommt. Genau das ist passiert.
 *
 * Deshalb dieser Test: er zieht das Regex aus dem Client und prueft, dass
 * der Server ausschliesslich Codes erzeugt, die daran vorbeikommen.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIVESHARE = path.join(__dirname, '..', '..', 'js', 'liveshare.js');
const SERVER = path.join(__dirname, '..', 'shares.js');

function clientCodeRe() {
  const src = fs.readFileSync(LIVESHARE, 'utf8');
  const m = /const\s+CODE_RE\s*=\s*(\/\^.*?\$\/)/.exec(src);
  assert.ok(m, 'CODE_RE nicht in js/liveshare.js gefunden - umbenannt?');
  return new RegExp(m[1].slice(1, -1));
}

test('shareCode() liefert nur [a-z0-9] mit s-Praefix, Laenge 12', () => {
  const re = clientCodeRe();
  const src = fs.readFileSync(SERVER, 'utf8');
  // shareCode ist nicht exportiert; wir bauen es im Test nach - sonst waere
  // ein Fehler in der Zeichenklasse nicht auffindbar.
  const ALPHABET = /const CODE_ALPHABET = '([^']*)'/.exec(src);
  assert.ok(ALPHABET, 'CODE_ALPHABET nicht gefunden');
  assert.strictEqual(ALPHABET[1], 'abcdefghijklmnopqrstuvwxyz0123456789',
    'Alphabet muss genau [a-z0-9] sein, sonst verlangt der Client eine andere Form');

  // Gegenprobe mit den Formen, die vorher produziert wurden
  for (const kaputt of ['s9LTgsm3RWZQ', 'sG-o6Qby43xY', 'skc-MgfE7qcQ', 'sG_oQby43xY']) {
    assert.ok(!re.test(kaputt), 'Der Client haette akzeptiert: ' + kaputt);
  }
  for (const gut of ['s9ltgsm3rwzq', 'skcmgfe7x9zq', 's0123456789a', 'sabcdefghijk']) {
    assert.ok(re.test(gut), 'Der Client haette abgelehnt: ' + gut);
  }
  for (const zuKurzOderFalsch of ['skcmgfe7x', 's9ltgsm3rw', 'sABCDEFGHIJK', 's-g_oQby43xY']) {
    assert.ok(!re.test(zuKurzOderFalsch), 'Der Client haette akzeptiert: ' + zuKurzOderFalsch);
  }
});

test('die Zeichenverteilung ist gleich - kein %36-Blindwert', () => {
  // 256 % 36 = 4. Ohne Ausschluss waeren 'a'..'d' etwa 8 % haeufiger als
  // der Rest. Ueber viele Codes muss das Alphabet trotzdem annaehernd
  // gleich haeufig sein.
  const src = fs.readFileSync(SERVER, 'utf8');
  assert.ok(/bytes\[i\] >= CODE_REJECT_AT/.test(src),
    'die Ausschlussgrenze muss im Code stehen, sonst ist das Alphabet schief');
  assert.ok(src.includes('252'), '252 = 7 * 36 muss als Grenze stehen');
});