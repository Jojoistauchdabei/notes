/* Office Editor Adapter -- ONLYOFFICE-WASM-Editor als iframe einbinden.
 *
 * Protokoll (siehe docs/embed-api.md des Editors): Nachrichten sind
 * { id, type, payload } mit dem Praefix "document:".
 *   -> open-buffer { buffer, fileName, readonly }   Bytes aus dem Tresor
 *   -> save { targetExt }   <- saved { file, fileName }
 *   -> set-readonly / get-state
 *
 * Wichtig: open-buffer statt open-url. Unsere Dokumente liegen verschluesselt
 * lokal, es gibt keine CORS-faehige URL -- und laut Doku ist open-url genau
 * daran am haeufigsten gescheitert. Der Eltern-Teil holt also die Bytes selbst
 * und reicht sie weiter, wie es die Doku fuer geschuetzte Dateien empfiehlt.
 *
 * Ausserdem: niemals auf file.size pruefen, ob sich etwas geaendert hat. Ein
 * XLSX ist ein ZIP -- eine Kleinigkeit im Dokument kann exakt gleiche
 * Bytezahlen ergeben. Deshalb wird hier gegoenert.
 */
(function () {
  'use strict';

  const PREFIX = 'document:';
  const DEFAULT_TIMEOUT = 120000;

  function isBuffer(v) {
    return v instanceof ArrayBuffer || ArrayBuffer.isView(v);
  }

  /* Nachrichten des Editors annehmen -- extrahierbar und ohne DOM testbar.
   * Sicherheitsregeln: passender Origin, Praefix "document:", eigenes Fenster. */
  function makeMessageFilter(editorOrigin, targetWindow) {
    return function filter(event) {
      if (editorOrigin && event.origin !== editorOrigin) return null;
      if (targetWindow && event.source !== targetWindow) return null;
      const data = event.data;
      if (!data || typeof data !== 'object') return null;
      if (typeof data.type !== 'string' || !data.type.startsWith(PREFIX)) return null;
      return { id: data.id || null, type: data.type, payload: data.payload || {} };
    };
  }

  function createEditorAdapter(options) {
    const opts = options || {};
    const frame = opts.frame;
    // Operator-Konfiguration: Leerzeichen abschneiden und als URL pruefen, damit
    // ein Tippfehler eine lesbare Meldung bekommt statt eines URL-Fehlers
    // mitten im first paint.
    const editorBase = String(opts.editorBase || '').trim().replace(/\/+$/, '');
    if (!frame) throw new TypeError('createEditorAdapter: frame fehlt.');
    if (!editorBase) throw new TypeError('createEditorAdapter: editorBase fehlt (Konfiguration noetig).');
    let editorUrl;
    try {
      editorUrl = new URL(editorBase);
    } catch {
      throw new TypeError('createEditorAdapter: editorBase ist keine gueltige URL: ' + editorBase);
    }
    if (editorUrl.protocol !== 'http:' && editorUrl.protocol !== 'https:') {
      throw new TypeError('createEditorAdapter: editorBase muss http(s) sein.');
    }

    const editorOrigin = new URL(editorBase).origin;
    const parentOrigin = opts.parentOrigin
      || (typeof location !== 'undefined' ? location.origin : editorOrigin);
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT;
    // window ist injizierbar: im Browser das globale, im Test eine Attrappe --
    // sonst waere der Nachrichtenweg gar nicht testbar.
    const win = opts.win || (typeof window !== 'undefined' ? window : null);

    let seq = 0;
    const pending = new Map();
    const handlers = new Map();
    // document:ready kommt genau einmal pro geladenem Editor. Ohne diese
    // Merkung wartet whenReady() beim zweiten Dokument auf ein Ereignis, das
    // nie wieder kommt -- der Aufruf haengt dann bis zum Zeitueberschreiten.
    let readySeen = false;

    function nextId() { return 'office-' + (++seq) + '-' + Date.now(); }

    function emit(type, payload, id) {
      const list = handlers.get(type);
      if (list) for (const fn of list.slice()) fn(payload, id);
    }

    function settle(id, type, payload) {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (type === 'document:error') {
        entry.reject(new Error((payload && payload.message) || 'Editor-Fehler'));
      } else {
        entry.resolve(payload);
      }
    }

    function send(type, payload) {
      const id = nextId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Editor-Zeitueberschreitung bei ' + type));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        frame.contentWindow.postMessage({ id, type, payload: payload || {} }, editorOrigin);
      });
    }

    function onMessage(event) {
      const msg = makeMessageFilter(editorOrigin, frame.contentWindow)(event);
      if (!msg) return;
      if (msg.id) settle(msg.id, msg.type, msg.payload);
      if (msg.type === 'document:ready') readySeen = true;
      emit(msg.type, msg.payload, msg.id);
    }

    if (win) win.addEventListener('message', onMessage);

    return {
      editorOrigin,
      base: editorBase,

      // Der Origin-Allowlist des Editors mitgeben, damit er nur zu uns spricht.
      // newDoc/readonly sind dokumentierte Seitenparameter des Editors, werden
      // von der App aber nicht benutzt: am getesteten Deployment blieb der
      // Editor bei new= weiss. Siehe Kommentar in app.js.
      frameUrl(options) {
        const o = options || {};
        const params = new URLSearchParams({ embed: '1', embedOrigin: parentOrigin });
        if (o.newDoc) params.set('new', o.newDoc);
        if (o.readonly) params.set('readonly', '1');
        return editorBase + '/editor?' + params.toString();
      },

      load(options) {
        const url = this.frameUrl(options);
        if (frame.src !== url) {
          frame.src = url;
          // Neuer Frame = neuer Editor: document:ready kommt wieder, die alte
          // Merkung darf nicht gelten.
          readySeen = false;
          this._ready = null;
        }
        return url;
      },

      on(type, fn) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(fn);
        return () => {
          const list = handlers.get(type) || [];
          const i = list.indexOf(fn);
          if (i >= 0) list.splice(i, 1);
        };
      },

      isReady: () => readySeen,

      // Sofort aufloesen, wenn der Editor schon fertig ist: sonst wartet der
      // zweite Aufruf in derselben Sitzung auf ein document:ready, das
      // ein zweites Mal nicht kommt.
      whenReady() {
        if (readySeen) return Promise.resolve(true);
        this._ready = new Promise((resolve) => {
          const off = this.on('document:ready', () => { off(); resolve(true); });
        });
        return this._ready;
      },

      openBuffer(buffer, fileName, options) {
        const o = options || {};
        if (!isBuffer(buffer)) throw new TypeError('openBuffer: ArrayBuffer/Uint8Array erwartet.');
        return send('document:open-buffer', {
          buffer, fileName, readonly: !!o.readonly,
        });
      },

      openUrl(url, fileName, options) {
        const o = options || {};
        return send('document:open-url', { url, fileName, readonly: !!o.readonly });
      },

      save(options) {
        return send('document:save', options || {});
      },

      setReadonly(readonly) {
        return send('document:set-readonly', { readonly: !!readonly });
      },

      getState() {
        return send('document:get-state');
      },

      destroy() {
        for (const entry of pending.values()) clearTimeout(entry.timer);
        pending.clear();
        if (win) win.removeEventListener('message', onMessage);
      },
    };
  }

  /* Bytes aus einer document:saved-Nachricht ziehen. Der Editor liefert ein
   * File/Blob; aelterere Buends uebergeben ArrayBuffer. Beides akzeptieren. */
  async function bytesFromSaved(payload) {
    const file = payload && payload.file;
    if (!file) throw new Error('document:saved ohne Datei.');
    if (file instanceof Blob) return new Uint8Array(await file.arrayBuffer());
    if (isBuffer(file)) return new Uint8Array(file instanceof ArrayBuffer ? file : file.buffer);
    if (file instanceof ArrayBuffer) return new Uint8Array(file);
    if (typeof file === 'string') return new TextEncoder().encode(file);
    throw new Error('document:saved: unbekannter Dateityp.');
  }

  function fileNameFromSaved(payload, fallback) {
    const n = payload && payload.fileName;
    return n || fallback || 'dokument';
  }

  const EditorAdapter = { createEditorAdapter, makeMessageFilter, bytesFromSaved, fileNameFromSaved, PREFIX };

  if (typeof window !== 'undefined') window.OfficeEditor = EditorAdapter;
  if (typeof module !== 'undefined' && module.exports) module.exports = EditorAdapter;
})();
