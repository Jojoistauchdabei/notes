# Federwerk MCP – Setup, Tools & Speicherformat

Diese Seite dokumentiert die beiden KI-Zugänge der Federwerk-Notiz-App:

- den **MCP-Server (JSON-RPC 2.0, 24 Tools)** für KI-Clients
  (Claude Desktop, Cursor, Opencode …) – er läuft lokal und liest/schreibt,
- das ältere **curl-API** (`mcp-server.js`, lesend) für Skripte, die nur ein
  Export-JSON haben.

Beides läuft **ohne Cloud**: der MCP spricht die API des eigenen Servers
(`server/`, siehe [SPEC-41](../specs/41-lxc-selbsthosting.md)).

## 0. Web-Routen

| Route | Inhalt | Für wen |
|---|---|---|
| `/agent` | `agent.html` – Einrichtung in drei Schritten, Beispiele, Warnungen | Nutzer (in der App verlinkt: ⚙ Server-Sync) |
| `/mcp` | `MCP_AI.md` als `text/markdown` – Installations- und Nutzungsanleitung | KI-Modelle (Adresse in den Chat kopierbar) |

Beide Adressen beantwortet der Node-Server selbst (`DOC_ALIAS` in
`server/index.js`); die Quell-Dateien `agent.html` und `MCP_AI.md` kopiert
`scripts/build-dist.js` nach `dist/`. Abgesichert über
`tests/doc-routes.test.js`.

## 1. Welcher Zugang wofür?

| Zugang | Protokoll | Tools | Wofür |
|---|---|---|---|
| `mcpserver/cli.js` | MCP (JSON-RPC 2.0, stdio/HTTP) | 24 (Anmeldung, lesen **+ schreiben**) | **Empfohlen**: KI arbeitet wie ein Mensch (Notizen, Ordner, Karteikarten, Suche, Graph) |
| `mcp-server.js` | REST per curl + Login | search/read/prompt (lesend) | Suche über ein Export-JSON (`--file`), ganz ohne Server |

## 2. Architektur

```text
mcpserver/index.js    Protokoll-Kern (Tools, Validierung, JSON-RPC) – keine Deps
mcpserver/backend.js  Handler gegen die Server-API (/api/docs, /api/folders)
mcpserver/content.js  Shared-Helfer: Markdown-lite, v1/v2-Envelope, SM-2,
                      Query-Suche, Wikilink-Graph – keine Deps, kein ../js/*
mcpserver/login.js    Credential-Store + Session (Cookie fw_session)
mcpserver/cli.js      stdio/HTTP-Transport; Backend = Server (mit Creds)
                      oder In-Memory-Demo (ohne Creds, volles Toolset)
```

Regel: **Nie `../js/*` aus `mcpserver/` requiren** – die App-Module brauchen ein
DOM. Geteilte Logik gehört nach `mcpserver/content.js` (ggf. als "lite"-Spiegel
von `js/*`, mit Quelle im Kommentar).

## 3. Setup

**So funktioniert es:** Der MCP bekommt die Login-Daten (E-Mail + Passwort)
und **holt sich die Session selbst** – beim Start und erneut bei 401. Die
Session ist das HttpOnly-Cookie `fw_session`, das der Server setzt. Ohne
Anmeldedaten läuft er als flüchtiges Demo-Backend.

Einmalig einrichten:

```bash
node mcpserver/login.js --email DU@BEISPIEL.DE --save
# Passwort wird interaktiv gefragt (weder History noch `ps`) und in
# ~/.config/federwerk/mcp-credentials.json (chmod 600, außerhalb des Repos)
# abgelegt. Ab jetzt genügt: node mcpserver/cli.js
```

Die Server-Adresse kommt aus `FEDERWERK_URL` (Standard
`http://127.0.0.1:8080`), entweder als Env oder in der Credential-Datei.

Passwort niemals als Tool-Argument übergeben – `login`/`logout` lesen nur aus
dem Store, damit es nicht im LLM-Kontext landet.

