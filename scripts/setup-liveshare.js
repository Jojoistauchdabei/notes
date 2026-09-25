// scripts/setup-liveshare.js – richtet die Liveshare-Tabellen in Appwrite ein.
//
//   API-Key (mit TablesDB-Scope) als Umgebungsvariable übergeben, dann:
//     APPWRITE_API_KEY=... node scripts/setup-liveshare.js --apply
//
//   Ohne --apply läuft nur ein Dry-Run (druckt alle Requests, kein Netzwerk).
//   Ohne APPWRITE_API_KEY ist nur --dry-run möglich.
//
//   Optionale Env (Defaults = Federwerk-Standard aus js/appwrite-files.js):
//     APPWRITE_ENDPOINT, APPWRITE_PROJECT, APPWRITE_DATABASE
//
// Kein npm-Paket nötig (nur globales fetch, Node 18+).
'use strict';

const DEFAULTS = {
  endpoint: 'https://fra.cloud.appwrite.io/v1',
  projectId: '6ab0067c00244c28560a',
  databaseId: 'federwerk',
};

function cfg() {
  return {
    endpoint: (process.env.APPWRITE_ENDPOINT || DEFAULTS.endpoint).replace(/\/$/, ''),
    projectId: process.env.APPWRITE_PROJECT || DEFAULTS.projectId,
    databaseId: process.env.APPWRITE_DATABASE || DEFAULTS.databaseId,
    apiKey: process.env.APPWRITE_API_KEY || null,
  };
}

// Baut die komplette Operationsliste (rein, testbar): [{method, path, body}]
function plan(c) {
  const ops = [];
  const t = (tableId, name, permissions) => ops.push({
    method: 'POST', path: `/tablesdb/${c.databaseId}/tables`,
    body: { tableId, name, permissions, rowSecurity: true },
  });
  const col = (table, type, spec) => ops.push({
    method: 'POST', path: `/tablesdb/${c.databaseId}/tables/${table}/columns/${type}`,
    body: spec,
  });
  const idx = (table, spec) => ops.push({
    method: 'POST', path: `/tablesdb/${c.databaseId}/tables/${table}/indexes`,
    body: spec,
  });
  const str = (key, size, required, def) => {
    const s = { key, size, required: !!required };
    if (def !== undefined) s.default = def;
    return s;
  };

  const usersReadCreate = ['read("users")', 'create("users")', 'update("users")', 'delete("users")'];
  // share_events: Append-only – Tabellen-Defaults enthalten bewusst KEIN
  // update/delete (Rows setzt die App bzw. die Guard-Function mit
  // read-only-Perms; eigene Rows löscht der Autor via Row-Perm).
  const eventsTablePerms = ['read("users")', 'create("users")'];

  // ---- Tabelle shares (Row-Security: Zeilen-Perms setzt die App, s. js/liveshare.js)
  t('shares', 'shares', usersReadCreate);
  col('shares', 'string', str('shareId', 36, true));
  col('shares', 'string', str('bookId', 36, true));
  col('shares', 'string', str('ownerId', 36, true));
  col('shares', 'string', str('ownerName', 64, false));
  col('shares', 'string', str('title', 160, false));
  col('shares', 'string', str('mode', 8, true));
  col('shares', 'string', str('pageId', 36, false));
  col('shares', 'datetime', { key: 'expiresAt', required: false });
  col('shares', 'boolean', { key: 'revoked', required: true, default: false });
  col('shares', 'string', str('snapshot', 65535, false));
  col('shares', 'datetime', { key: 'createdAt', required: true });
  col('shares', 'datetime', { key: 'updatedAt', required: true });
  idx('shares', { key: 'idx_shareId', type: 'unique', attributes: ['shareId'] });

  // ---- Tabelle share_events (Append-only)
  t('share_events', 'share_events', eventsTablePerms);
  col('share_events', 'string', str('shareId', 36, true));
  col('share_events', 'string', str('userId', 36, true));
  col('share_events', 'string', str('userName', 64, false));
  col('share_events', 'string', str('userColor', 16, false));
  col('share_events', 'string', str('kind', 16, true));
  col('share_events', 'string', str('payload', 65535, true));
  col('share_events', 'datetime', { key: 'createdAt', required: true });
  idx('share_events', { key: 'idx_shareId', type: 'key', attributes: ['shareId'] });

  return ops;
}

async function applyOp(c, op) {
  const r = await fetch(c.endpoint + op.path, {
    method: op.method,
    headers: {
      'X-Appwrite-Project': c.projectId,
      'X-Appwrite-Key': c.apiKey,
      'Content-Type': 'application/json',
    },
    body: op.body ? JSON.stringify(op.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const c = cfg();
  const ops = plan(c);

  console.log(`Endpoint: ${c.endpoint}\nProject:  ${c.projectId}\nDatabase: ${c.databaseId}\nOps: ${ops.length}\n`);

  if (!apply) {
    console.log('DRY-RUN – folgende Requests würden gesendet (mit --apply ausführen):\n');
    for (const op of ops) console.log(`${op.method} ${op.path}\n  ${JSON.stringify(op.body)}`);
    console.log('\nHinweis: APPWRITE_API_KEY ist nur für --apply nötig.');
    return;
  }
  if (!c.apiKey) {
    console.error('Fehler: APPWRITE_API_KEY fehlt. Beispiel:\n  APPWRITE_API_KEY=... node scripts/setup-liveshare.js --apply');
    process.exit(1);
  }
  let ok = 0, exists = 0, fail = 0;
  for (const op of ops) {
    let res;
    try {
      res = await applyOp(c, op);
    } catch (e) {
      console.log(`NETZFEHLER ${op.method} ${op.path}: ${e.message}`);
      fail++;
      continue;
    }
    if (res.status >= 200 && res.status < 300) { ok++; console.log(`OK ${res.status} ${op.method} ${op.path}`); }
    else if (res.status === 409) { exists++; console.log(`SKIP 409 (existiert) ${op.path} ${JSON.stringify(op.body).slice(0, 80)}`); }
    else { fail++; console.log(`FEHLER ${res.status} ${op.method} ${op.path}: ${JSON.stringify(res.body).slice(0, 300)}`); }
  }
  console.log(`\nFertig: ${ok} angelegt, ${exists} existierten, ${fail} Fehler.`);
  if (fail) process.exit(1);
  // Kleine Wartezeit: Appwrite braucht einen Moment, bis neue Columns schreibbar sind.
  console.log('Tipp: 30 s warten, dann in der App hosten (🔴 Live).');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { plan, cfg, DEFAULTS };
}
if (require.main === module) {
  main().catch(e => { console.error('Abgebrochen:', e.message); process.exit(1); });
}
