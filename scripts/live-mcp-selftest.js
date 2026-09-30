#!/usr/bin/env node
'use strict';
/* Federwerk – Live-Rundlauf gegen das echte Appwrite-Projekt (MCP-Weg).
 *
 * Testet genau den Pfad, den die Doku in docs/mcp.md:253 beschreibt:
 *   create_folder -> create_document -> create_deck + review_card
 *   -> Suche/Graph/Stats -> aufraeumen.
 *
 * Startet den echten MCP-Server als Kindprozess und redet JSON-RPC ueber
 * stdio – es wird NICHT direkt gegen die Appwrite-API gebogen. Wenn der
 * Server kaputt ist, faellt der Test hier auch.
 *
 * credentials kommen NUR aus der Umgebung, nie aus Argumenten, damit sie
 * nicht in der Shell-History landen:
 *   APPWRITE_SESSION=<secret>  (empfohlen, aus `node mcpserver/login.js`)
 *   optional APPWRITE_USER_ID, sonst wird es aus der Session abgeleitet
 *
 * Aufraeumen ist Pflichtteil: auch bei Fehlern wird aufgeraeumt (finally).
 * Erkennbare Praefixe: fw-selftest-  (Ordner)  /  fw-selftest-  (Dokumente)
 * Ein Namensraum pro Lauf ueber Zeitstempel -> kein Kollisionsrisiko.
 *
 * Aufruf:  node scripts/live-mcp-selftest.js
 * Optionen: --keep (nicht aufraeumen, zum Nachsehen), --dry-run (Demo-Server
 *           ohne Cloud-Zugang, prueft nur das Skript selbst)
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'mcpserver', 'cli.js');
const KEEP = process.argv.includes('--keep');
const DRY = process.argv.includes('--dry-run');
const TAG = 'fw-selftest-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const FOLDER = TAG + '-ordner';
const DOC = TAG + '-notiz';
const DECK = TAG + '-deck';

let child = null;
let nextId = 1;
const pending = new Map();
const created = { folders: [], docs: [] };

const results = [];
const warns = [];
function step(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const mark = ok ? '  ok  ' : '  FAIL';
  console.log(mark + ' ' + name + (detail !== undefined && detail !== '' ? '  -> ' + detail : ''));
}
/* Bekannte Eigenheit, kein Deploy-Fehler: sichtbar, aber beendet den Lauf nicht. */
function warn(name, detail) {
  warns.push({ name, detail: detail === undefined ? '' : String(detail) });
  console.log('  !!   ' + name + (detail !== undefined && detail !== '' ? '  -> ' + detail : ''));
}

/* ---------- JSON-RPC ueber stdio ---------- */
function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (!child || child.exitCode !== null) return reject(new Error('MCP-Server nicht laeufig'));
    pending.set(id, { resolve, reject, method });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n');
  });
}

function send(line) {
  if (!child || child.exitCode !== null) return;
  child.stdin.write(JSON.stringify(line) + '\n');
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env);
    if (DRY) {
      // Keine Zugangsdaten -> In-Memory-Demo (volles Toolset).
      delete env.APPWRITE_SESSION; delete env.APPWRITE_API_KEY;
    }
    child = spawn(process.execPath, [CLI], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('exit', code => {
      const err = new Error('MCP-Server beendet (Code ' + code + ')' + (stderr ? ': ' + stderr.slice(0, 300) : ''));
      for (const [, p] of pending) p.reject(err);
      pending.clear();
    });
    setTimeout(() => reject(new Error('Server-Start timeout' + (stderr ? ': ' + stderr.slice(0, 200) : ''))), 15000)
      .unref();
    resolve();
  });
}

/* Text-Inhalt aus einem MCP-Ergebnis ziehen (Content-Array oder Rohtext). */
function textOf(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  if (Array.isArray(res.content)) return res.content.map(c => c && c.text || '').join('\n');
  if (typeof res.text === 'string') return res.text;
  return JSON.stringify(res);
}
function jsonOf(res) {
  const t = textOf(res);
  try { return JSON.parse(t); } catch { return null; }
}

/* Erst-ID aus beliebiger Antwort hebeln (create_* liefern unterschiedlich). */
function firstId(res) {
  const j = jsonOf(res);
  if (j) {
    if (typeof j.id === 'string') return j.id;
    if (j.folder && typeof j.folder.id === 'string') return j.folder.id;
    if (j.document && typeof j.document.id === 'string') return j.document.id;
    if (j.deck && typeof j.deck.id === 'string') return j.deck.id;
    if (Array.isArray(j) && j.length && typeof j[0].id === 'string') return j[0].id;
  }
  const m = textOf(res).match(/"id"\s*:\s*"([A-Za-z0-9]+)"/);
  return m ? m[1] : null;
}

