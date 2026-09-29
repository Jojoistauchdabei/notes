# Federwerk MCP – Setup, Tools & Speicherformat

Diese Seite dokumentiert beide MCP-Zugänge der Federwerk-Notiz-App:
den **echten MCP-Server (JSON-RPC 2.0, 21 Tools)** für KI-Clients und das
ältere **curl-API (`/mcp/*`, lesend)** auf Worker/lokalem Server.

## 1. Welcher Zugang wofür?

| Zugang | Protokoll | Tools | Wofür |
|---|---|---|---|
| `mcpserver/` + `mcp/` | MCP (JSON-RPC 2.0, stdio/HTTP) | 21 (lesen **+ schreiben**) | **Empfohlen**: Claude Desktop, Cursor, Opencode – KI arbeitet wie ein Mensch (Notizen, Ordner, Karteikarten, Suche, Graph) |
| `worker.js` (`/mcp/*`) | REST per curl + Bearer | search/read/prompt (lesend) | Cloud-Suche ohne MCP-Client, Prompt-Beantwortung aus Appwrite |
| `mcp-server.js` | REST per curl + Login | search/read/prompt (lesend) | Lokale Suche über Export-JSON (`--file`), ohne Cloud |

## 2. Architektur (eine Quelle, drei Laufzeiten)

```text
mcpserver/index.js    Protokoll-Kern (Tools, Validierung, JSON-RPC) – keine Deps
mcpserver/content.js  Shared-Helfer: Markdown-lite, v1/v2-Envelope, SM-2,
                      Query-Suche, Wikilink-Graph – keine Deps, kein ../js/*
mcp/index.js          Appwrite-Backend ( spreading Rows + Storage-Offload)
mcpserver/cli.js      stdio/HTTP-Transport; Backend = Appwrite (mit Creds)
                      oder In-Memory-Demo (ohne Creds, volles Toolset)
scripts/build-mcp.js  spiegelt mcpserver/* nach mcp/* + baut dist/mcp-function.tar.gz
```

Regel: **Nie `../js/*` aus `mcp/`/`mcpserver/` requiren** – die Appwrite
Function enthält nur diese zwei Verzeichnisse. Geteilte Logik gehört nach
`mcpserver/content.js` (ggf. als "lite"-Spiegel von `js/*`, mit Quelle im
Kommentar). Nach Änderungen an `mcpserver/` immer `npm run build:mcp`
laufen lassen (Duplikat-Sync + Paket).

## 3. Setup

**Empfohlen (ohne API-Key):** Der Server loggt sich als dein Appwrite-Benutzer
per Session ein – kein Key aus der Console nötig, und fremde Notizen sind
prinzipbedingt unerreichbar (sicherer als Admin-Key + Filter). Einmalig:

```bash
node mcpserver/login.js --email DU@BEISPIEL.DE
# fragt das Passwort interaktiv (weder History noch `ps`), gibt aus:
#   APPWRITE_SESSION=<secret>
#   APPWRITE_USER_ID=<id>
```

`APPWRITE_SESSION` in die MCP-Umgebung übernehmen (`APPWRITE_USER_ID` ist
optional – wird aus der Session abgeleitet). Logout:
`node mcpserver/login.js --logout` (oder Console → Auth → Users → Sessions).
Läuft die Session ab, einfach erneut einloggen.

Alternative (Server-Admins): `APPWRITE_API_KEY` + Pflicht-Scope
`APPWRITE_USER_ID` – dann handelt der Server mit Admin-Rechten.

### 3.1 Lokal per stdio (Claude Desktop / Cursor / Opencode)

```bash
export APPWRITE_ENDPOINT="https://fra.cloud.appwrite.io/v1"
export APPWRITE_PROJECT_ID="6ab0067c00244c28560a"
export APPWRITE_DATABASE_ID="federwerk"
export APPWRITE_NOTES_TABLE_ID="notes"
export APPWRITE_FOLDERS_TABLE_ID="folders"
export APPWRITE_BUCKET_ID="attachments"
export APPWRITE_SESSION="<secret-aus-login>"   # statt API-Key (empfohlen)
# Alternativ: export APPWRITE_API_KEY="<key>" + APPWRITE_USER_ID="<id>"
export MCP_TOKEN="<random-token>"
```

Client-Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "federwerk": {
      "command": "node",
      "args": ["/pfad/zu/notes/mcpserver/cli.js"],
      "env": {
        "APPWRITE_ENDPOINT": "https://fra.cloud.appwrite.io/v1",
        "APPWRITE_PROJECT_ID": "6ab0067c00244c28560a",
        "APPWRITE_SESSION": "<secret-aus-login>",
        "APPWRITE_USER_ID": "<appwrite-user-id>"
      }
    }
  }
}
```

Ohne Credentials startet `cli.js` ein **In-Memory-Demo-Backend** (volles
Toolset, eine Demo-Notiz, Stand verfällt beim Beenden) – gut zum Üben, aber
Achtung: Es sieht "funktionierend" aus, liest/schreibt aber **keine echten
Notizen**. Der Server meldet beim Start auf stderr, welches Backend aktiv
ist (`Cloud-Backend als Nutzer …` vs. `Demo-Backend`). Test:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcpserver/cli.js
```

