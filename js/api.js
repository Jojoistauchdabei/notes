/* Federwerk: Client-Transport zum eigenen Server (server/).
 *
 * Das ist die EINZIGE Stelle, an der die App mit dem Backend spricht. Zwei
 * Dinge gibt es hier bewusst nicht:
 *
 * - kein Session-Secret im localStorage und keinen Auth-Header. Die Session
 *   ist ein HttpOnly-Cookie; der Browser haengt es von selbst an. Genau
 *   deshalb gibt es auch keine authHeaders()-Funktion - es gibt nichts zu
 *   setzen.
 * - keinen Cookie-Fallback fuer fremde Origins (Tauri-WebView). Auf eigenem
 *   Origin faellt das weg.
 *
 * Und eines kommt dazu: der Pfad ist meistens leer, also Same-Origin. Das
 * ist Absicht - dadurch greifen die Service-Worker-Regeln aus sw.js auch fuer
 * die API, und der Browser schickt das Cookie ohne Sonderbehandlung mit.
 *
 * Konfiguration: leer = gleicher Origin. Ueberschreiben mit
 *   localStorage['federwerkApiV1'] = { base: 'http://192.168.1.97:8080' }
 * oder bequem einmalig ueber die Adresszeile:
 *   index.html?api=http://192.168.1.97:8080
 */
