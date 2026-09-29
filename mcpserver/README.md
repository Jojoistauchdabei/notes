# @federwerk/mcpserver

> Vollständige Doku (Setup, alle 21 Tools, Speicherformat, Troubleshooting):
> [`docs/mcp.md`](../docs/mcp.md).

Stateless Model Context Protocol (MCP) server core for Federwerk notes.

This package implements the JSON-RPC 2.0 MCP protocol specifications and can run:
1. As the protocol engine inside the Appwrite Function (`mcp/index.js`)
2. As a standalone local MCP server over `stdio` (for Claude Desktop, Cursor, Antigravity, etc.)
3. As a local HTTP server (`--http [port]`)

Shared helpers: `content.js` (Markdown-lite, v1/v2 content envelope, SM-2,
query search, wikilink graph – dependency-free, also bundled into the
Appwrite Function via `npm run build:mcp`). Never `require()` `../js/*`
from here – the Function package contains only `mcp/` + `mcpserver/`.

## Available Tools (21)

Lesen:
- `list_documents` (+ `kind`-Filter `notebook|flashcards`), `get_document`
  (mit Markdown + bei Decks Karten), `list_folders`, `search_documents`
  (Substring inkl. Karten), `advanced_search` (Query-Sprache: `OR`,
  `-Negation`, `"Phrasen"`, `file:/path:/tag:/task:/task-todo:/task-done:`),
  `get_graph` (Wikilinks `[[...]]`, optional lokaler Subgraph `id`+`depth`).
Notizen wie ein Mensch: `create_document` (Markdown default),
`update_document` (`append:true` hängt an), `delete_document`
(Tombstone default, `permanent:true` löscht die Row),
`duplicate_document`, `move_document`.
Ordner: `create_folder` (optional `parentId`), `rename_folder`,
`delete_folder` (Dokumente wandern nach `moveDocumentsTo`, default unsortiert).
Karteikarten (SM-2, kompatibel zu `js/flashcards.js`): `create_deck`
(optional mit `cards[]`), `list_cards` (`all|due|new`), `add_cards`
(max 100/Aufruf), `update_card`, `delete_card`, `review_card`
(`again|hard|good|easy`), `deck_stats` (Bestände, Accuracy, 7-Tage-Vorschau, Streak).

Decks liegen als Content-Envelope v2 (`{v:2, pages, kind, cards,
deckOptions, reviewLog}`) in `notes.content` (>40 KB automatisch als
JSON-Datei im Bucket, wie der App-Sync). Bestand (v1, nur `pages`) bleibt
lesbar. Der App-Sync (`js/appwrite-sync.js`) persistiert v2 ebenfalls
(Änderungserkennung inkl. Karten); Migrationshinweis (einmaliger
Full-Push): `docs/mcp.md` Kap. 5.

## Local Usage

### Stdio Transport (Claude Desktop / Cursor)

```bash
node mcpserver/cli.js
```

Configure in Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "federwerk": {
      "command": "node",
      "args": ["/path/to/notes/mcpserver/cli.js"],
      "env": {
        "APPWRITE_ENDPOINT": "https://fra.cloud.appwrite.io/v1",
        "APPWRITE_PROJECT_ID": "6ab0067c00244c28560a",
        "APPWRITE_SESSION": "<session-secret-aus-login>",
        "APPWRITE_USER_ID": "<your-appwrite-user-id>"
      }
    }
  }
}
```

Session erzeugen: `node mcpserver/login.js --email DU@BEISPIEL.DE`
(`APPWRITE_USER_ID` wird auch daraus abgeleitet und ist optional).

### HTTP Transport

```bash
node mcpserver/cli.js --http 3000
```
