'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const L = require('../js/liveshare.js');
const G = require('../functions/share-events-guard/index.js');
const Setup = require('../scripts/setup-liveshare.js');

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

describe('review/event-perms-append-only', () => {
  it('eventPerms: lesen ja, updaten nein, löschen nur eigene', () => {
    const p = L.eventPerms('u9');
    assert.ok(p.some(s => s === 'read("users")'), 'alle Eingeloggten lesen');
    assert.ok(p.some(s => s.includes('u9') && s.startsWith('delete(')), 'eigene löschbar');
    assert.ok(!p.some(s => s.startsWith('update(')), 'kein update (append-only)');
  });
  it('setup: share_events-Tabellen-Perms ohne update/delete', () => {
    const ops = Setup.plan(Setup.cfg());
    const t = ops.find(o => o.path === '/tablesdb/federwerk/tables' && o.body.tableId === 'share_events');
    assert.ok(t, 'share_events-Tabelle geplant');
    assert.ok(t.body.permissions.includes('read("users")'));
    assert.ok(t.body.permissions.includes('create("users")'));
    assert.ok(!t.body.permissions.some(p => p.startsWith('update(') || p.startsWith('delete(')));
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

describe('review/guard-function', () => {
  const code = L.makeShareCode();
  const share = (over) => Object.assign(
    { shareId: code, ownerId: 'owner-1', mode: 'read', revoked: false, expiresAt: null }, over || {});
  it('Owner darf alles, Gast im read-Modus nur Presence', () => {
    assert.equal(G.checkSender(share(), 'owner-1', 'stroke-add').ok, true);
    assert.equal(G.checkSender(share(), 'gast-9', 'stroke-add').ok, false);
    assert.equal(G.checkSender(share(), 'gast-9', 'cursor').ok, true);
  });
  it('Gast im edit-Modus darf schreiben, aber keinen Snapshot schicken', () => {
    assert.equal(G.checkSender(share({ mode: 'edit' }), 'gast-9', 'text-upsert').ok, true);
    assert.equal(G.checkSender(share({ mode: 'edit' }), 'gast-9', 'sync-state').ok, false);
    assert.equal(G.checkSender(share({ mode: 'edit' }), 'owner-1', 'sync-state').ok, true);
  });
  it('revoked/abgelaufen/unbekannt/unauthentifiziert wird abgelehnt', () => {
    assert.equal(G.checkSender(share({ revoked: true }), 'owner-1', 'cursor').ok, false);
    assert.equal(G.checkSender(
      share({ expiresAt: new Date(Date.now() - 1000).toISOString() }), 'owner-1', 'cursor').ok, false);
    assert.equal(G.checkSender({}, 'owner-1', 'cursor').ok, false);
    assert.equal(G.checkSender(share(), '', 'cursor').ok, false);
    assert.equal(G.checkSender(share(), 'gast-9', 'nope').ok, false);
  });
  it('sanitizeEvent: userId wird vergeben (nicht übernommen), Müll abgelehnt', () => {
    const row = G.sanitizeEvent(
      { shareId: code, userId: 'owner-1', userName: 'Fälscher', kind: 'stroke-add', payload: { a: 1 } },
      'gast-9-verifiziert');
    assert.equal(row.userId, 'gast-9-verifiziert');
    assert.equal(row.shareId, code);
    assert.throws(() => G.sanitizeEvent({ shareId: 'bad', kind: 'cursor' }, 'u'), /shareId/);
    assert.throws(() => G.sanitizeEvent({ shareId: code, kind: 'nope' }, 'u'), /kind/);
    assert.throws(() => G.sanitizeEvent(
      { shareId: code, kind: 'sync-state', payload: 'x'.repeat(40 * 1024) }, 'u'), /Payload/);
  });
  it('Guard-Regeln spiegeln die Client-Regeln', () => {
    // Gleiche Matrix auf beiden Seiten (Client: js/liveshare.js, Server: guard).
    const cases = [
      ['stroke-add', false, 'read', false], ['stroke-add', false, 'edit', true],
      ['stroke-add', true, 'read', true], ['sync-state', false, 'edit', false],
      ['sync-state', true, 'read', true], ['cursor', false, 'read', true],
    ];
    for (const [kind, owner, mode, want] of cases) {
      assert.equal(L.canSendKind(kind, owner, mode), want, `client ${kind}/${owner}/${mode}`);
      assert.equal(G.canSendKind(kind, owner, mode), want, `guard ${kind}/${owner}/${mode}`);
    }
  });
});
