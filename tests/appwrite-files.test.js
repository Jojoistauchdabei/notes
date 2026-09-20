'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'appwrite-files.js'), 'utf8');
const F = require('../js/appwrite-files.js');

const H1 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'; // sha256('abc')
const H2 = 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'; // sha256('a')

describe('appwrite-files/datei', () => {
  it('ist ohne DOM ladbar und degradiert ohne Browser sauber', () => {
    assert.ok(F && typeof F.planFileSync === 'function');
    // Kein localStorage in Node -> Fallbacks statt Crash
    assert.deepEqual(F.loadMap(), {});
    assert.deepEqual(F.loadQueue(), []);
    assert.equal(F.loadConfig().bucketId, 'attachments');
    // optimizeImage ohne Canvas gibt Original zurück (kein Crash)
    return F.optimizeImage(new Uint8Array([1, 2, 3]), 'image/jpeg').then(out => {
      assert.equal(out.optimized, false);
      assert.deepEqual(Array.from(out.bytes), [1, 2, 3]);
    });
  });
  it('exportiert die vereinbarte API', () => {
    for (const k of ['loadConfig', 'saveConfig', 'loadMap', 'saveMap',
      'loadSession', 'saveSession', 'clearSession', 'authHeaders',
      'normalizeMime', 'extForMime', 'fileIdForHash', 'hashFromFileId', 'sha256Hex',
      'dataUrlToBytes', 'pickTarget', 'planFileSync', 'findOrphans',
      'storageReport', 'queueAdd', 'queueNext', 'collectLocalEntries',
      'syncNow', 'cleanupOrphans', 'session']) {
      assert.equal(typeof F[k], 'function', k);
    }
    assert.equal(F.DEFAULTS.databaseId, 'federwerk');
    assert.equal(F.DEFAULTS.bucketId, 'attachments');
  });
});

describe('appwrite-files/mime', () => {
  it('normalisiert und mappt Endungen', () => {
    assert.equal(F.normalizeMime('image/JPG;foo=1'), 'image/jpeg');
    assert.equal(F.extForMime('image/jpeg'), 'jpg');
    assert.equal(F.extForMime('image/png'), 'png');
    assert.equal(F.extForMime('application/pdf'), 'pdf');
    assert.equal(F.extForMime('application/json'), 'json');
    assert.equal(F.extForMime('image/gif'), 'gif');
    assert.equal(F.extForMime('x/y'), 'bin');
  });
});

describe('appwrite-files/ids', () => {
  it('fileId ist stabil, kurz und rundetrip-fähig', () => {
    const fid = F.fileIdForHash(H1);
    assert.match(fid, /^fw[0-9a-f]{32}$/);
    assert.equal(fid.length, 34);
    assert.equal(F.hashFromFileId(fid), H1.slice(0, 32));
  });
  it('fremde IDs werden ignoriert, kurze Hashes abgelehnt', () => {
    assert.equal(F.hashFromFileId('anderes-bild'), null);
    assert.equal(F.hashFromFileId(null), null);
    assert.throws(() => F.fileIdForHash('abc'), /zu kurz/);
  });
  it('sha256 stimmt (Vektor)', async () => {
    assert.equal(await F.sha256Hex(new TextEncoder().encode('abc')), H1);
  });
  it('dataUrl roundtrip', () => {
    const bytes = new TextEncoder().encode('abc');
    const du = 'data:image/jpeg;base64,' + F.bytesToBase64(bytes);
    const out = F.dataUrlToBytes(du);
    assert.equal(out.mime, 'image/jpeg');
    assert.deepEqual(Array.from(out.bytes), [97, 98, 99]);
  });
});

describe('appwrite-files/pickTarget', () => {
  it('große Bilder -> recompress, PDF/GIF -> keep', () => {
    assert.equal(F.pickTarget('image/jpeg', 500 * 1024).recompress, true);
    assert.equal(F.pickTarget('image/jpeg', 10 * 1024).recompress, false);
    assert.equal(F.pickTarget('application/pdf', 5 * 1024 * 1024).recompress, false);
    assert.equal(F.pickTarget('image/gif', 5 * 1024 * 1024).recompress, false);
  });
});

