/* Office DocStore -- Dokumentlogik ueber Adapter + Tresor.
 *
 * Hier steht alles, was unabhaengig vom konkreten Backend gilt: Klartext
 * verlaesst diese Schicht nie unverschluesselt gespeichert zu werden, und
 * Konflikte werden als Konflikt (nicht als Exception im Aufrufer) gemeldet.
 *
 * Der Tresor (Passphrase) gehoert pro Dokument dazu: Jedes Dokument hat einen
 * eigenen DEK, ist aber mit demselben KEK gewickelt. Deshalb muss eine
 * geoeffnete Sitzung den Tresor kennen -- der Adapter sieht nur Envelopes.
 */
(function () {
  'use strict';

  function newId() {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(9));
    return 'd' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const KINDS = ['docx', 'xlsx', 'pptx', 'csv', 'pdf', 'odt', 'ods', 'odp', 'rtf', 'txt'];

  function kindOf(fileName) {
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    return KINDS.includes(ext) ? ext : 'docx';
  }

  function createDocStore(options) {
    const opts = options || {};
    const adapter = opts.adapter;
    const vault = opts.vault;
    if (!adapter) throw new TypeError('createDocStore: adapter fehlt.');
    if (!vault) throw new TypeError('createDocStore: vault fehlt.');

    return {
      adapter,

      list: () => adapter.listDocuments(),

      async create(input) {
        const title = (input && input.title) || 'Unbenannt';
        const kind = (input && input.kind) || kindOf(title);
        const id = (input && input.id) || newId();
        await adapter.createDocument({ id, title, kind });
        return { id, title, kind };
      },

      async importFile(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const id = newId();
        await adapter.createDocument({ id, title: file.name, kind: kindOf(file.name) });
        // Beim Import gibt es noch keinen fremden Stand -> kein ifMatch noetig.
        const written = await adapter.writeDocument(id, await vault.seal(bytes), {});
        return { id, title: file.name, kind: kindOf(file.name), ...written };
      },

      async open(id) {
        const doc = await adapter.readDocument(id);
        const bytes = doc.envelope ? await vault.open(doc.envelope) : new Uint8Array(0);
        return {
          id: doc.id, title: doc.title, kind: doc.kind,
          etag: doc.etag, version: doc.version, updatedAt: doc.updatedAt,
          lockedBy: doc.lockedBy, bytes,
        };
      },

      /* Speichern mit Konflikterkennung.
       * Rueckgabe: { ok: true, ... } oder { ok: false, reason: 'conflict',
       * expected, actual } -- bewusst kein Wurf: die UI soll den Konflikt zeigen
       * und Optionen anbieten (neu laden / als Kopie speichern), nicht crashen. */
      async save(id, bytes, options) {
        const opts = options || {};
        const envelope = await vault.seal(bytes);
        try {
          const written = await adapter.writeDocument(id, envelope, { ifMatch: opts.ifMatch });
          return { ok: true, ...written };
        } catch (e) {
          if (e && e.code === 'CONFLICT') {
            return { ok: false, reason: 'conflict', expected: e.expected, actual: e.actual };
          }
          throw e;
        }
      },

      // Konflikt aufloesen, indem die lokale Fassung als eigene Version landet.
      async saveAsCopy(id, bytes) {
        const written = await adapter.writeDocument(id, await vault.seal(bytes), {});
        return { ok: true, ...written };
      },

      history: (id) => adapter.listVersions(id),

      async restore(id, version) {
        const written = await adapter.restoreVersion(id, version);
        return { ok: true, ...written };
      },

      remove: (id) => adapter.deleteDocument(id),
      lock: (id, holder, ttlMs) => adapter.acquireLock(id, holder, ttlMs),
      unlock: (id, holder) => adapter.releaseLock(id, holder),

      async unlockAll() {
        const docs = await adapter.listDocuments();
        return Promise.all(docs.map((d) => adapter.releaseLock(d.id, opts.holder || 'local')));
      },
    };
  }

  const DocStore = { createDocStore, newId, kindOf, KINDS };

  if (typeof window !== 'undefined') window.OfficeDocStore = DocStore;
  if (typeof module !== 'undefined' && module.exports) module.exports = DocStore;
})();
