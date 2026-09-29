# Federwerk MCP Appwrite Function

> Vollständige Doku (Setup, alle 21 Tools, Speicherformat, Troubleshooting):
> [`docs/mcp.md`](../docs/mcp.md).

This directory contains the Appwrite Function entry point for Federwerk's Model Context Protocol (MCP) server. It enables AI assistants (Claude, Cursor, Antigravity, etc.) to securely query notes, folders, and documents stored in Federwerk's Appwrite TablesDB.

## Architecture

- **`mcpserver/`**: Core MCP protocol logic (JSON-RPC 2.0, standard tool schema, stdio transport runner).
- **`mcp/`**: Appwrite Function adapter (HTTP context handler, authentication, TablesDB REST client, file offload resolver).

## Tools Provided (21, lesend + schreibend)

Lesen: `list_documents` (mit `limit`, `folderId`, `kind`), `get_document`
(inkl. Markdown und – bei Decks – Karten), `list_folders`,
`search_documents` (Titel + Inhalt + Karten), `advanced_search`
(Query-Sprache), `get_graph` (Wikilinks).

Schreiben wie ein Mensch: `create_document`, `update_document`
(`append:true`), `delete_document` (Tombstone / `permanent:true`),
`duplicate_document`, `move_document`, `create_folder`, `rename_folder`,
`delete_folder`, `create_deck`, `list_cards`, `add_cards`, `update_card`,
`delete_card`, `review_card` (SM-2), `deck_stats`.

Details + Speicherformat (v1/v2-Envelope, Offload, Limits):
`mcpserver/README.md`. Ohne Credentials läuft `mcpserver/cli.js` mit einem
In-Memory-Demo-Backend (volles Toolset, Stand verfällt beim Beenden) –
gut zum Üben von Abläufen ohne Cloud.

## Setup & Deployment on Appwrite

### 1. Create the Appwrite Function

- **Runtime**: Node.js 22 (or Node.js 20)
- **Entrypoint**: `mcp/index.js` (or `index.js` if deploying the directory root)
- **Execute Access**: Any (or Restricted with secret API key)

### 2. Configure Environment Variables

Empfohlen (ohne API-Key): einmalig `node mcpserver/login.js --email DU@BEISPIEL.DE`
(Passwort-Abfrage interaktiv), dann `APPWRITE_SESSION` übernehmen –
`APPWRITE_USER_ID` wird aus der Session abgeleitet. Alternativ Key-Modus
(`APPWRITE_API_KEY` + Pflicht-`APPWRITE_USER_ID`).

Set the following environment variables in the Appwrite Console under **Function Settings > Variables**:

| Variable | Description | Example / Default |
|---|---|---|
| `APPWRITE_ENDPOINT` | Appwrite REST endpoint URL | `https://fra.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | Your Appwrite project ID | `6ab0067c00244c28560a` |
| `APPWRITE_DATABASE_ID` | Database ID | `federwerk` |
| `APPWRITE_NOTES_TABLE_ID`| Table for notes | `notes` |
| `APPWRITE_FOLDERS_TABLE_ID`| Table for folders | `folders` |
| `APPWRITE_BUCKET_ID` | Storage bucket for attachments | `attachments` |
| `APPWRITE_SESSION` | User session secret from `node mcpserver/login.js` (recommended, no API key needed) | `<session-secret>` |
| `APPWRITE_API_KEY` | Server API key (alternative to session) | `<appwrite-secret-api-key>` |
| `APPWRITE_USER_ID` | Appwrite User ID (auto-resolved from session; mandatory with API key) | `<user-id>` |
| `MCP_TOKEN` | Bearer token for client authentication | `<random-secret-token>` |

> **Security Note**: Never expose `APPWRITE_SESSION`, `APPWRITE_API_KEY` or
> `MCP_TOKEN`. Session mode is inherently user-scoped; with API key mode set
> **`APPWRITE_USER_ID`** – **without that scope, anyone holding `MCP_TOKEN`
> can read every user's notes** (only safe for single-user deployments).

> **User scoping**: Im Session-Modus serviert die Function nur den
> eingeloggten Nutzer (empfohlen). Im Key-Modus ist `APPWRITE_USER_ID`
> Pflicht-Scope. Der Cloudflare Worker (`worker.js`, Routen
> `POST /mcp/search|read|prompt`) hat dasselbe statische `MCP_TOKEN`-Design,
> liest aber mit Admin-Key: dort `MCP_USER_ID` (oder `APPWRITE_USER_ID`) als
> Worker-Secret setzen. **Ohne Scope liest jeder `MCP_TOKEN`-Inhaber alle
> Notizen** – nur für Single-User-Deployments ok.

### 3. Deploy via Appwrite CLI

From the repository root:

```bash
# If using appwrite CLI with appwrite.json configured:
appwrite deploy function
```

Alternatively, archive `mcp` and `mcpserver` together and upload via the Appwrite Console.

## Connecting Clients

### HTTP / JSON-RPC Endpoint

Send POST requests to your Appwrite Function domain/URL:

```bash
curl -X POST https://fra.cloud.appwrite.io/v1/functions/<FUNCTION_ID>/executions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <MCP_TOKEN>" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

### Local Testing & Development

You can test the MCP server locally without deploying:

```bash
# Test with stdio (e.g. for Claude Desktop):
node mcpserver/cli.js

# Test over local HTTP:
node mcpserver/cli.js --http 3000
```