| Betriebsart | Env | Notes |
|---|---|---|
| **Anmeldung (empfohlen)** | `FEDERWERK_EMAIL`+`FEDERWERK_PASSWORD` oder Credential-Datei | MCP meldet sich selbst an, Re-Auth bei 401 |
| Fertige Session | `FEDERWERK_SESSION=<cookie-wert>` | Wert aus `login.js`; eine von außen gesetzte Session löscht `logout` **nicht** |

Logout: `node mcpserver/login.js --logout --session <cookie-wert>` oder das
`logout`-Tool (widerruft nur die Session, die der MCP selbst erzeugt hat).

> **Hinweis:** Der Server erlaubt beliebig viele parallele Sessions (eine Zeile
> in `sessions` je Anmeldung, Ablauf nach `FW_SESSION_DAYS`, Standard 90 Tage).
> Ein abgemeldetes Gerät verdrängt kein anderes.

### 3.1 Lokal per stdio (Claude Desktop / Cursor / Opencode)

Client-Config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "federwerk": {
      "command": "node",
      "args": ["/pfad/zu/notes/mcpserver/cli.js"],
      "env": {
        "FEDERWERK_URL": "http://127.0.0.1:8080",
        "FEDERWERK_EMAIL": "du@beispiel.de",
        "FEDERWERK_PASSWORD": "<passwort>"
      }
    }
  }
}
```

Ohne Credentials startet `cli.js` ein **In-Memory-Demo-Backend** (volles
Toolset, eine Demo-Notiz, Stand verfällt beim Beenden) – gut zum Üben, aber
Achtung: Es sieht "funktionierend" aus, liest/schreibt aber **keine echten
Notizen**. Der Server meldet beim Start auf stderr, welches Backend aktiv ist
(`Server-Backend als …` vs. `Demo-Backend`). Test:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcpserver/cli.js
```

Alternative HTTP: `node mcpserver/cli.js --http 3000` (POST JSON-RPC).

### 3.2 Anderer Rechner als der Server

Der MCP läuft dort, wo der Client läuft – auf dem Server ist nichts zu
installieren. Zeigt `FEDERWERK_URL` auf den LXC, ist `FEDERWERK_SESSION` der
einfachere Weg (dann bleibt das Passwort in der Credential-Datei des Rechners,
auf dem `login.js` gelaufen ist).

### 3.3 curl-API (`mcp-server.js`, lesend)

Ohne MCP-Client und ohne Server: liest ein Export-JSON.

```bash
node mcp-server.js --port 8787 --user jonas --pass geheim --token abc123 \
  --file Federwerk-Export.json
curl -s localhost:8787/mcp/tools
curl -s -X POST localhost:8787/mcp/search \
  -H 'Authorization: Bearer abc123' -H 'Content-Type: application/json' \
  -d '{"query":"steuer","limit":5}'
```

## 4. Tools (24)

Anmeldung: `session_info` (wer ist angemeldet, nie Passwörter), `login`,
`logout`.

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
`delete_document` (`id`; Tombstone wie der App-Sync – endgültig räumt der
Server-GC auf), `duplicate_document` (`id`, optional `title`; Karten-IDs
werden neu vergeben), `move_document` (`id`, `folderId`, leer = unsortiert).

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

## 5. Speicherformat (`docs.content`)

- **v1 (Notebooks, Bestand):** `{v:1, pages}` – unverändert kompakt.
- **v2 (Decks, MCP + App-Sync):** `{v:2, pages, kind:"flashcards", cards,
  deckOptions, reviewLog}`.
- **Immer inline:** Der Inhalt geht als JSON in die Zeile
  (`server/docs.js`). Die frühere Auslagerung großer Inhalte in eine Datei ist
  entfallen – SQLite kennt keine 64-KB-Grenze. Grenze: 8 MB pro Dokument
  (`MAX_CONTENT`), darüber ein klarer Fehler.
