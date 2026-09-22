# @federwerk/mcpserver

Stateless Model Context Protocol (MCP) server core for Federwerk notes.

This package implements the JSON-RPC 2.0 MCP protocol specifications and can run:
1. As the protocol engine inside the Appwrite Function (`mcp/index.js`)
2. As a standalone local MCP server over `stdio` (for Claude Desktop, Cursor, Antigravity, etc.)
3. As a local HTTP server (`--http [port]`)

## Available Tools

- `list_documents`: Lists documents for the authenticated user (supports `limit` and optional `folderId`).
- `get_document`: Retrieves a document by its ID (including full text content).
- `list_folders`: Retrieves the folder hierarchy.
- `search_documents`: Fulltext search across titles and notes content.

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
        "APPWRITE_API_KEY": "<your-secret-api-key>",
        "APPWRITE_USER_ID": "<your-appwrite-user-id>"
      }
    }
  }
}
```

### HTTP Transport

```bash
node mcpserver/cli.js --http 3000
```