Alternative HTTP: `node mcpserver/cli.js --http 3000` (POST JSON-RPC).

### 3.2 Appwrite Function (Cloud)

- Runtime: Node.js 20/22, Entrypoint `mcp/index.js` (Verzeichnis-Deploy:
  `mcp/` + `mcpserver/` gemeinsam, oder `npm run build:mcp` und
  `dist/mcp-function.tar.gz` hochladen).
- Env-Vars: `APPWRITE_*`-Basis wie 3.1 plus **entweder** `APPWRITE_SESSION`
  (empfohlen, `APPWRITE_USER_ID` optional) **oder** `APPWRITE_API_KEY` +
  Pflicht-`APPWRITE_USER_ID`; `MCP_TOKEN` empfohlen. Ohne `MCP_TOKEN` ist die
  Function offen lesbar!
- Session-Modus: Die Function serviert **nur** den eingeloggten Nutzer.
  Key-Modus: `APPWRITE_USER_ID` ist Pflicht-Scope – ohne ihn liest jeder
  Token-Inhaber alle Notizen (nur für Single-User-Deployments ok).

### 3.3 Cloudflare Worker (`worker.js`, Legacy-curl, lesend)

Secrets: `MCP_USER`, `MCP_PASS`, `MCP_TOKEN`; für echte Suche zusätzlich
`APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`, `APPWRITE_DATABASE_ID`,
`APPWRITE_API_KEY` plus Single-User-Scope `MCP_USER_ID` (oder
`APPWRITE_USER_ID`). Ohne Appwrite antwortet die API mit 503.

```bash
curl -s https://<worker>/mcp/health
curl -s -X POST https://<worker>/mcp/login \
  -H 'Content-Type: application/json' -d '{"user":"...","pass":"..."}'
curl -s -X POST https://<worker>/mcp/search \
  -H "Authorization: Bearer <TOKEN>" -H 'Content-Type: application/json' \
  -d '{"query":"Vokabeln","limit":5}'
```

### 3.4 Lokaler curl-Server (`mcp-server.js`, lesend)

```bash
node mcp-server.js --port 8787 --user jonas --pass geheim \
  --token abc123 --file grimoire-export.json
curl -s -X POST http://127.0.0.1:8787/mcp/prompt \
  -H "Authorization: Bearer abc123" -H 'Content-Type: application/json' \
  -d '{"prompt":"Was steht zu Vokabeln drin?"}'
```

Ohne `--file`: leere Trefferliste (kein Fehler). Ohne `--pass`: Login-503.

## 4. Tool-Referenz (MCP, 21 Tools)

Lesen: `list_documents` (`limit`, `folderId`, `kind: notebook|flashcards`),
`get_document` (`id` → Markdown + bei Decks Karten), `list_folders`,
`search_documents` (`query` inkl. Kartentexten → `{id,title,snippet}`),
`advanced_search` (Query-Sprache SPEC-07 light: `A OR B`, `-Ausschluss`,
`"Phrasen"`, `file:/path:/tag:/task:/task-todo:/task-done:`; Scoring
Titel 10 > Tag 5 > Task 3 > Text 1), `get_graph` (`[[Wikilinks]]`; mit
`id` + `depth` 0–3 lokaler Subgraph).

Schreiben (wie ein Mensch im Editor):
`create_document` (`title` Pflicht; `content` Markdown default,
`contentFormat: markdown|html|text`; `folderId`; `kind`),
`update_document` (`id` + optional `title/content/folderId`;
`append:true` hängt als neue Textbox an statt zu ersetzen),
`delete_document` (`id`; default Tombstone wie der App-Sync,
`permanent:true` löscht die Row), `duplicate_document` (`id`, optional
`title`; Karten-IDs werden neu vergeben), `move_document` (`id`,
`folderId`, leer = unsortiert).

Ordner: `create_folder` (`name`, optional `parentId`), `rename_folder`,
`delete_folder` (enthaltene Dokumente wandern nach `moveDocumentsTo`,
default unsortiert; Anzahl in `documentsMoved`).

Karteikarten (SM-2, gleiche Formeln wie `js/flashcards.js`):
`create_deck` (`title`, optional `folderId`, `cards: [{front,back}]`),
`list_cards` (`deckId`, `filter: all|due|new`), `add_cards`
(max 100/Aufruf), `update_card` (`front/back/suspended`),
`delete_card`, `review_card` (`grade: again|hard|good|easy` → aktualisierte
Karte + Intervall-Vorschau), `deck_stats` (Bestände, Accuracy, Leeches,
7-Tage-Vorschau, Streak).

