'use strict';
// Rechte-Matrix des Liveshare. Geprueft wird die reine Client-Seite
// (js/liveshare.js); die verbindliche Pruefung liegt seit dem Umstieg auf den
// eigenen Server in server/shares.js - eine separate Guard-Function brauchte es
// nur, weil die Zeilenrechte des frueheren Cloud-Backends keine
// Freigabe-Mitgliedschaft kannten.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/liveshare.js');

describe('review/uid-ohne-fallback', () => {
  it('uid wirft ohne crypto.getRandomValues statt Math.random zu nutzen', () => {
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    assert.ok(desc && desc.configurable, 'crypto muss zum Testen ersetzbar sein');
    const saved = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
      assert.throws(() => L.uid(11), /sicherer Zufall/);
      assert.throws(() => L.makeShareCode(), /sicherer Zufall/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', desc || { value: saved, configurable: true });
    }
  });
  it('mit crypto kommen gültige Codes raus', () => {
    assert.ok(L.isValidShareCode(L.makeShareCode()));
  });
});

describe('review/absender-rechte', () => {
  it('canSendKind: Presence immer, Mutationen nur edit/Owner, Snapshots nur Owner', () => {
    for (const k of ['hello', 'heartbeat', 'bye', 'cursor', 'sync-request']) {
      assert.ok(L.canSendKind(k, false, 'read'), k + ' Gast/read');
    }
    assert.ok(L.canSendKind('stroke-add', false, 'edit'));
    assert.ok(!L.canSendKind('stroke-add', false, 'read'));
    assert.ok(!L.canSendKind('text-upsert', false, 'read'));
    assert.ok(L.canSendKind('stroke-del', true, 'read'), 'Owner immer');
    assert.ok(!L.canSendKind('sync-state', false, 'edit'), 'Snapshot nur Owner');
    assert.ok(L.canSendKind('sync-state', true, 'read'));
    assert.ok(!L.canSendKind('nope', true, 'edit'), 'unbekannte Kind nie');
  });
  it('isEventAllowed: revoked/abgelaufen blockt alles', () => {
    const code = L.makeShareCode();
    assert.equal(L.isEventAllowed({ shareId: code, revoked: true, mode: 'edit' }, true, 'cursor'), false);
    assert.equal(L.isEventAllowed({ shareId: code, mode: 'edit' }, false, 'stroke-add'), true);
    assert.equal(L.isEventAllowed({ shareId: code, mode: 'read' }, false, 'stroke-add'), false);
    assert.equal(L.isEventAllowed({ shareId: code, mode: 'read' }, false, 'cursor'), true);
  });
});