describe('appwrite-files/plan', () => {
  const FID1 = F.fileIdForHash(H1);
  it('teilt in upload/download/upToDate', () => {
    const local = { [H1]: { size: 10 }, [H2]: { size: 20 } };
    const remote = { [FID1]: { size: 10 } };
    const p = F.planFileSync(local, remote);
    assert.deepEqual(p.upToDate, [H1]);
    assert.deepEqual(p.upload, [H2]);
    assert.deepEqual(p.download, []);
  });
  it('remote-Extras sind Download-Kandidaten', () => {
    const fid2 = F.fileIdForHash(H2);
    const p = F.planFileSync({}, { [fid2]: { size: 5 } });
    assert.deepEqual(p.download, [fid2]);
  });
  it('defensive Eingaben crashen nicht', () => {
    assert.deepEqual(F.planFileSync(null, null), { upload: [], download: [], upToDate: [], remoteExtra: [] });
  });
});

describe('appwrite-files/orphans', () => {
  it('findet nur fw-Dateien ohne Referenz', () => {
    const fid1 = F.fileIdForHash(H1), fid2 = F.fileIdForHash(H2);
    assert.deepEqual(F.findOrphans([H1], [fid1, fid2]), [fid2]);
    assert.deepEqual(F.findOrphans([H1], [fid1, fid2, 'fremd-123']), [fid2]);
    assert.deepEqual(F.findOrphans([], []), []);
  });
});

describe('appwrite-files/report', () => {
  it('zählt Bytes und Differenzen', () => {
    const fid1 = F.fileIdForHash(H1);
    const r = F.storageReport({ [H1]: { size: 100 }, [H2]: { size: 50 } }, { [fid1]: { size: 100 } });
    assert.equal(r.localCount, 2);
    assert.equal(r.localBytes, 150);
    assert.equal(r.remoteBytes, 100);
    assert.equal(r.missingUpload, 1);
    assert.equal(r.upToDate, 1);
  });
});

describe('appwrite-files/queue', () => {
  it('dedupliziert und liefert FIFO', () => {
    let q = F.queueAdd([], { hash: H1, ref: 'blob:x' });
    q = F.queueAdd(q, { hash: H1, ref: 'blob:x' });
    assert.equal(q.length, 1);
    q = F.queueAdd(q, { hash: H2, ref: 'blob:y' });
    const { item, rest } = F.queueNext(q);
    assert.equal(item.hash, H1);
    assert.equal(rest.length, 1);
    assert.equal(F.queueNext([]).item, null);
  });
});

describe('appwrite-files/collect', () => {
  it('sammelt Hashes aus Büchern (dataURL, ohne Store)', async () => {
    const du = 'data:image/jpeg;base64,' + F.bytesToBase64(new TextEncoder().encode('abc'));
    const books = [{ pages: [{ images: [{ src: du }], bg: du }] }];
    const entries = await F.collectLocalEntries(books, null);
    assert.ok(entries[H1]);
    assert.equal(entries[H1].size, 3);
  });
  it('defekte Refs werden übersprungen', async () => {
    const entries = await F.collectLocalEntries([{ pages: [{ images: [{ src: 'kaputt' }] }] }], null);
    assert.deepEqual(entries, {});
  });
});

describe('appwrite-files/session', () => {
  const mem = new Map();
  const backend = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: k => { mem.delete(k); },
  };
  it('Secret-Roundtrip + Header-Bau (Tauri-Fix)', () => {
    F._internals._setLsBackend(backend);
    try {
      mem.clear();
      assert.equal(F.loadSession(), null);
      assert.deepEqual(F.authHeaders({ projectId: 'p' }), { 'X-Appwrite-Project': 'p' });
      F.saveSession({ secret: 's3cr3t', userId: 'u1', at: 'x' });
      assert.equal(F.loadSession().secret, 's3cr3t');
      assert.equal(F.authHeaders({ projectId: 'p' })['X-Appwrite-Session'], 's3cr3t');
      F.clearSession();
      assert.equal(F.loadSession(), null);
    } finally {
      F._internals._resetLs();
    }
  });
});

describe('appwrite-files/config-ls', () => {
  it('Map/Config-Roundtrip über injizierten Speicher', () => {
    const mem = new Map();
    F._internals._setLsBackend({
      getItem: k => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
    });
    try {
      F.saveMap({ [H1]: { fileId: 'fw1', mime: 'image/jpeg', size: 3 } });
      assert.equal(F.loadMap()[H1].fileId, 'fw1');
      const cfg = F.saveConfig({ bucketId: 'test-bucket' });
      assert.equal(cfg.bucketId, 'test-bucket');
      assert.equal(F.loadConfig().databaseId, 'federwerk');
    } finally {
      F._internals._resetLs();
    }
  });
});
