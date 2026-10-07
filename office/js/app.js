/* Office UI -- Tresor, Dokumentliste, Editor-Einbettung, Verlauf.
 *
 * Reihenfolge im Bildaufbau:
 *   1. Tresor (Passphrase) oeffnen -> Vault aus KV-Salt, sonst neu anlegen.
 *   2. Dokumentliste aus dem Adapter (Adapter ist austauschbar).
 *   3. Oeffnen -> weiche Sperre -> Bytes entschluesseln -> open-buffer an den
 *      Editor. Bytes werden hier nie ueber eine URL geladen: die Dokumente sind
 *      verschluesselt und es gibt bewusst keinen CORS-faehigen Datei-Server.
 *   4. Speichern -> document:save -> neue Version mit ifMatch. Bei Konflikt
 *      kein Wurf, sondern eine Entscheidung der UI (neu laden / als Kopie).
 */
(function () {
  'use strict';

  const HOLDER = 'local:' + new Date().toISOString().slice(0, 10);
  const META_KEY = 'meta:vault';
  const LOCK_TTL = 120000;

  const el = (id) => document.getElementById(id);
  const state = { store: null, kv: null, adapter: null, editor: null, current: null, dirty: false };

  function status(text, kind) {
    // Zwei Statuszeilen (Tresor-Bereich, Kopfzeile der Arbeitsflaeche): anzeigen,
    // wo der Nutzer gerade hinschaut, statt in eine von beiden zu schreiben.
    const node = el('workspace') && el('workspace').hidden ? el('statusGate') : el('statusTop');
    const gate = el('statusGate');
    const top = el('statusTop');
    for (const n of [gate, top]) {
      if (!n) continue;
      n.textContent = n === node ? (text || '') : '';
      n.dataset.kind = n === node ? (kind || '') : '';
    }
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function formatTime(ts) {
    if (!ts) return '--';
    return new Date(ts).toLocaleString();
  }

  /* -- Tresor ------------------------------------------------------------- */

  function pickKv() {
    try {
      if (typeof indexedDB !== 'undefined') return OfficeKv.createIndexedDbKv('office-db');
    } catch { /* faellt auf Memory */ }
    status('Kein IndexedDB verfuegbar: Daten gehen beim Neuladen verloren.', 'warn');
    return OfficeKv.createMemoryKv();
  }

  async function unlockVault(passphrase) {
    const meta = await state.kv.get(META_KEY);
    const options = meta && meta.salt
      ? { salt: meta.salt, iterations: meta.iterations }
      : {};
    const vault = OfficeCrypto.createVault(passphrase, options);

    // Bestehende Tresore sind daran zu erkennen, dass das Envelope sich mit
    // der eingegebenen Passphrase nicht oeffnen laesst. Ohne Dokument gibt es
    // nichts zu pruefen -- das ist der einzige Fall, in dem eine falsche
    // Passphrase erst spaeter auffaellt.
    const docs = await state.adapter.listDocuments();
    for (const doc of docs) {
      const full = await state.adapter.readDocument(doc.id);
      if (!full.envelope) continue;
      try {
        await vault.open(full.envelope);
      } catch {
        throw new Error('Passphrase falsch oder Daten beschädigt.');
      }
      break;
    }
    if (!meta) await state.kv.set(META_KEY, { salt: vault.salt(), iterations: vault.iterations() });
    return vault;
  }

  /* -- Dokumentliste ------------------------------------------------------ */

  async function refresh() {
    const docs = await state.store.list();
    const body = el('doclist');
    body.innerHTML = '';
    if (!docs.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Noch keine Dokumente. Neu anlegen oder eine Datei importieren.';
      body.appendChild(empty);
      return;
    }
    for (const doc of docs) {
      const row = document.createElement('div');
      row.className = 'doc' + (state.current && state.current.id === doc.id ? ' doc--aktiv' : '');

      const main = document.createElement('button');
      main.className = 'doc__main';
      main.innerHTML = '';
      const title = document.createElement('span');
      title.className = 'doc__title';
      title.textContent = doc.title;
      const meta = document.createElement('span');
      meta.className = 'doc__meta';
      meta.textContent = doc.kind + ' \u00b7 v' + doc.version + ' \u00b7 ' + formatBytes(doc.size)
        + ' \u00b7 ' + formatTime(doc.updatedAt);
      main.append(title, meta);
      main.onclick = () => openDocument(doc.id);

      const actions = document.createElement('span');
      actions.className = 'doc__actions';

      const hist = document.createElement('button');
      hist.className = 'ghost';
      hist.textContent = 'Verlauf';
      hist.onclick = () => showHistory(doc.id);
      actions.appendChild(hist);

      if (doc.lockedBy && doc.lockedBy !== HOLDER) {
        const lock = document.createElement('span');
        lock.className = 'pill pill--lock';
        lock.textContent = 'gesperrt: ' + doc.lockedBy;
        actions.appendChild(lock);
      }

      const del = document.createElement('button');
      del.className = 'ghost ghost--danger';
      del.textContent = 'Löschen';
      del.onclick = async () => {
        if (!confirm('Dokument "' + doc.title + '" endgültig löschen?')) return;
        await state.store.remove(doc.id);
        if (state.current && state.current.id === doc.id) closeDocument();
        status('Dokument gelöscht.');
        await refresh();
      };
      actions.appendChild(del);

      row.append(main, actions);
      body.appendChild(row);
    }
  }

  /* -- Dokument oeffnen/schliessen ---------------------------------------- */

  async function openDocument(id) {
    const lock = await state.store.lock(id, HOLDER, LOCK_TTL);
    if (!lock) {
      status('Gerade gesperrt. Später erneut versuchen oder Verlauf prüfen.', 'warn');
      await refresh();
      return;
    }
    try {
      const doc = await state.store.open(id);
      state.current = doc;
      state.dirty = false;
      el('editorTitle').textContent = doc.title;
      el('editorPane').hidden = false;
      el('lockNote').textContent = 'Bearbeitung gesperrt für dich (weich, 2 min).';

      const editor = getEditor();
      // Ein noch nie beschriebenes Dokument erzeugt der Editor selbst (new=);
      // ab Version 1 schicken wir die entschluesselten Bytes aus dem Tresor.
      // open-url bleibt ungenutzt: unsere Dateien liegen verschluesselt lokal
      // und es gibt keine CORS-faehige Dokument-URL.
      if (doc.version === 0) {
        editor.load({ newDoc: doc.kind });
        await editor.whenReady();
      } else {
        editor.load();
        await editor.whenReady();
        await editor.openBuffer(doc.bytes, doc.title, { readonly: false });
      }
      state.dirty = true;
      status('Dokument geöffnet.');
    } catch (e) {
      status('Öffnen fehlgeschlagen: ' + e.message, 'error');
    }
    await refresh();
  }

  function closeDocument() {
    if (state.current) {
      state.store.unlock(state.current.id, HOLDER).catch(() => {});
    }
    state.current = null;
    state.dirty = false;
    el('editorPane').hidden = true;
    el('editorTitle').textContent = '';
    el('historyList').innerHTML = '';
  }

  /* -- Speichern + Konflikt ---------------------------------------------- */

  async function saveCurrent() {
    if (!state.current) return;
    const editor = getEditor();
    try {
      const payload = await editor.save({ targetExt: state.current.kind.toUpperCase() });
      const bytes = await OfficeEditor.bytesFromSaved(payload);
      const name = OfficeEditor.fileNameFromSaved(payload, state.current.title);
      const result = await state.store.save(state.current.id, bytes, { ifMatch: state.current.etag });
      if (result.ok) {
        state.current.etag = result.etag;
        state.current.version = result.version;
        state.dirty = false;
        hideConflict();
        status('Gespeichert als Version ' + result.version + ' (' + name + ').');
      } else {
        showConflict(result);
      }
    } catch (e) {
      status('Speichern fehlgeschlagen: ' + e.message, 'error');
    }
    await refresh();
  }

  function showConflict(result) {
    const box = el('conflict');
    box.hidden = false;
    el('conflictText').textContent =
      'Dieses Dokument wurde zwischenzeitlich woanders gespeichert. '
      + 'Deine Fassung wurde nicht überschrieben.';
  }

  function hideConflict() { el('conflict').hidden = true; }

  async function reloadAfterConflict() {
    if (!state.current) return;
    const doc = await state.store.open(state.current.id);
    state.current = doc;
    const editor = getEditor();
    await editor.openBuffer(doc.bytes, doc.title);
    hideConflict();
    status('Fremde Fassung geladen. Deine letzte Fassung ging dabei nicht verloren, '
      + 'solange du sie nicht schon als Kopie gesichert hast.', 'warn');
  }

  async function keepMine() {
    if (!state.current) return;
    const editor = getEditor();
    const payload = await editor.save({ targetExt: state.current.kind.toUpperCase() });
    const bytes = await OfficeEditor.bytesFromSaved(payload);
    const result = await state.store.saveAsCopy(state.current.id, bytes);
    state.current.etag = result.etag;
    state.current.version = result.version;
    hideConflict();
    status('Deine Fassung als eigene Version ' + result.version + ' gespeichert.', 'warn');
    await refresh();
  }

  /* -- Verlauf ------------------------------------------------------------ */

  async function showHistory(id) {
    const versions = await state.store.history(id);
    const list = el('historyList');
    list.innerHTML = '';
    el('historyTitle').textContent = 'Verlauf: ' + id;
    if (!versions.length) {
      list.textContent = 'Noch keine Versionen.';
      return;
    }
    for (const v of versions) {
      const row = document.createElement('div');
      row.className = 'ver';
      row.textContent = 'v' + v.version + ' \u00b7 ' + formatBytes(v.size) + ' \u00b7 ' + formatTime(v.createdAt);
      const restore = document.createElement('button');
      restore.className = 'ghost';
      restore.textContent = 'Wiederherstellen';
      restore.onclick = async () => {
        const result = await state.store.restore(id, v.version);
        status('Version ' + v.version + ' wiederhergestellt (jetzt v' + result.version + ').');
        if (state.current && state.current.id === id) await reloadAfterConflict();
        await refresh();
      };
      row.appendChild(restore);
      list.appendChild(row);
    }
  }

  /* -- Editor ------------------------------------------------------------- */

  function getEditor() {
    if (state.editor) return state.editor;
    const frame = el('editorFrame');
    try {
      state.editor = OfficeEditor.createEditorAdapter({ frame, editorBase: editorBase() });
    } catch (e) {
      status('Editor nicht konfiguriert: ' + e.message, 'error');
      throw e;
    }
    // dirty wird nicht ueber Editor-Events gesetzt: das Embed-Protokoll meldet
    // document:saved nur als Antwort auf unser eigenes document:save. Es gibt
    // kein Ereignis fuer "der Nutzer hat getippt". Deshalb: nach dem Oeffnen
    // optimistisch "geaendert" annehmen und nach erfolgreichem Speichern
    // zuruecksetzen.
    state.editor.on('document:error', (p) => status('Editor meldet Fehler: ' + (p && p.message), 'error'));
    return state.editor;
  }

  function editorBase() {
    const fromQuery = new URLSearchParams(location.search).get('editor');
    return fromQuery || el('editorBase')?.value || window.EDITOR_BASE || '';
  }

  /* -- Start -------------------------------------------------------------- */

  async function boot() {
    state.kv = pickKv();
    state.adapter = OfficeStorage.createLocalBackend(state.kv);
    OfficeStorage.assertAdapter(state.adapter);
    el('editorBase').value = window.EDITOR_BASE || '';
    el('editorBase').addEventListener('change', () => { state.editor = null; });

    el('unlockForm').onsubmit = async (e) => {
      e.preventDefault();
      const pass = el('passphrase').value;
      if (!pass) return;
      try {
        const vault = await unlockVault(pass);
        state.store = OfficeDocStore.createDocStore({ adapter: state.adapter, vault, holder: HOLDER });
        el('gate').hidden = true;
        el('workspace').hidden = false;
        el('lockNote').textContent = 'Bearbeitung gesperrt für dich (weich, 2 min).';
        status('Tresor geöffnet.');
        await refresh();
      } catch (err) {
        status(err.message, 'error');
      }
    };

    el('newDoc').onclick = async () => {
      const title = prompt('Titel des neuen Dokuments', 'Neues Dokument');
      if (!title) return;
      const doc = await state.store.create({ title });
      await refresh();
      await openDocument(doc.id);
    };

    el('importFile').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const doc = await state.store.importFile(file);
        status('Importiert: ' + doc.title);
        await refresh();
        await openDocument(doc.id);
      } catch (err) {
        status('Import fehlgeschlagen: ' + err.message, 'error');
      }
    };

    el('saveBtn').onclick = saveCurrent;
    el('closeBtn').onclick = async () => { closeDocument(); await refresh(); };
    el('reloadBtn').onclick = reloadAfterConflict;
    el('keepBtn').onclick = keepMine;
    el('importInput').onclick = () => el('importFile').click();

    window.addEventListener('beforeunload', (e) => {
      if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  if (typeof module !== 'undefined' && module.exports) module.exports = { HOLDER, formatBytes };
})();
