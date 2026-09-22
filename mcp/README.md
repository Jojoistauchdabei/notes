# Federwerk MCP Appwrite Function

This directory contains the Appwrite Function entry point for Federwerk's Model Context Protocol (MCP) server. It enables AI assistants (Claude, Cursor, Antigravity, etc.) to securely query notes, folders, and documents stored in Federwerk's Appwrite TablesDB.

## Architecture

- **`mcpserver/`**: Core MCP protocol logic (JSON-RPC 2.0, standard tool schema, stdio transport runner).
- **`mcp/`**: Appwrite Function adapter (HTTP context handler, authentication, TablesDB REST client, file offload resolver).

## Tools Provided

1. `list_documents`: Returns note documents for the authenticated user (supports `limit` and `folderId` filters; automatically filters out deleted tombstones).
2. `get_document`: Retrieves a note by ID, automatically resolving offloaded storage content (>40 KB).
3. `list_folders`: Returns the user's folder hierarchy.
4. `search_documents`: Performs search across document titles and note content.

## Setup & Deployment on Appwrite

### 1. Create the Appwrite Function

- **Runtime**: Node.js 22 (or Node.js 20)
- **Entrypoint**: `mcp/index.js` (or `index.js` if deploying the directory root)
- **Execute Access**: Any (or Restricted with secret API key)

### 2. Configure Environment Variables

Set the following environment variables in the Appwrite Console under **Function Settings > Variables**:

| Variable | Description | Example / Default |
|---|---|---|
| `APPWRITE_ENDPOINT` | Appwrite REST endpoint URL | `https://fra.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | Your Appwrite project ID | `6ab0067c00244c28560a` |
| `APPWRITE_DATABASE_ID` | Database ID | `federwerk` |
| `APPWRITE_NOTES_TABLE_ID`| Table for notes | `notes` |
| `APPWRITE_FOLDERS_TABLE_ID`| Table for folders | `folders` |
| `APPWRITE_BUCKET_ID` | Storage bucket for attachments | `attachments` |
| `APPWRITE_API_KEY` | Server API key (Database read permissions) | `<appwrite-secret-api-key>` |
| `APPWRITE_USER_ID` | Appwrite User ID whose notes are served | `<user-id>` |
| `MCP_TOKEN` | Bearer token for client authentication | `<random-secret-token>` |

> **Security Note**: Never expose `APPWRITE_API_KEY` or `MCP_TOKEN`. When `MCP_TOKEN` is configured, all requests require `Authorization: Bearer <MCP_TOKEN>` or `X-MCP-Token: <MCP_TOKEN>`.

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
