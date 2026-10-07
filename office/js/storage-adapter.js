/* Office Storage Adapter -- austauschbare Persistenz + Versionen + Sperren.
 *
 * Das ist die Naht, an der spaeter die Datenbank gewechselt wird: alles ueber
 * dem Adapter (docstore, editor, UI) kennt nur diese Methoden. Ein
 * selbstgehostetes Backend ist eine weitere Implementierung desselben
 * Vertrags; der Rest des Codes bleibt unangetastet.
 *
 * Vertrag (async):
 *   listDocuments()                 -> [{ id, title, kind, updatedAt, etag, version, size, lockedBy }]
 *   createDocument({id,title,kind})-> { etag, version }
 *   readDocument(id)                -> { id, title, kind, updatedAt, etag, version, envelope }
 *   writeDocument(id, envelope, { ifMatch }) -> { etag, version }
 *                                        wirft ConflictError, wenn ifMatch veraltet ist
 *   listVersions(id)                -> [{ version, etag, createdAt, size }]
 *   readVersion(id, version)        -> { envelope, etag, createdAt, size }
 *   restoreVersion(id, version)     -> { etag, version }  (legt eine neue Version an)
 *   deleteDocument(id)              -> true
 *   acquireLock(id, holder, ttlMs)  -> { holder, acquiredAt, expiresAt } | null
 *   releaseLock(id, holder)         -> true
 *
 * Optimistisches Locking statt Sperr-DBMS: gelesene Version merkt sich ihren
 * etag; beim Schreiben muss er mitgeschickt werden. Stimmt er nicht mehr, hat
 * jemand zwischenzeitlich geschrieben -> ConflictError statt stiller
 * Ueberschreibung. Weiche Sperren (Locks) sind nur ein Hinweis fuer die UI
 * ("Jonas editiert gerade"), keine correctness-Garantie.
 */
