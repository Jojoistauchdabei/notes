const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/* Mocks für Browser-APIs, damit js/cloud.js in Node testbar ist. */
const store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
if (typeof global.btoa === 'undefined') {
  global.btoa = (s) => Buffer.from(s, 'binary').toString('base64');
}

const fetchCalls = [];
let fetchHandler = null;
global.fetch = async (url, opts) => {
  fetchCalls.push({ url: String(url), method: (opts && opts.method) || 'GET', body: opts && opts.body });
  if (fetchHandler) return fetchHandler(String(url), opts || {});
  return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({}) };
};
function okJson(data) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(data), json: async () => data };
}
function okText(t) {
  return { ok: true, status: 207, statusText: 'Multi', text: async () => t, json: async () => { throw new Error('no json'); } };
}

global.window = { state: { books: [] }, persistNow: () => {}, renderLibrary: () => {} };

const Cloud = require('../js/cloud.js');
const { decideBook, resolveFile, loadMap, saveMap } = Cloud._internals;

function reset() {
  for (const k of Object.keys(store)) delete store[k];
  fetchCalls.length = 0;
  fetchHandler = null;
  global.window.state = { books: [] };
  Cloud.saveConfig({ baseUrl: 'https://cloud.de/dav/files/u', username: 'u', password: 'p', folder: 'Grimoire' });
}

describe('cloud/decideBook', () => {
  it('remote-new ohne lokales Buch', () => {
    assert.equal(decideBook(null, { updatedAt: 5 }, null), 'remote-new');
  });
  it('same bei gleichem Stand', () => {
    assert.equal(decideBook({ updatedAt: 10 }, { updatedAt: 10 }, { lastSyncLocal: 10 }), 'same');
  });
  it('remote-newer wenn nur remote geändert', () => {
    assert.equal(decideBook({ updatedAt: 100 }, { updatedAt: 200 }, { lastSyncLocal: 100 }), 'remote-newer');
  });
  it('same wenn nur lokal geändert (Push löst auf)', () => {
    assert.equal(decideBook({ updatedAt: 300 }, { updatedAt: 100 }, { lastSyncLocal: 100 }), 'same');
  });
  it('conflict wenn beide geändert + remote neuer', () => {
    assert.equal(decideBook({ updatedAt: 200 }, { updatedAt: 300 }, { lastSyncLocal: 100 }), 'conflict');
  });
  it('same wenn beide geändert + lokal neuer (kein Fehlalarm)', () => {
    assert.equal(decideBook({ updatedAt: 300 }, { updatedAt: 200 }, { lastSyncLocal: 100 }), 'same');
  });
});

describe('cloud/push', () => {
  beforeEach(reset);
  afterEach(() => { fetchHandler = null; });

  it('resolveFile bleibt bei Rename stabil (keine Cloud-Leichen)', async () => {
    saveMap({ b1: { file: 'Alter_Titel__b1.json', lastSyncLocal: 1, lastSync: 1 } });
    fetchHandler = async () => ({ ok: true, status: 201, statusText: 'Created', text: async () => '' });
    const file = await Cloud.pushBook({ id: 'b1', title: 'Neuer Titel', updatedAt: 2, pages: [] });
    assert.equal(file, 'Alter_Titel__b1.json');
    const put = fetchCalls.find((c) => c.method === 'PUT');
    assert.match(put.url, /Alter_Titel__b1\.json$/);
  });

  it('pushAll lädt alle Bücher hoch + räumt Map-Leichen auf', async () => {
    saveMap({ ghost: { file: 'x__ghost.json' } });
    global.window.state.books = [
      { id: 'b1', title: 'A', updatedAt: 1, pages: [] },
      { id: 'b2', title: 'B', updatedAt: 1, pages: [] },
    ];
    fetchHandler = async () => ({ ok: true, status: 201, statusText: 'Created', text: async () => '' });
    const out = await Cloud.pushAll();
    assert.equal(out.length, 2);
    assert.ok(!loadMap().ghost);
  });

  it('zweiter Sync während laufendem Sync wird abgelehnt (Guard)', async () => {
    global.window.state.books = [{ id: 'b1', title: 'A', updatedAt: 1, pages: [] }];
    let release;
    const gate = new Promise((res) => { release = res; });
    fetchHandler = async (url, opts) => {
      if ((opts.method || 'GET') === 'PUT') await gate;
      return { ok: true, status: 201, statusText: 'Created', text: async () => '' };
    };
    const first = Cloud.pushAll();
    await assert.rejects(Cloud.pushAll(), /bereits/);
    release();
    await first;
  });
});