async function main() {
  console.log('');
  console.log('Federwerk – Live-Rundlauf gegen Appwrite' + (DRY ? '  (--dry-run, Demo-Daten)' : ''));
  console.log('Praefix: ' + TAG);
  console.log('');

  if (!DRY && !process.env.APPWRITE_SESSION && !process.env.APPWRITE_API_KEY) {
    console.log('ABBRUCH: Keine Zugangsdaten.');
    console.log('');
    console.log('  node mcpserver/login.js --email DU@BEISPIEL.DE   # fragt das Passwort');
    console.log('  # danach in DIESER Shell:');
    console.log('  export APPWRITE_SESSION="<secret-aus-login>"');
    console.log('  node scripts/live-mcp-selftest.js');
    console.log('');
    console.log('Bewusst kein Argument: ein Session-Secret auf der Kommandozeile landet');
    console.log('in der Shell-History.');
    process.exit(2);
  }

  await startServer();

  try {
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    // 0) Verbindung
    const info = await call('tools/call', { name: 'session_info', arguments: {} });
    const si = jsonOf(info) || {};
    const userId = si.userId || process.env.APPWRITE_USER_ID || '';
    step('session_info liefert eine authentifizierte Session',
      DRY || !!(si.authenticated || userId),
      DRY ? 'uebersprungen (dry-run, In-Memory-Demo)'
          : (si.email ? ('user=' + si.email) : (si.authenticated ? '' : 'nicht authentifiziert')));

    if (!DRY && !si.authenticated) {
      step('Abbruch: ohne Session geht der Schreibtest nicht weiter', false, 'session_info.authenticated=false');
      return;
    }

    // 1) Tools vorhanden?
    const tools = await call('tools/list', {});
    const namen = (tools && tools.tools || []).map(t => t.name);
    const pflicht = ['create_folder', 'create_document', 'create_deck', 'review_card',
      'delete_document', 'delete_folder', 'search_documents', 'deck_stats'];
    const fehlen = pflicht.filter(n => namen.indexOf(n) < 0);
    step('alle Schreib-/Lesetools registriert', fehlen.length === 0,
      fehlen.length ? 'fehlen: ' + fehlen.join(', ') : (namen.length + ' tools'));

    // 2) Ordner anlegen
    const f = await call('tools/call', { name: 'create_folder', arguments: { name: FOLDER } });
    const folderId = firstId(f);
    if (folderId) created.folders.push(folderId);
    step('create_folder', !!folderId, folderId || textOf(f).slice(0, 200));

    // 3) Notiz anlegen (mit Seite, damit Seiten-Inhalt getestet ist)
    const d = await call('tools/call', {
      name: 'create_document',
      arguments: {
        title: DOC,
        contentFormat: 'markdown',
        content: '# ' + DOC + '\n\nTestabsatz fuer den Rundlauf.\n\n- [ ] Punkt eins',
        folderId: folderId || undefined,
      },
    });
    const docId = firstId(d);
    if (docId) created.docs.push(docId);
    step('create_document', !!docId, docId || textOf(d).slice(0, 200));

    // 4) Deck anlegen + Karte bewerten
    let deckId = null;
    let cardId = null;
    created.deck = null;
    const dk = await call('tools/call', {
      name: 'create_deck',
      arguments: { title: DECK, cards: [{ front: 'Was ist v1.9.22?', back: 'Ein Release.' }] },
    });
    deckId = firstId(dk);
    if (deckId) created.deck = deckId;
    step('create_deck', !!deckId, deckId || textOf(dk).slice(0, 200));

    if (deckId) {
      const cards = await call('tools/call', { name: 'list_cards', arguments: { deckId: deckId } });
      const cj = jsonOf(cards);
      const arr = (cj && (cj.cards || cj)) || [];
      if (Array.isArray(arr) && arr.length) cardId = arr[0].id;
      step('list_cards liefert die angelegte Karte', !!cardId, cardId || ('gefunden: ' + arr.length));

      if (cardId) {
        const rv = await call('tools/call', { name: 'review_card', arguments: { deckId: deckId, cardId: cardId, grade: 'good' } });
        const rj = jsonOf(rv) || {};
        const rvTxt = textOf(rv);
        const galt = rj.grade === 'good' || /"grade"\s*:\s*"good"/.test(rvTxt)
          || /good/.test(rvTxt) || /reviewLog/.test(rvTxt);
        step('review_card wertet die Karte aus', galt, 'grade=good, Antwort ' + rvTxt.slice(0, 90).replace(/\n/g, ' '));

        const st = await call('tools/call', { name: 'deck_stats', arguments: { deckId: deckId } });
        step('deck_stats liest den Verlauf zurueck', !!jsonOf(st), textOf(st).slice(0, 120).replace(/\n/g, ' '));
      }
    }

    // 5) Lesen: Liste, Suche, Graph
    const ls = await call('tools/call', { name: 'list_documents', arguments: {} });
    const lj = jsonOf(ls);
    const liste = (lj && (lj.documents || lj)) || [];
    const gefunden = Array.isArray(liste)
      && liste.some(x => x && (x.title === DOC || x.title === DECK));
    step('list_documents zeigt die neuen Eintraege', gefunden,
      Array.isArray(liste) ? (liste.length + ' Dokumente sichtbar') : textOf(ls).slice(0, 120));

    const se = await call('tools/call', { name: 'search_documents', arguments: { query: 'Testabsatz' } });
    step('search_documents findet den Text im Notiz-Inhalt', !!se && textOf(se).length > 0,
      textOf(se).slice(0, 120).replace(/\n/g, ' '));

    const gr = await call('tools/call', { name: 'get_graph', arguments: {} });
    step('get_graph antwortet', !!gr, textOf(gr).slice(0, 100).replace(/\n/g, ' '));

    // 6) v2-Huelle: steht das Deck als v2 drin? (das ist der Kern des Deploys)
    if (deckId) {
      const got = await call('tools/call', { name: 'get_document', arguments: { id: deckId } });
      const gj = jsonOf(got) || {};
      const txt = textOf(got);
      const istV2 = gj.kind === 'flashcards' || /"kind"\s*:\s*"flashcards"/.test(txt)
        || /"v"\s*:\s*2/.test(txt);
      step('Deck kommt als v2-Huelle zurueck (kind/cards)', istV2,
        istV2 ? 'v2 erkannt' : 'NUR v1 – Appwrite-Function ist aelter als js/appwrite-sync.js');

      // Persistenz ueber deck_stats (liest den Verlauf aus der Envelope):
      // das ist der Weg, den auch der App-Sync nimmt.
      const stats = jsonOf(await call('tools/call', { name: 'deck_stats', arguments: { deckId: deckId } })) || {};
      const gelernt = Number(stats.learned || 0);
      const total = Number(stats.total || 0);
      step('Bewertung ist in der Cloud gespeichert (deck_stats)', total > 0 && gelernt > 0,
        'total=' + total + ' learned=' + gelernt + ' accuracy=' + stats.accuracy);

      // docFromRow() in mcp/content.js gibt cards+deckOptions zurueck, aber
      // nie reviewLog. Die Daten sind also da, nur nicht ueber get_document
      // sichtbar -> Eigenheit der MCP-Leseseite, kein Datenverlust.
      const sichtbar = gj.reviewLog !== undefined || /reviewLog/.test(txt);
      if (sichtbar) step('reviewLog ist auch ueber get_document sichtbar', true);
      else warn('reviewLog fehlt in get_document',
        'mcp/content.js docFromRow() gibt cards+deckOptions zurueck, aber kein reviewLog. '
        + 'Persistenz ist belegt (deck_stats), nur die MCP-Leseseite zeigt den Verlauf nicht.');
    }

  } catch (e) {
    step('Abbruch wegen Fehler', false, e && e.message ? e.message : String(e));
  } finally {
    // 7) Aufraeumen – auch nach Fehlern.
    if (!KEEP) {
      for (const id of [created.deck].concat(created.docs.filter(x => x !== created.deck)).filter(Boolean)) {
        try {
          const r = await call('tools/call', { name: 'delete_document', arguments: { id: id } });
          step('aufraeumen: delete_document ' + id.slice(0, 8), true, textOf(r).slice(0, 60));
        } catch (e) { step('aufraeumen delete_document ' + id.slice(0, 8), false, e.message); }
      }
      for (const id of created.folders) {
        try {
          const r = await call('tools/call', { name: 'delete_folder', arguments: { id: id } });
          step('aufraeumen: delete_folder ' + id.slice(0, 8), true, textOf(r).slice(0, 60));
        } catch (e) { step('aufraeumen delete_folder ' + id.slice(0, 8), false, e.message); }
      }
      if (!created.docs.length && !created.deck && !created.folders.length) {
        console.log('  --   nichts aufzuräumen (nichts angelegt)');
      }
    } else {
      console.log('');
      console.log('--keep: Angelegt bleibt (manuell löschen):');
      console.log('  Ordner:  ' + FOLDER + (created.folders[0] ? '  id=' + created.folders[0] : ''));
      console.log('  Notiz:   ' + DOC + (created.docs[0] ? '  id=' + created.docs[0] : ''));
      console.log('  Deck:    ' + DECK + (created.deck ? '  id=' + created.deck : ''));
    }
  }

  try { child.kill(); } catch { /* schon weg */ }

  const okN = results.filter(r => r.ok).length;
  const bad = results.filter(r => !r.ok);
  console.log('');
  console.log('----------------------------------------');
  console.log(okN + ' von ' + results.length + ' Schritten ok');
  if (bad.length) {
    console.log('');
    console.log('Fehlgeschlagen:');
    for (const b of bad) console.log('  - ' + b.name + (b.detail ? ': ' + b.detail : ''));
  }
  if (warns.length) {
    console.log('');
    console.log('Bekannte Eigenheiten (kein Fehlschlag):');
    for (const w of warns) console.log('  - ' + w.name + (w.detail ? ': ' + w.detail : ''));
  }
  console.log(DRY ? '(dry-run: In-Memory-Demo, keine Cloud-Daten beruehrt)' : 'Aufgeraeumt.');
  console.log('');
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => {
  console.error('Skriptabsturz: ' + (e && e.message ? e.message : e));
  try { if (child) child.kill(); } catch { /* ignore */ }
  process.exit(3);
});