- **Limits:** Titel max 200 Zeichen, max 100 Karten/Aufruf,
  `get_document` kürzt Markdown (~8,5 KB, `truncated:true`) und Karten
  (max 200, `cardsTruncated:true`).
- **Gelöscht:** Tombstone (`deletedAt` gesetzt) – taucht in keiner Liste/Suche
  mehr auf; endgültig räumt `server/gc.js` auf.
- **Sync-Hinweis:** Der App-Sync (`js/sync.js`) persistiert v2 (Änderungs-
  erkennung inkl. Karten). Alte Clients lesen v2 (Seiten laden, Deckfelder
  ignorieren), schreiben sie aber ohne Deckfelder zurück – Clients möglichst
  **gemeinsam aktualisieren**, sonst können Karten verloren gehen.

## 6. Sicherheit

- `FEDERWERK_PASSWORD` und `FEDERWERK_SESSION` sind Secrets (nie committen,
  nie loggen; Passwort nur interaktiv in `login.js` tippen). Die Credential-
  Datei (`~/.config/federwerk/mcp-credentials.json`) gehört **nicht** ins Repo.
- Passwörter nie als Tool-Argument übergeben – sonst landen sie im
  LLM-Kontext (Prompt-Logs, History). `login` nutzt den Store.
- Der MCP handelt **immer als genau der angemeldete Nutzer**: jede Abfrage
  läuft über dessen Session-Cookie, fremde Notizen sind prinzipbedingt nicht
  erreichbar (die Nutzer-Datenbanken sind pro Nutzer getrennt,
  `server/db.js`). Es gibt keinen Admin-Key-Pfad mehr.
- Session läuft ab (`FW_SESSION_DAYS`, Standard 90 Tage) → erneut
  `node mcpserver/login.js`; sofort entziehen mit `--logout`.
- Der lokale Server (`mcp-server.js`) vergleicht den Bearer timing-sicher
  (`timingSafeEqual`), hat ein Login-Rate-Limit und bindet standardmäßig an
  `127.0.0.1` (`--host` ändert das bewusst).

## 7. Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Nur Demo-Notiz sichtbar | Keine Anmeldedaten → Demo-Backend (Startmeldung auf stderr beachten); `node mcpserver/login.js --email … --save` |
| `Server nicht erreichbar` | `FEDERWERK_URL` falsch oder Dienst steht nicht (`systemctl status federwerk`, `curl /api/health`) |
| `Nicht angemeldet` (401) | Session abgelaufen oder Cookie widerrufen → `login.js` erneut ausführen |
| `Login fehlgeschlagen` | E-Mail/Passwort falsch; der Server antwortet absichtlich gleich bei unbekannter Adresse |
| Leere Suche am lokalen curl-Server | `--file` fehlt oder Pfad falsch (Log: "nicht lesbar") |
| Karten nach Sync weg | Alter Client ohne v2-Support hat zurückgeschrieben → Clients aktualisieren (Kap. 5) |
| `Document is not a deck` | Karten-Tool auf Notebook aufgerufen; `kind`-Filter in `list_documents` nutzen |
| `Inhalt zu groß` | Dokument über 8 MB – Inhalt teilen oder als Datei ablegen |

## 8. Weiterentwickeln

- Neue Tools: Schema in `mcpserver/index.js` + Handler in
  `mcpserver/backend.js`; reine Logik nach `mcpserver/content.js`.
- Tests: `npm test` (gesamt), `npm run test:mcp` (MCP-Kern + Demo-Backend),
  `tests/mcp-server-backend.test.js` (Handler gegen eine In-Memory-API).
- Live-Test gegen den eigenen Server (schreibend, räumt selbst auf):
  `create_folder` → `create_document` → `create_deck` + `review_card` →
  Suche/Graph → alles löschen. Danach prüfen, dass keine Zeilen mit dem
  Test-Präfix übrig sind, und die Session per `--logout` beenden.