(function () {
  'use strict';

  const LOCK_PREFIX = 'lock:';
  const DOC_PREFIX = 'doc:';
  const VER_PREFIX = 'ver:';

  class ConflictError extends Error {
    constructor(id, expected, actual) {
      super('Konflikt bei Dokument ' + id + ': erwarteter Stand ' + expected + ', gespeicherter Stand ' + actual + '.');
      this.name = 'ConflictError';
      this.code = 'CONFLICT';
      this.id = id;
      this.expected = expected;
      this.actual = actual;
    }
  }

  function docKey(id) { return DOC_PREFIX + id; }
  function verKey(id, n) { return VER_PREFIX + id + ':' + String(n).padStart(8, '0'); }
  function lockKey(id) { return LOCK_PREFIX + id; }

  // etag ist ein Inhalts-Hash: gleiche Bytes -> gleicher etag. Damit ist der
  // etag stabil ueber Backends hinweg und ohne Server-Uhr vergleichbar.
  async function etagOf(envelope) {
    const bytes = new TextEncoder().encode(typeof envelope === 'string' ? envelope : JSON.stringify(envelope));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function sizeOf(envelope) {
    const s = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
    return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
  }

  function lockExpired(lock, now) {
    return !lock || (lock.expiresAt != null && lock.expiresAt <= now);
  }

  /* Lokales Backend ueber einen KV-Treiber (siehe kv.js). */
  function createLocalBackend(kv) {
    const now = () => Date.now();

    return {
      name: 'local',
      driver: kv.driver,

      async listDocuments() {
        const keys = await kv.keys(DOC_PREFIX);
        const out = [];
        for (const k of keys) {
          const doc = await kv.get(k);
          if (!doc || doc.deleted) continue;
          const lock = await kv.get(lockKey(doc.id));
          out.push({
            id: doc.id,
            title: doc.title,
            kind: doc.kind,
            updatedAt: doc.updatedAt,
            etag: doc.etag,
            version: doc.version,
            size: doc.size,
            lockedBy: lockExpired(lock, now()) ? null : lock.holder,
          });
        }
        return out.sort((a, b) => b.updatedAt - a.updatedAt);
      },

      async createDocument({ id, title, kind }) {
        if (!id) throw new TypeError('createDocument: id fehlt.');
        const existing = await kv.get(docKey(id));
        if (existing && !existing.deleted) throw new Error('Dokument existiert bereits: ' + id);
        const t = now();
        const doc = {
          id, title: title || 'Unbenannt', kind: kind || 'docx',
          createdAt: t, updatedAt: t, version: 0, etag: null, size: 0, deleted: false,
        };
        await kv.set(docKey(id), doc);
        return { etag: doc.etag, version: doc.version };
      },

      async readDocument(id) {
        const doc = await kv.get(docKey(id));
        if (!doc || doc.deleted) throw new Error('Dokument nicht gefunden: ' + id);
        // Version 0 = angelegt, aber noch nie geschrieben.
        const envelope = doc.version === 0 ? null : (await kv.get(verKey(id, doc.version)));
        const lock = await kv.get(lockKey(id));
        return {
          ...doc,
          envelope: envelope ? envelope.envelope : null,
          createdAtVersion: envelope ? envelope.createdAt : doc.createdAt,
          lockedBy: lockExpired(lock, now()) ? null : lock.holder,
        };
      },

      async writeDocument(id, envelope, options) {
        const opts = options || {};
        const doc = await kv.get(docKey(id));
        if (!doc || doc.deleted) throw new Error('Dokument nicht gefunden: ' + id);
        // Der Kern des optimistic locking: nur schreiben, wenn der Stand, auf
        // dem der Aufrufer aufgebaut hat, noch der gespeicherte ist.
        // 'undefined' = ohne Vorbedingung. 'null' ist dagegen eine echte
        // Vorbedingung ("erwarte, dass noch nie geschrieben wurde") -- sonst
        // koennte ein frisch angelegtes Dokument nie einen Konflikt melden.
        if (opts.ifMatch !== undefined && (doc.etag || null) !== (opts.ifMatch || null)) {
          throw new ConflictError(id, opts.ifMatch, doc.etag);
        }
        const etag = await etagOf(envelope);
        const version = doc.version + 1;
        const t = now();
        await kv.set(verKey(id, version), {
          envelope, etag, createdAt: t, size: sizeOf(envelope), version,
        });
        await kv.set(docKey(id), {
          ...doc, etag, version, updatedAt: t, size: sizeOf(envelope),
        });
        return { etag, version };
      },

      async listVersions(id) {
        const keys = await kv.keys(VER_PREFIX + id + ':');
        const out = [];
        for (const k of keys) {
          const v = await kv.get(k);
          if (v) out.push({ version: v.version, etag: v.etag, createdAt: v.createdAt, size: v.size });
        }
        return out.sort((a, b) => b.version - a.version);
      },

      async readVersion(id, version) {
        const v = await kv.get(verKey(id, version));
        if (!v) throw new Error('Version nicht gefunden: ' + id + '@' + version);
        return v;
      },

      async restoreVersion(id, version) {
        const v = await this.readVersion(id, version);
        const doc = await kv.get(docKey(id));
        if (!doc || doc.deleted) throw new Error('Dokument nicht gefunden: ' + id);
        return this.writeDocument(id, v.envelope, { ifMatch: doc.etag });
      },

      async deleteDocument(id) {
        await kv.set(docKey(id), { ...(await kv.get(docKey(id)) || { id }), id, deleted: true });
        await kv.clear(VER_PREFIX + id + ':');
        await kv.delete(lockKey(id));
        return true;
      },

      // Weiche Sperre mit Ablauf: ein abgestuerzter Tab gibt sie automatisch frei.
      async acquireLock(id, holder, ttlMs) {
        const t = now();
        const lock = await kv.get(lockKey(id));
        if (!lockExpired(lock, t) && lock.holder !== holder) return null;
        const next = {
          holder,
          acquiredAt: lock && lock.holder === holder ? lock.acquiredAt : t,
          expiresAt: t + (ttlMs || 120000),
        };
        await kv.set(lockKey(id), next);
        return next;
      },

      async releaseLock(id, holder) {
        const lock = await kv.get(lockKey(id));
        if (lock && lock.holder !== holder) return false;
        await kv.delete(lockKey(id));
        return true;
      },
    };
  }

  // Vertragspruefung: faengt Tippfehler in neuen Backends, bevor die UI es merkt.
  const REQUIRED = [
    'listDocuments', 'createDocument', 'readDocument', 'writeDocument',
    'listVersions', 'readVersion', 'restoreVersion', 'deleteDocument',
    'acquireLock', 'releaseLock',
  ];

  function assertAdapter(adapter) {
    const missing = REQUIRED.filter((m) => typeof adapter?.[m] !== 'function');
    if (missing.length) throw new TypeError('Storage-Adapter unvollstaendig: ' + missing.join(', '));
    return adapter;
  }

  const StorageAdapter = { createLocalBackend, assertAdapter, ConflictError, REQUIRED, etagOf };

  if (typeof window !== 'undefined') window.OfficeStorage = StorageAdapter;
  if (typeof module !== 'undefined' && module.exports) module.exports = StorageAdapter;
})();
