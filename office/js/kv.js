/* Office KV -- kleinster gemeinsamer Key-Value-Speicher.
 *
 * Bewusst zweigeteilt: IndexedDB ist der Browser-Persistenzträger, der
 * Memory-KV der Test- und Fallback-Treiber. Die Logik darueber
 * (storage-adapter.js) ist dadurch ohne Browser und ohne Dependency testbar --
 * das Repo hat keine node_modules, und IndexedDB laesst sich in Node nicht
 * sinnvoll nachbauen.
 *
 * Schluessel = "doc:<id>" (Metadaten), "ver:<id>:<n>" (Version),
 *              "lock:<id>" (weiche Sperre).
 */
(function () {
  'use strict';

  // In-Memory-Treiber: Map + Clone. Fuer Tests und Browser ohne IndexedDB.
  function createMemoryKv(seed) {
    const map = new Map();
    if (seed) for (const [k, v] of Object.entries(seed)) map.set(k, v);
    return {
      driver: 'memory',
      async get(key) {
        if (!map.has(key)) return null;
        return structuredClone(map.get(key));
      },
      async set(key, value) { map.set(key, structuredClone(value)); return value; },
      async delete(key) { return map.delete(key); },
      async keys(prefix) {
        return [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
      },
      async clear(prefix) {
        for (const k of [...map.keys()]) {
          if (k.startsWith(prefix)) map.delete(k);
        }
      },
    };
  }

  // IndexedDB-Treiber: ein Object-Store "kv" je Datenbank.
  function createIndexedDbKv(dbName, storeName) {
    const DB = dbName || 'office-db';
    const STORE = storeName || 'kv';
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
          reject(new Error('IndexedDB nicht verfuegbar.'));
          return;
        }
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB oeffnen fehlgeschlagen.'));
      });
      return dbPromise;
    }

    function tx(mode, run) {
      return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let result;
        try { result = run(t.objectStore(STORE)); } catch (e) { reject(e); return; }
        t.oncomplete = () => {
          // run() liefert entweder eine IDBRequest (dann ist .result das Ergebnis)
          // oder direkt den Wert (set/clear). 'result' in ... unterscheidet beides.
          // Wichtig bei get(): fehlt der Schluessel, ist .result undefined -- ohne
          // diese Unterscheidung wuerde das Request-Objekt zurueckkommen und wie
          // ein existierender Eintrag aussehen.
          const isRequest = result != null && typeof result === 'object' && 'result' in result;
          resolve(isRequest ? result.result : result);
        };
        t.onerror = () => reject(t.error || new Error('IndexedDB-Transaktion fehlgeschlagen.'));
        t.onabort = () => reject(t.error || new Error('IndexedDB-Transaktion abgebrochen.'));
      }));
    }

    return {
      driver: 'indexeddb',
      get: (key) => tx('readonly', (s) => s.get(key)),
      set: (key, value) => tx('readwrite', (s) => { s.put(value, key); return value; }),
      delete: (key) => tx('readwrite', (s) => { s.delete(key); return true; }),
      keys: (prefix) => tx('readonly', (s) => s.getAllKeys())
        .then((all) => (all || []).filter((k) => String(k).startsWith(prefix)).sort()),
      clear: (prefix) => tx('readwrite', (s) => {
        s.openCursor().onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur) return;
          if (String(cur.key).startsWith(prefix)) cur.delete();
          cur.continue();
        };
        return true;
      }),
    };
  }

  const Kv = { createMemoryKv, createIndexedDbKv };

  if (typeof window !== 'undefined') window.OfficeKv = Kv;
  if (typeof module !== 'undefined' && module.exports) module.exports = Kv;
})();