describe('cloud/pull + delete', () => {
  beforeEach(reset);
  afterEach(() => { fetchHandler = null; });

  function propfind(files) {
    const items = files.map((f) => `<d:response><d:href>/dav/files/u/Grimoire/${f}</d:href></d:response>`).join('');
    return okText(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/files/u/Grimoire/</d:href></d:response>${items}</d:multistatus>`);
  }

  it('pullAll: remote-newer ersetzt lokal, Konflikt erzeugt Kopie statt Überschreiben', async () => {
    global.window.state.books = [
      { id: 'b1', title: 'Lokal alt', updatedAt: 100, pages: [{ id: 'p' }] },
      { id: 'b2', title: 'Lokal geändert', updatedAt: 200, pages: [{ id: 'p' }] },
    ];
    saveMap({
      b1: { file: 'x__b1.json', lastSyncLocal: 100, lastSync: 1 },
      b2: { file: 'x__b2.json', lastSyncLocal: 100, lastSync: 1 },
    });
    const remote1 = { id: 'b1', title: 'Remote neuer', updatedAt: 200, pages: [{ id: 'p' }] };
    const remote2 = { id: 'b2', title: 'Remote auch neuer', updatedAt: 300, pages: [{ id: 'p' }] };
    fetchHandler = async (url, opts) => {
      const m = (opts.method || 'GET').toUpperCase();
      if (m === 'PROPFIND') return propfind(['x__b1.json', 'x__b2.json']);
      if (url.endsWith('x__b1.json')) return okJson(remote1);
      if (url.endsWith('x__b2.json')) return okJson(remote2);
      return { ok: true, status: 200, statusText: 'OK', text: async () => '', json: async () => ({}) };
    };
    const r = await Cloud.pullAll();
    assert.deepEqual(r.updated, ['Remote neuer']);
    assert.deepEqual(r.conflicts, ['Remote auch neuer']);
    // b1 ersetzt, b2 lokal erhalten + Konfliktkopie
    const b1 = global.window.state.books.find((b) => b.id === 'b1');
    assert.equal(b1.title, 'Remote neuer');
    const b2 = global.window.state.books.find((b) => b.id === 'b2');
    assert.equal(b2.title, 'Lokal geändert');
    assert.ok(global.window.state.books.some((b) => /Cloud-Konflikt/.test(b.title)));
  });

  it('deleteRemoteBookById schickt DELETE + vergisst Map-Eintrag', async () => {
    saveMap({ b9: { file: 'Titel__b9.json', lastSyncLocal: 1 } });
    fetchHandler = async () => ({ ok: true, status: 204, statusText: 'No Content', text: async () => '' });
    await Cloud.deleteRemoteBookById('b9');
    assert.ok(fetchCalls.some((c) => c.method === 'DELETE' && /Titel__b9\.json$/.test(c.url)));
    assert.ok(!loadMap().b9);
  });

  it('deleteRemoteBookById ohne Konfiguration löscht nur Map (kein Fetch-Crash)', async () => {
    Cloud.saveConfig({ baseUrl: '', username: '', password: '', folder: 'Grimoire' });
    saveMap({ b9: { file: 'Titel__b9.json' } });
    await Cloud.deleteRemoteBookById('b9');
    assert.ok(!loadMap().b9);
  });
});
