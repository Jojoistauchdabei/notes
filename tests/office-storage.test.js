'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Kv = require('../office/js/kv.js');
const Storage = require('../office/js/storage-adapter.js');
const DocStore = require('../office/js/docstore.js');
const Crypto = require('../office/js/crypto.js');

const FAST = { iterations: 1000 };

function backend() {
  return Storage.assertAdapter(Storage.createLocalBackend(Kv.createMemoryKv()));
}

describe('office/storage-adapter', () => {
  it('lokales Backend erfuellt den Vertrag', () => {
    assert.doesNotThrow(() => backend());
  });

  it('unvollstaendige Backends werden beim Binden abgelehnt', () => {
    assert.throws(() => Storage.assertAdapter({ listDocuments() {} }), /unvollstaendig/);
    assert.throws(() => Storage.assertAdapter(null), /unvollstaendig/);
  });

  it('create/list/read Dokument-Lebenszyklus', async () => {
    const a = backend();
    const created = await a.createDocument({ id: 'x1', title: 'Bericht', kind: 'docx' });
    assert.equal(created.version, 0);
    const list = await a.listDocuments();
    assert.equal(list.length, 1);
    assert.equal(list[0].title, 'Bericht');
    const doc = await a.readDocument('x1');
    assert.equal(doc.version, 0);
    assert.equal(doc.envelope, null, 'unbeschriebenes Dokument hat kein Envelope');
  });

  it('write erzeugt aufsteigende Versionen mit eigenem etag', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    const v1 = await a.writeDocument('x1', { body: 'eins' }, {});
    const v2 = await a.writeDocument('x1', { body: 'zwei' }, {});
    assert.equal(v1.version, 1);
    assert.equal(v2.version, 2);
    assert.notEqual(v1.etag, v2.etag);
    assert.deepEqual((await a.listVersions('x1')).map((v) => v.version), [2, 1]);
  });

  it('gleicher Inhalt ergibt denselben etag (Inhalts-Hash, keine Uhr)', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    const v1 = await a.writeDocument('x1', { body: 'gleich' }, {});
    const v2 = await a.writeDocument('x1', { body: 'gleich' }, {});
    assert.equal(v1.etag, v2.etag, 'etag muss inhaltsbasiert sein');
  });

  it('optimistisches Locking: veralteter ifMatch erzeugt ConflictError', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    const first = await a.writeDocument('x1', { body: 'a' }, {});
    await a.writeDocument('x1', { body: 'b' }, {}); // jemand anderes schreibt
    await assert.rejects(
      () => a.writeDocument('x1', { body: 'c' }, { ifMatch: first.etag }),
      (e) => e.code === 'CONFLICT' && e.expected === first.etag && e.actual != null,
    );
  });

  it('aktueller ifMatch schreibt durch', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    const first = await a.writeDocument('x1', { body: 'a' }, {});
    const second = await a.writeDocument('x1', { body: 'b' }, { ifMatch: first.etag });
    assert.equal(second.version, 2);
  });

  it('restoreVersion legt eine neue Version an statt ueberschreiben', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    await a.writeDocument('x1', { body: 'v1' }, {});
    const second = await a.writeDocument('x1', { body: 'v2' }, {});
    const restored = await a.restoreVersion('x1', 1);
    assert.equal(restored.version, 3, 'Wiederherstellen ist ein neuer Stand, kein Rewrite');
    assert.equal((await a.readVersion('x1', 1)).envelope.body, 'v1');
    assert.ok(second.etag !== restored.etag);
  });

  it('weiche Sperre blockiert den anderen, nicht den selben Halter', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    const first = await a.acquireLock('x1', 'jonas', 60000);
    assert.equal(first.holder, 'jonas');
    assert.equal(await a.acquireLock('x1', 'mira', 60000), null);
    const again = await a.acquireLock('x1', 'jonas', 60000);
    assert.equal(again.acquiredAt, first.acquiredAt, 'eigene Sperre wird nicht neu vergeben');
    assert.equal(await a.releaseLock('x1', 'mira'), false);
    assert.equal(await a.releaseLock('x1', 'jonas'), true);
    assert.ok(await a.acquireLock('x1', 'mira', 60000));
  });

  it('abgelaufene Sperre wird ignoriert', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    await a.acquireLock('x1', 'jonas', -1);
    assert.ok(await a.acquireLock('x1', 'mira', 60000), 'abgelaufene Sperre darf nicht blockieren');
    assert.equal((await a.listDocuments())[0].lockedBy, 'mira');
  });

  it('delete nimmt das Dokument aus der Liste und raeumt Versionen ab', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    await a.writeDocument('x1', { body: 'a' }, {});
    assert.equal(await a.deleteDocument('x1'), true);
    assert.deepEqual(await a.listDocuments(), []);
    await assert.rejects(() => a.readDocument('x1'), /nicht gefunden/);
    await assert.rejects(() => a.writeDocument('x1', { body: 'b' }, {}), /nicht gefunden/);
  });

  it('create auf vorhandene id scheitert, nach delete nicht mehr', async () => {
    const a = backend();
    await a.createDocument({ id: 'x1', title: 'T' });
    await assert.rejects(() => a.createDocument({ id: 'x1', title: 'T' }), /existiert bereits/);
    await a.deleteDocument('x1');
    await assert.doesNotReject(() => a.createDocument({ id: 'x1', title: 'neu' }));
  });
});

