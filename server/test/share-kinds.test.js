'use strict';
/* Koppelt die Ereignisarten von Server und Client.
 *
 * Der Client sendet "stroke-add", "text-upsert", "sync-chunk". Der Server
 * hatte zuerst "stroke", "text", "sync" - geraten statt gelesen. Neun von
 * elf Arten fielen durch: mit 400 "Unbekannte Ereignisart" abgewiesen, also
 * waeren zwei Geraete beim echten Teilen still auseinandergegangen.
 *
 * Dieser Test liest die Liste aus js/liveshare.js und vergleicht sie mit der
 * des Servers. Laeuft auf beiden Seiten ueber dieselben Dateien, ist das die
 * einfachste Form einer gemeinsamen Vereinbarung, die man nicht mehr
 * vergessen kann - anders als ein Kommentar.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const LIVESHARE = path.join(__dirname, '..', '..', 'js', 'liveshare.js');
const SERVER = path.join(__dirname, '..', 'shares.js');

/* KINDS aus dem Browser-Modul herausziehen, ohne es auszufuehren - es
 * braucht ein DOM und wuerde beim Laden Fenster und App annehmen. */
function clientKinds() {
  const src = fs.readFileSync(LIVESHARE, 'utf8');
  const m = /\bKINDS\s*=\s*(\[[\s\S]*?\])/.exec(src);
  assert.ok(m, 'KINDS nicht in js/liveshare.js gefunden - umbenannt?');
  // JSON.parse ist streng und lehnt einen Schlusskomma ab - im Clientcode
  // ist einer ueblich, hier nicht. Deshalb vorher entfernen.
  const list = JSON.parse(m[1].replace(/'/g, '"').replace(/,(\s*])/g, '$1'));
  return Array.isArray(list) ? list : [];
}

function serverKinds() {
  const { KINDS } = require(SERVER);
  return [...KINDS].sort();
}

test('Server kennt genau die Ereignisarten, die der Client sendet', () => {
  const client = clientKinds().slice().sort();
  const server = serverKinds();

  assert.ok(client.length, 'Client-Liste ist leer');
  assert.deepStrictEqual(
    server, client,
    'Ereignisarten stimmen nicht ueberein.\n' +
    '  nur im Client: ' + client.filter((k) => !server.includes(k)).join(', ') + '\n' +
    '  nur im Server: ' + server.filter((k) => !client.includes(k)).join(', ') + '\n' +
    '  Beide Listen muessen identisch sein - server/shares.js KINDS und js/liveshare.js KINDS.'
  );
});

test('der Server akzeptiert jede der Client-Arten und lehntschnellfremde ab', () => {
  const { KINDS } = require(SERVER);
  for (const k of clientKinds()) {
    assert.ok(KINDS.has(k), 'Server lehnt Client-Art ab: ' + k);
  }
  // Diese drei gab es nie und stehen in keiner der beiden Listen. Sie
  // standen in einem ersten, geratenen Entwurf und werden hier festgenagelt,
  // damit sie nicht zurueckkommen.
  for (const k of ['stroke', 'text', 'sync', 'join', 'leave', 'page', 'undo', 'redo']) {
    assert.ok(!KINDS.has(k), 'Server akzeptiert eine erfundene Art: ' + k);
  }
});