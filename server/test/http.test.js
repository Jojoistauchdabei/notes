'use strict';
/* HTTP-Integrationstest: startet den echten Server auf einem freien Port
 * und spricht ihn mit fetch an - inklusive Cookie, Auth, Upload, SSE.
 *
 *   node server/test/http.test.js
 *
 * Bewusst kein node:test-Runner drumherum: der Server laeuft im selben
 * Prozess, und ein Wegwerf-Datenverzeichnis wird am Ende entfernt. Als
 * eigenes Skript laeuft er ausserhalb von `npm test`, damit die bestehende
 * Suite unberuehrt bleibt.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'federwerk-http-'));
process.env.FW_DATA_DIR = TMP;
process.env.FW_FILES_DIR = path.join(TMP, 'files');
process.env.FW_ARCHIVE_DIR = path.join(TMP, 'archive');
process.env.FW_PORT = '0'; // freier Port
process.env.FW_HOST = '127.0.0.1';
fs.mkdirSync(process.env.FW_FILES_DIR, { recursive: true });
fs.mkdirSync(process.env.FW_ARCHIVE_DIR, { recursive: true });

const { server } = require('../index.js');

let base = '';
let cookie = '';
let failed = 0;

function ok(name, cond, extra) {
  if (cond) console.log(`  OK   ${name}`);
  else { console.log(`  FAIL ${name}${extra ? '  -> ' + extra : ''}`); failed++; }
}

async function call(method, p, body, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (cookie) headers.cookie = cookie;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(base + p, { method, headers, body: payload, redirect: 'manual' });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.arrayBuffer();
  return { status: r.status, data, headers: r.headers };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  console.log(`== HTTP-Test gegen ${base} ==\n`);

  console.log('== Health ==');
  let r = await call('GET', '/api/health');
  ok('health antwortet', r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
  ok('Hash-Pruefung aktiv', r.data.filesVerified === true);

  console.log('\n== Auth ==');
  r = await call('GET', '/api/docs');
  ok('ohne Cookie 401', r.status === 401, 'status=' + r.status);

  r = await call('POST', '/api/auth/register', { email: 'x@example.org', password: 'passwort123', name: 'X' });
  ok('Registrierung 201', r.status === 201, JSON.stringify(r.data));
  ok('Cookie gesetzt', !!cookie, 'kein Set-Cookie');
  ok('Cookie ist HttpOnly', /HttpOnly/i.test(r.headers.get('set-cookie') || ''), r.headers.get('set-cookie'));

  r = await call('GET', '/api/auth/me');
  ok('me liefert den Nutzer', r.status === 200 && r.data.user.email === 'x@example.org');

  r = await call('POST', '/api/auth/register', { email: 'kurz', password: 'kurz' });
  ok('schwaches Passwort abgelehnt', r.status === 400, 'status=' + r.status);

  r = await call('POST', '/api/auth/login', { email: 'x@example.org', password: 'falsch' });
  ok('falsches Passwort 401', r.status === 401, 'status=' + r.status);

  console.log('\n== Dokumente ==');
  const jetzt = Date.now();
  r = await call('PUT', '/api/docs', { id: 'b1', title: 'Heft', content: '{"v":1,"pages":[]}', updatedAt: jetzt });
  ok('Dokument angelegt', r.status === 200 && r.data.doc.title === 'Heft', JSON.stringify(r.data));

  r = await call('GET', '/api/docs?since=0&kind=note');
  ok('Delta-Pull liefert es zurueck', r.status === 200 && r.data.items.length === 1);

  r = await call('PUT', '/api/docs', { id: 'b1', title: 'Alt', content: 'ALT', updatedAt: jetzt - 60000 });
  r = await call('GET', '/api/docs/b1');
  ok('LWW haelt den neueren Inhalt', r.data.doc.content === '{"v":1,"pages":[]}', r.data.doc.content);

  r = await call('PUT', '/api/docs', { id: '../traversal', title: 'x', content: 'x' });
  ok('Pfad-Ausbruch abgelehnt', r.status === 400, 'status=' + r.status);

  r = await call('PUT', '/api/folders', { id: 'f1', name: 'Schule', updatedAt: jetzt });
  ok('Ordner angelegt', r.status === 200 && r.data.folder.name === 'Schule');
  r = await call('GET', '/api/folders');
  ok('Ordner auflistbar', r.data.items.length === 1);

  r = await call('DELETE', '/api/docs/b1');
  ok('Loeschen als Grabstein', r.status === 200 && r.data.deletedAt > 0);

  console.log('\n== Dateien ==');
  const inhalt = Buffer.from('ein bild, das man nicht sieht');
  const sha = crypto.createHash('sha256').update(inhalt).digest('hex');
  const fd = new FormData();
  fd.append('sha256', sha);
  fd.append('mime', 'image/png');
  fd.append('file', new Blob([inhalt]), 'bild.png');
  r = await call('POST', '/api/files', fd);
  ok('Upload 201', r.status === 201 && r.data.deduplicated === false, JSON.stringify(r.data));

  const fd2 = new FormData();
  fd2.append('sha256', sha); fd2.append('mime', 'image/png');
  fd2.append('file', new Blob([inhalt]), 'bild.png');
  r = await call('POST', '/api/files', fd2);
  ok('zweiter Upload ist Dedupe (200)', r.status === 200 && r.data.deduplicated === true);

  r = await call('GET', `/api/files/${sha}`);
  ok('Download liefert exakt die Bytes',
    r.status === 200 && Buffer.from(r.data).equals(inhalt));
  ok('ETag ist der Hash', (r.headers.get('etag') || '').includes(sha));

  const falscherHash = crypto.createHash('sha256').update(Buffer.from('anders')).digest('hex');
  const fd3 = new FormData();
  fd3.append('sha256', falscherHash); fd3.append('mime', 'image/png');
  fd3.append('file', new Blob([inhalt]), 'x.png');
  r = await call('POST', '/api/files', fd3);
  ok('Hash-Betrug abgelehnt (422)', r.status === 422, 'status=' + r.status + ' ' + JSON.stringify(r.data));

  // Datei hinter dem Namen beschaedigen -> Lesen muss es merken.
  const ziel = path.join(process.env.FW_FILES_DIR, sha.slice(0, 2), sha.slice(2, 4), sha + '.png');
  const saved = fs.readFileSync(ziel);
  fs.writeFileSync(ziel, 'BESCHAEDIGT');
  r = await call('GET', `/api/files/${sha}`);
  ok('beschaedigte Datei wird nicht ausgeliefert', r.status === 500, 'status=' + r.status);
  fs.writeFileSync(ziel, saved);
  r = await call('GET', `/api/files/${sha}`);
  ok('nach Reparatur wieder lesbar', r.status === 200);

  console.log('\n== Referenzindex ==');
  r = await call('PUT', '/api/docs', { id: 'mitbild', title: 'M', content: JSON.stringify({ src: 'awfile:' + sha }), updatedAt: jetzt });
  const { execFileSync } = require('child_process');
  const gc = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'gc.js'), '--data', TMP, '--json'], { env: process.env }).toString());
  ok('GC sieht die Datei als referenziert', gc.users[0] && gc.users[0].coldCandidateCount + gc.users[0].orphanCount === 0, JSON.stringify(gc.users[0]));

  console.log('\n== Freigaben ==');
  r = await call('POST', '/api/shares', { bookId: 'b1', title: 'Liveshare', mode: 'edit' });
  const code = r.data.share.shareId;
  ok('Freigabe erstellt', r.status === 201 && /^s/.test(code), JSON.stringify(r.data));
  r = await call('GET', `/api/shares/${code}`);
  ok('Freigabe lesbar', r.status === 200 && r.data.share.bookId === 'b1');
  r = await call('POST', `/api/shares/${code}/events`, { kind: 'stroke', payload: { pts: 5 } });
  ok('Event angehaengt', r.status === 201);
  r = await call('POST', `/api/shares/${code}/events`, { kind: 'boese' });
  ok('unbekannte Ereignisart abgelehnt', r.status === 400);
  r = await call('GET', `/api/shares/${code}/events?after=0`);
  ok('Event abrufbar', r.data.items.length === 1 && r.data.items[0].kind === 'stroke');

  console.log('\n== Live-Kanal (SSE) ==');
  const ac = new AbortController();
  const sse = fetch(base + '/api/events?channels=docs', { headers: { cookie }, signal: ac.signal });
  const resp = await sse;
  ok('SSE liefert den richtigen Typ', /text\/event-stream/.test(resp.headers.get('content-type') || ''),
     resp.headers.get('content-type'));
  ok('Proxy-Puffer abgeschaltet', resp.headers.get('x-accel-buffering') === 'no');

  await new Promise((res) => setTimeout(res, 200));
  await call('PUT', '/api/docs', { id: 'sse-test', title: 'Pusch', content: 'x', updatedAt: Date.now() });

  // Gelesen werden muss chunkweise: resp.text() wuerde auf das Ende des
  // Stroms warten, und ein SSE-Strom endet nie.
  let gesammelt = '';
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  const lesen = (async () => {
    while (gesammelt.length < 4000) {
      const { value, done } = await reader.read();
      if (done) break;
      gesammelt += dec.decode(value, { stream: true });
      if (/event: change/.test(gesammelt)) break;
    }
  })();
  await Promise.race([lesen, new Promise((r) => setTimeout(r, 3000))]);
  ac.abort();

  ok('SSE liefert ein change-Ereignis', /event: change/.test(gesammelt), JSON.stringify(gesammelt.slice(0, 150)));
  ok('Ereignis traegt keine Nutzdaten', !/sse-test/.test(gesammelt), 'Nutzlast im Kanal waere ein Leck');

  console.log('\n== Fremde Herkunft ==');
  r = await fetch(base + '/api/docs', { headers: { cookie, origin: 'https://boese.example' } });
  ok('fremde Herkunft 403', r.status === 403, 'status=' + r.status);
  r = await fetch(base + '/api/docs', { headers: { cookie, origin: base } });
  ok('eigene Herkunft erlaubt', r.status === 200, 'status=' + r.status);

  console.log('\n== Abmelden ==');
  r = await call('POST', '/api/auth/logout');
  ok('Logout 200', r.status === 200);
  r = await call('GET', '/api/docs');
  ok('nach Logout 401', r.status === 401, 'status=' + r.status);

  server.close();
  require('../db.js').closeAll();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? 'ERGEBNIS: alle HTTP-Pruefungen bestanden' : `ERGEBNIS: ${failed} Pruefung(en) fehlgeschlagen`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('ABBRUCH:', e); process.exit(1); });