(function () {
  'use strict';

  const CFG_KEY = 'federwerkApiV1';

  function cfg() {
    let base = '';
    try {
      const q = new URLSearchParams(location.search).get('api');
      if (q) { base = q; try { lsSet({ base: q }); } catch { /* ignore */ } }
      else {
        const raw = lsGet(null);
        if (raw && raw.base) base = String(raw.base);
      }
    } catch { /* location nicht verfuegbar (Node-Tests) */ }
    return { base: String(base || '').replace(/\/+$/, '') };
  }

  // Injizierbarer Speicher fuer Tests - wie im Rest des Repos.
  let lsBackend = null;
  function ls() {
    if (lsBackend) return lsBackend;
    try { if (typeof localStorage !== 'undefined') return localStorage; } catch { /* ignore */ }
    return null;
  }
  function lsGet(fallback) {
    const s = ls();
    if (!s) return fallback;
    try { const v = s.getItem(CFG_KEY); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  }
  function lsSet(val) {
    const s = ls();
    if (!s) return;
    try { s.setItem(CFG_KEY, JSON.stringify(val)); } catch { /* ignore */ }
  }

  /* Ein Aufruf. Wirft bei Fehlern ein Error mit .status, damit die Aufrufer
   * zwischen 401 (nicht angemeldet) und 500 (Server kaputt) unterscheiden
   * koennen - das alte rest() machte das genauso. */
  async function call(method, path, body, opts = {}) {
    const { base } = cfg();
    const headers = {};
    let payload;
    if (body instanceof FormData) {
      payload = body; // Browser setzen den Multipart-Boundary selbst
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    for (const [k, v] of Object.entries(opts.headers || {})) headers[k] = v;

    const r = await fetch(base + path, { method, headers, body: payload, credentials: 'same-origin' });
    if (r.status === 204 || r.status === 205) return null;

    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.arrayBuffer();
    if (!r.ok) {
      const e = new Error((data && data.error) || ('HTTP ' + r.status));
      e.status = r.status;
      e.body = data;
      throw e;
    }
    return data;
  }

  /* ---- Auth ---- */

  async function session() {
    try { return (await call('GET', '/api/auth/me')).user; }
    catch (e) { if (e && e.status === 401) return null; throw e; }
  }
  const login = (email, password) => call('POST', '/api/auth/login', { email, password });
  const register = (email, password, name) => call('POST', '/api/auth/register', { email, password, name });
  const logout = () => call('POST', '/api/auth/logout');

  /* ---- Dokumente und Ordner ---- */
  const listDocs = (since, limit) =>
    call('GET', '/api/docs?since=' + encodeURIComponent(Number(since) || 0) +
                (limit ? '&limit=' + limit : '')).then((j) => j.items);
  const getDoc = (id) => call('GET', '/api/docs/' + encodeURIComponent(id)).then((j) => j.doc);
  const putDoc = (doc) => call('PUT', '/api/docs', doc).then((j) => j.doc);
  const deleteDoc = (id) => call('DELETE', '/api/docs/' + encodeURIComponent(id));

  const listFolders = () => call('GET', '/api/folders').then((j) => j.items);
  const putFolder = (f) => call('PUT', '/api/folders', f).then((j) => j.folder);
  const deleteFolder = (id) => call('DELETE', '/api/folders/' + encodeURIComponent(id));

  /* ---- Dateien ---- */

  /* Der Server prueft den Inhalt gegen den Namen und lehnt Abweichung mit 422
   * ab. Ein still akzeptierter Bild-Bit-Fehler waere der schlimmste Fall:
   * kaputte Bilder, die erst Wochen spaeter auffallen. */
  async function putFile(sha256, mime, bytes) {
    const fd = new FormData();
    fd.append('sha256', sha256);
    fd.append('mime', mime || 'application/octet-stream');
    fd.append('file', new Blob([bytes]), 'blob');
    return call('POST', '/api/files', fd);
  }
  async function getFile(sha256) {
    const { base } = cfg();
    const r = await fetch(base + '/api/files/' + encodeURIComponent(sha256), { credentials: 'same-origin' });
    if (r.status === 404 || r.status === 410) {
      const e = new Error('Datei unbekannt.');
      e.status = r.status;
      throw e;
    }
    if (r.status === 500) {
      // Der Server meldet so eine Beschaedigung ausdruecklich (Name passt
      // nicht zum Inhalt). Sie darf nicht als "nicht da" durchgehen.
      const e = new Error('Datei auf dem Server beschaedigt.');
      e.status = 500;
      e.corrupt = true;
      throw e;
    }
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return { bytes: new Uint8Array(await r.arrayBuffer()), mime: r.headers.get('content-type') || '' };
  }
  const listFiles = () => call('GET', '/api/files').then((j) => j.items);

  /* ---- Freigaben (Liveshare) ---- */
  const shareCreate = (input) => call('POST', '/api/shares', input).then((j) => j.share);
  const shareGet = (code) => call('GET', '/api/shares/' + encodeURIComponent(code)).then((j) => j.share);
  const sharePatch = (code, input) => call('PATCH', '/api/shares/' + encodeURIComponent(code), input).then((j) => j.share);
  const shareRevoke = (code) => call('DELETE', '/api/shares/' + encodeURIComponent(code));
  const shareList = () => call('GET', '/api/shares').then((j) => j.items);
  const shareEvents = (code, after, limit) =>
    call('GET', '/api/shares/' + encodeURIComponent(code) + '/events?after=' + (Number(after) || 0) +
                (limit ? '&limit=' + limit : ''));
  const shareAppend = (code, ev) =>
    call('POST', '/api/shares/' + encodeURIComponent(code) + '/events', ev);

  /* ---- Live-Kanal ----
   *
   * SSE statt WebSocket: Reconnect, Last-Event-ID und die HTTP-Semantik sind
   * schon drin, das alte handgebaute Ping/Reconnect-Geraet entfaellt. Der
   * Kanal traegt bewusst keine Nutzdaten, sondern nur "zieh nach" - die
   * Daten kommen immer ueber einen regulaeren GET.
   */
  function subscribe(channels, shareId, onChange) {
    if (typeof EventSource === 'undefined') throw new Error('kein EventSource');
    const { base } = cfg();
    const url = base + '/api/events?channels=' + encodeURIComponent((channels || []).join(',')) +
                (shareId ? '&share=' + encodeURIComponent(shareId) : '');
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('change', (ev) => {
      try { onChange(JSON.parse(ev.data)); } catch { onChange({}); }
    });
    return {
      es,
      status: () => (es.readyState === 1 ? ' verbunden' : es.readyState === 2 ? ' geschlossen' : ' verbindet'),
      close: () => { try { es.close(); } catch { /* ignore */ } },
    };
  }

  const health = () => call('GET', '/api/health');

  const api = {
    cfg, call, session, login, register, logout,
    listDocs, getDoc, putDoc, deleteDoc,
    listFolders, putFolder, deleteFolder,
    putFile, getFile, listFiles,
    shareCreate, shareGet, sharePatch, shareRevoke, shareList, shareEvents, shareAppend,
    subscribe, health,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (typeof window !== 'undefined') window.FederwerkApi = api;
})();