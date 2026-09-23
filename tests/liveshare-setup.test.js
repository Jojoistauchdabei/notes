'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Setup = require('../scripts/setup-liveshare.js');
const Live = require('../js/liveshare.js');

describe('liveshare-setup/plan', () => {
  it('plant beide Tabellen mit Row-Security', () => {
    const ops = Setup.plan(Setup.cfg());
    const tables = ops.filter(o => o.path === '/tablesdb/federwerk/tables');
    assert.equal(tables.length, 2);
    assert.deepEqual(tables.map(t => t.body.tableId).sort(), ['share_events', 'shares']);
    for (const t of tables) assert.equal(t.body.rowSecurity, true);
  });
  it('shares-Spalten decken shareRowBody ab', () => {
    const ops = Setup.plan(Setup.cfg());
    const cols = ops.filter(o => o.path.includes('/tables/shares/columns/')).map(o => o.body.key);
    const body = Live.shareRowBody({
      shareId: Live.makeShareCode(), bookId: 'b', ownerId: 'u',
      mode: 'edit', pageId: 'p', snapshot: {},
    });
    for (const k of Object.keys(body)) assert.ok(cols.includes(k), 'Spalte fehlt: ' + k);
    assert.ok(ops.some(o => o.path.includes('/tables/shares/indexes')));
  });
  it('events-Spalten decken alle Event-Kinds ab', () => {
    const ops = Setup.plan(Setup.cfg());
    const cols = ops.filter(o => o.path.includes('/tables/share_events/columns/')).map(o => o.body.key);
    for (const k of ['shareId', 'userId', 'userName', 'userColor', 'kind', 'payload', 'createdAt']) {
      assert.ok(cols.includes(k), 'Spalte fehlt: ' + k);
    }
    const code = Live.makeShareCode();
    for (const kind of Live.KINDS) {
      const ev = Live.buildEvent({ shareId: code, userId: 'u', kind, payload: {} });
      const row = Live.eventRowBody(ev).row;
      for (const k of Object.keys(row)) assert.ok(cols.includes(k), `Event-Feld ohne Spalte: ${kind}.${k}`);
    }
  });
  it('Tabellen-Namen folgen Live-Konstanten', () => {
    assert.equal(Live.SHARE_TABLE, 'shares');
    assert.equal(Live.EVENT_TABLE, 'share_events');
  });
});
