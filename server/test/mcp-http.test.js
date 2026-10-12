'use strict';
/* MCP ueber HTTP: echter Server, echte Session, echte Notiz.
 *
 *   node server/test/mcp-http.test.js
 *
 * Geprueft wird die Kette, die am leichtesten falsch sein kann: der Kern
 * reicht kein userId durch. Wenn die deps nicht pro Anfrage gebaut werden,
 * sieht jeder Nutzer die Notizen des ersten - und genau das waere im
 * Betrieb still und unauffindbar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-mcp-'));
process.env.FW_DATA_DIR = TMP;
process.env.FW_FILES_DIR = path.join(TMP, 'files');
process.env.FW_ARCHIVE_DIR = path.join(TMP, 'archive');
process.env.FW_PORT = '0';
process.env.FW_HOST = '127.0.0.1';
fs.mkdirSync(process.env.FW_FILES_DIR, { recursive: true });
fs.mkdirSync(process.env.FW_ARCHIVE_DIR, { recursive: true });

const { server } = require('../index.js');

let base = '';
let failed = 0;
function ok(name, cond, extra) {
  if (cond) console.log(`  OK   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? '  -> ' + extra : ''}`); failed++; }
}

function client() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async call(method, p, body, wantCookie) {
      const headers = {};
      if (cookie) headers.cookie = cookie;
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
      const r = await fetch(base + p, { method, headers, body: payload, credentials: 'same-origin' });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, data: ct.includes('json') ? await r.json() : null };
    },
    rpc(method, params, id) {
      return this.call('POST', '/api/mcp', { jsonrpc: '2.0', id: id || 1, method, params: params || {} });
    },
  };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`== MCP-HTTP-Test gegen ${base} ==\n`);

  console.log('== Zugang ==');
  let a = client();
  let r = await a.rpc('tools/list');
  ok('ohne Session abgelehnt', !!r.data.error, JSON.stringify(r.data).slice(0, 90));

  await a.call('POST', '/api/auth/register', { email: 'a@example.org', password: 'passwort123', name: 'A' });
  await b_register();
  async function b_register() {
    const b = client();
    await b.call('POST', '/api/auth/register', { email: 'b@example.org', password: 'passwort123', name: 'B' });
    return b;
  }
  let b = await b_register();

  console.log('\n== Tool-Liste ==');
  r = await a.rpc('tools/list');
  const tools = (r.data.result && r.data.result.tools) || [];
  ok('tools/list antwortet', tools.length > 0, 'anzahl=' + tools.length);
  ok('list_documents vorhanden', tools.some((t) => t.name === 'list_documents'));
  ok('create_document vorhanden', tools.some((t) => t.name === 'create_document'));

  console.log('\n== Schreiben und Lesen ==');
  r = await a.rpc('tools/call', { name: 'create_document', arguments: { title: 'Von A' } });
  ok('create_document', !r.data.error, JSON.stringify(r.data).slice(0, 140));
  const textOf = (res) => (res.data.result && res.data.result.content || []).map((c) => c.text).join('\n');
  const docA = textOf(r);
  const idA = (docA.match(/"id"\s*:\s*"([^"]+)"/) || [])[1];
  ok('Dokument-ID zurueckgegeben', !!idA, docA.slice(0, 100));

  r = await b.rpc('tools/call', { name: 'create_document', arguments: { title: 'Von B' } });
  const docB = textOf(r);
  const idB = (docB.match(/"id"\s*:\s*"([^"]+)"/) || [])[1];
  ok('zweiter Nutzer hat eine eigene ID', !!idB && idB !== idA, idB + ' vs ' + idA);

  console.log('\n== Isolation - der eigentliche Zweck ==');
  r = await a.rpc('tools/call', { name: 'list_documents', arguments: { limit: 50 } });
  const listA = textOf(r);
  ok('A sieht nur seine eigene Notiz', listA.includes('Von A') && !listA.includes('Von B'), listA.slice(0, 160));

  r = await b.rpc('tools/call', { name: 'list_documents', arguments: { limit: 50 } });
  const listB = textOf(r);
  ok('B sieht nur seine eigene Notiz', listB.includes('Von B') && !listB.includes('Von A'), listB.slice(0, 160));

  r = await a.rpc('tools/call', { name: 'get_document', arguments: { id: idB } });
  ok('A kommt an Bs Dokument nicht ran', !!r.data.error || !textOf(r).includes('Von B'), JSON.stringify(r.data).slice(0, 120));

  console.log('\n== Suche und Ordner ==');
  r = await a.rpc('tools/call', { name: 'search_documents', arguments: { query: 'Von A' } });
  ok('search_documents findet es', !r.data.error && textOf(r).includes('Von A'), textOf(r).slice(0, 100));

  r = await a.rpc('tools/call', { name: 'create_folder', arguments: { name: 'Schule' } });
  ok('create_folder', !r.data.error, JSON.stringify(r.data).slice(0, 120));

  r = await a.rpc('tools/call', { name: 'list_folders', arguments: {} });
  ok('list_folders zeigt den Ordner', textOf(r).includes('Schule'), textOf(r).slice(0, 120));

  console.log('\n== Fehlerpfad ==');
  r = await a.rpc('tools/call', { name: 'gibt_es_nicht', arguments: {} });
  ok('unbekanntes Tool meldet Fehler', !!r.data.error, JSON.stringify(r.data).slice(0, 90));
  r = await a.rpc('unsupported/method');
  ok('unbekannte Methode meldet Fehler', !!r.data.error, JSON.stringify(r.data).slice(0, 90));

  server.close();
  require('../db.js').closeAll();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'ERGEBNIS: alle MCP-Pruefungen bestanden' : `ERGEBNIS: ${failed} Pruefung(en) fehlgeschlagen`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('ABBRUCH:', e); process.exit(1); });