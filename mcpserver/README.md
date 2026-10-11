# @federwerk/mcpserver

> Vollständige Doku (Setup, alle 24 Tools, Speicherformat, Fehlerbilder):
> [`docs/mcp.md`](../docs/mcp.md).

Stateless Model Context Protocol (MCP) server core for Federwerk notes.

Dieses Paket ist die Protokoll-Engine (JSON-RPC 2.0) und läuft lokal:

1. über `stdio` (`node mcpserver/cli.js`) – für Claude Desktop, Cursor usw.,
2. als lokaler HTTP-Server (`node mcpserver/cli.js --http [port]`),
3. in den Tests (In-Memory-Backends, siehe `tests/mcpserver.test.js`).

Aufbau:

| Datei | Aufgabe |
| --- | --- |
| `index.js` | Protokoll + Tool-Definitionen (24 Tools); fachfrei |
| `backend.js` | Handler gegen die eigene Server-API (`/api/docs`, `/api/folders`) |
| `content.js` | Markdown-lite, v1/v2-Content-Envelope, SM-2, Query-Suche, Wikilink-Graph |
| `login.js` | Credential-Store + Session-Cookie (`fw_session`) |
| `cli.js` | Transport (stdio/HTTP) und Backend-Wahl |

`content.js` ist bewusst selbst-contained und wird von `backend.js` und den
Tests gemeinsam benutzt; `../js/*` wird von hier **nie** `require()`d (die
App-Module brauchen ein DOM).

## Available Tools (24)

Lesen:
- `list_documents` (+ `kind`-Filter `notebook|flashcards`), `get_document`
  (mit Markdown + bei Decks Karten), `list_folders`, `search_documents`
  (Substring inkl. Karten), `advanced_search` (Query-Sprache: `OR`,
  `-Negation`, `"Phrasen"`, `file:/path:/tag:/task:/task-todo:/task-done:`),
  `get_graph` (Wikilinks `[[...]]`, optional lokaler Subgraph `id`+`depth`).
Notizen wie ein Mensch: `create_document` (Markdown default),
`update_document` (`append:true` hängt an), `delete_document`
(Tombstone – endgültig räumt der Server-GC auf), `duplicate_document`,
`move_document`.
Ordner: `create_folder` (optional `parentId`), `rename_folder`,
`delete_folder` (Dokumente wandern nach `moveDocumentsTo`, default unsortiert).
Karteikarten (SM-2, kompatibel zu `js/flashcards.js`): `create_deck`
(optional mit `cards[]`), `list_cards` (`all|due|new`), `add_cards`
(max 100/Aufruf), `update_card`, `delete_card`, `review_card`
(`again|hard|good|easy`), `deck_stats` (Bestände, Accuracy, 7-Tage-Vorschau, Streak).

Decks liegen als Content-Envelope v2 (`{v:2, pages, kind, cards, deckOptions,
reviewLog}`) in `docs.content`; Bestand (v1, nur `pages`) bleibt lesbar. Der
Inhalt geht **immer inline** in die Zeile – der eigene Server kennt keine
64-KB-Grenze, die frühere Auslagerung in eine Datei ist entfallen.

## Local Usage

### Stdio Transport (Claude Desktop / Cursor)

```bash
node mcpserver/login.js --email DU@BEISPIEL.DE --save   # einmalig
node mcpserver/cli.js                                   # danach genügt das
```

`login.js` fragt das Passwort interaktiv und legt es in
`~/.config/federwerk/mcp-credentials.json` (chmod 600, außerhalb des Repos) ab.

Ohne Credential-Datei (Container, CI) geht es über die Umgebung:

```json
{
  "mcpServers": {
    "federwerk": {
      "command": "node",
      "args": ["/path/to/notes/mcpserver/cli.js"],
      "env": {
        "FEDERWERK_URL": "http://127.0.0.1:8080",
        "FEDERWERK_EMAIL": "<ADRESSE>",
        "FEDERWERK_PASSWORD": "<PASSWORT>"
      }
    }
  }
}
```

Statt E-Mail/Passwort geht auch ein fertiger Cookie-Wert:
`FEDERWERK_SESSION=<wert>` (aus `node mcpserver/login.js --email …`).

### HTTP Transport

```bash
node mcpserver/cli.js --http 3000
```

Ohne `FEDERWERK_*` startet der Server mit einem flüchtigen In-Memory-Backend
(Demo-Notiz) – gedacht zum Ausprobieren, nicht für echte Daten.