Beispiel-Session (JSON-RPC, je Zeile ein Request):

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_deck","arguments":{"title":"Vokabeln","cards":[{"front":"Haus","back":"maison"}]}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"review_card","arguments":{"deckId":"<id>","cardId":"<id>","grade":"good"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"deck_stats","arguments":{"deckId":"<id>"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"advanced_search","arguments":{"query":"tag:vokabeln -done"}}}
```

Fehler sind JSON-RPC-Fehler (`-32000` mit Klartext, z. B.
`Document not found`, `Folder not found`, `Card not found`,
`Document is not a deck`, `grade muss again|hard|good|easy sein`).
Unbekannte `folderId` werden beim Schreiben abgelehnt (nichts wird
"verloren" in nicht-existente Ordner gelegt).

## 5. Speicherformat (Appwrite `notes.content`)

- **v1 (Notebooks, Bestand):** `{v:1, pages}` – unverändert kompakt.
- **v2 (Decks, MCP + App-Sync):** `{v:2, pages, kind:"flashcards", cards,
  deckOptions, reviewLog}`.
- **Offload:** Content > 40 KB liegt als JSON-Datei im Bucket
  (`content=""`, `contentFileId="fw<sha256>"`, Dedupe per Datei-ID).
- **Limits:** Titel max 200 Zeichen, ein Schreibvorgang max ~200 KB,
  max 100 Karten/Aufruf, `get_document` kürzt Markdown (~8,5 KB,
  `truncated:true`) und Karten (max 200, `cardsTruncated:true`).
- **Gelöscht:** Tombstone (`title:"(gelöscht)"`, `deletedAt` gesetzt) –
  taucht in keiner Liste/Suche mehr auf; `permanent:true` entfernt die Row.
- **Sync-Hinweis:** Der App-Sync (`js/appwrite-sync.js`) persistiert v2
  seit dem Deck-Fix (Änderungserkennung inkl. Karten). Der **erste Sync
  nach dem Update schiebt jedes Buch einmal hoch** (einmalige
  Hash-Migration). Alte Clients lesen v2 (Seiten laden, Deckfelder
  ignorieren), schreiben sie aber ohne Deckfelder zurück – Clients
  möglichst **gemeinsam aktualisieren**, sonst können Karten verloren gehen.

## 6. Sicherheit

- `APPWRITE_SESSION`, `APPWRITE_API_KEY` + `MCP_TOKEN` sind Secrets
  (nie committen, nie loggen; Passwort nur interaktiv in `login.js` tippen).
- Session läuft ggf. ab → erneut `node mcpserver/login.js`; bei Verlust per
  `--logout` oder in der Console (Auth → Users → Sessions) entziehen.
- Login-Rate-Limit: max 8 Versuche / 10 Min (Worker + lokaler Server).
- Bearer-Pflicht für alle schreibenden/lesenden MCP-Routen außer
  `health`/`tools`; `OPTIONS`/CORS nur opt-in (`MCP_ALLOW_ORIGIN`).
- Mehrnutzer-Deployments: Session-Modus ist pro Nutzer gescopet (empfohlen).
  Key-Modus: `APPWRITE_USER_ID`-Scope setzen (Function + Worker) – sonst
  liest ein Token alle Nutzer.

## 7. Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Nur Demo-Notiz sichtbar | Weder Key noch Session gesetzt → Demo-Backend aktiv (Startmeldung auf stderr beachten); `node mcpserver/login.js` + Env setzen |
| `Unauthorized` (401) | `MCP_TOKEN` falsch/fehlend; Header `Authorization: Bearer …` prüfen |
| `APPWRITE_API_KEY oder APPWRITE_SESSION erforderlich` (500) | Function-/Server-Env unvollständig |
| `Session ungültig oder abgelaufen` | Erneut `node mcpserver/login.js` |
| Leere Suche am lokalen Server | `--file` fehlt oder Pfad falsch (Log: "nicht lesbar") |
| 503 am Worker | Secrets (`MCP_USER/MCP_PASS/MCP_TOKEN`) oder Appwrite-Config fehlen |
| Karten nach Sync weg | Alter Client ohne v2-Support hat zurückgeschrieben → Clients aktualisieren (Kap. 5) |
| `Document is not a deck` | Karten-Tool auf Notebook aufgerufen; `kind`-Filter in `list_documents` nutzen |

## 8. Weiterentwickeln

- Neue Tools: Schema in `mcpserver/index.js` + Handler-Slot, Logik nach
  `mcpserver/content.js` (rein) oder Adapter (`mcp/index.js`,
  `mcpserver/cli.js`), Tests in `tests/mcp-write.test.js`,
  dann `npm run build:mcp` + `npm test`.
- Tests: `npm test` (gesamt), `npm run test:mcp` (MCP-Kern + Function).