describe('office/docstore', () => {
  function store() {
    return DocStore.createDocStore({ adapter: backend(), vault: Crypto.createVault('pw', FAST) });
  }

  it('create/open/save mit Verschluesselung', async () => {
    const s = store();
    const doc = await s.create({ title: 'Bericht.docx', kind: 'docx' });
    const opened = await s.open(doc.id);
    assert.equal(opened.bytes.length, 0);

    const written = await s.save(doc.id, new Uint8Array([1, 2, 3]));
    assert.equal(written.ok, true);
    assert.equal(written.version, 1);

    const again = await s.open(doc.id);
    assert.deepEqual([...again.bytes], [1, 2, 3]);
  });

  it('das Backend sieht nur Chiffretext, nie den Klartext', async () => {
    const kv = Kv.createMemoryKv();
    const s = DocStore.createDocStore({
      adapter: Storage.createLocalBackend(kv), vault: Crypto.createVault('pw', FAST),
    });
    const doc = await s.create({ title: 'Geheim.docx' });
    await s.save(doc.id, new TextEncoder().encode('STRENG GEHEIM'));

    const raw = await kv.get('ver:' + doc.id + ':00000001');
    const serialized = JSON.stringify(raw);
    assert.ok(!serialized.includes('STRENG GEHEIM'), 'Klartext darf nirgends im KV liegen');
    assert.ok(serialized.includes('ciphertext'));
  });

  it('Konflikt wird als Ergebnis gemeldet, nicht geworfen', async () => {
    const s = store();
    const doc = await s.create({ title: 'T' });
    const opened = await s.open(doc.id);
    await s.save(doc.id, new Uint8Array([1]), { ifMatch: opened.etag });
    // Zweiter Bearbeiter auf altem Stand:
    const conflict = await s.save(doc.id, new Uint8Array([2]), { ifMatch: opened.etag });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, 'conflict');
    assert.ok(conflict.actual, 'der aktuelle Serverstand wird fuer die Aufloesung gemeldet');
  });

  it('saveAsCopy loest den Konflikt, ohne den fremden Stand zu verlieren', async () => {
    const s = store();
    const doc = await s.create({ title: 'T' });
    const base = await s.open(doc.id);
    await s.save(doc.id, new Uint8Array([1]), { ifMatch: base.etag });
    const copy = await s.saveAsCopy(doc.id, new Uint8Array([2]));
    assert.equal(copy.ok, true);
    // Ein abgelehnter Schreibversuch legt keine Version an: v1 = Bearbeiter A,
    // v2 = Kopie von Bearbeiter B. v1 bleibt unangetastet.
    assert.equal(copy.version, 2);
    assert.deepEqual((await s.history(doc.id)).map((v) => v.version), [2, 1]);
    assert.deepEqual([...await s.open(doc.id).then((d) => d.bytes)], [2]);
  });

  it('restore holt einen alten Stand als neuen zurueck', async () => {
    const s = store();
    const doc = await s.create({ title: 'T' });
    await s.save(doc.id, new Uint8Array([1]));
    await s.save(doc.id, new Uint8Array([2]));
    const restored = await s.restore(doc.id, 1);
    assert.equal(restored.ok, true);
    assert.deepEqual([...await s.open(doc.id).then((d) => d.bytes)], [1]);
  });

  it('history ist neueste zuerst', async () => {
    const s = store();
    const doc = await s.create({ title: 'T' });
    await s.save(doc.id, new Uint8Array([1]));
    await s.save(doc.id, new Uint8Array([2]));
    await s.save(doc.id, new Uint8Array([3]));
    assert.deepEqual((await s.history(doc.id)).map((v) => v.version), [3, 2, 1]);
  });

  it('createDocStore verlangt Adapter und Tresor', () => {
    assert.throws(() => DocStore.createDocStore({}), /adapter fehlt/);
    assert.throws(() => DocStore.createDocStore({ adapter: backend() }), /vault fehlt/);
  });

  it('kindOf erkennt Endungen, faellt auf docx zurueck', () => {
    assert.equal(DocStore.kindOf('a.XLSX'), 'xlsx');
    assert.equal(DocStore.kindOf('b.pptx'), 'pptx');
    assert.equal(DocStore.kindOf('c.ods'), 'ods');
    assert.equal(DocStore.kindOf('unbekannt.xyz'), 'docx');
    assert.equal(DocStore.kindOf(undefined), 'docx');
  });
});
