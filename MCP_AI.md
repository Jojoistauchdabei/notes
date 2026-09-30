# Federwerk MCP – Installations- und Nutzungsanleitung für KI-Modelle

> **Für ein Sprachmodell:** Diese Datei ist die vollständige Anleitung, um den
> Federwerk-MCP-Server zu installieren, anzumelden und zu benutzen. Sie wird
> unter `/mcp` als `text/markdown` ausgeliefert. Nutzer-facing Doku (deutsch)
> steht unter `/agent` bzw. `docs/mcp.md`.

Federwerk ist eine offline-first Handschrift-Notizbuch-App. Der MCP-Server
liest **und schreibt** in den Notizen des angemeldeten Benutzers: Notizen,
Ordner, Karteikarten-Decks (SM-2), Volltext-/Query-Suche und Wikilink-Graph.

## 1. Steckbrief

| | |
|---|---|
| Protokoll | MCP / JSON-RPC 2.0, `protocolVersion` 2024-11-05 |
| Servername | `federwerk-appwrite` v1.1.0 |
| Tools | 24 (3 Login + 6 Lesen + 5 Notizen + 3 Ordner + 7 Karteikarten) |
| Transports | `stdio` (empfohlen), HTTP (`--http <port>`) |
| Backend | Appwrite (Cloud) oder flüchtiges In-Memory-Demo |
| Anmeldung | E-Mail + Passwort → Session (Cookie) wird vom Server selbst erzeugt |
| Abhängigkeiten | keine (Node.js ≥ 18 reicht) |

**Wichtig:** Der Server braucht **keinen API-Key**. Er meldet sich mit
E-Mail/Passwort an und leitet die Session selbst ab. Die Notizen anderer
Benutzer sind für ihn prinzipbedingt nicht erreichbar.

## 2. Installation

```bash
git clone <repo-url> federwerk && cd federwerk
node mcpserver/login.js --email <ADRESSE> --save
```

`login.js` fragt das Passwort interaktiv (nicht in Shell-History, nicht in
`ps`) und legt es in `~/.config/federwerk/mcp-credentials.json` (chmod 600,
außerhalb des Repos) ab. Danach genügt ein Start:

```bash
node mcpserver/cli.js            # stdio
node mcpserver/cli.js --http 3000  # HTTP
```

Auf stderr meldet der Server, welches Backend aktiv ist:

```
Federwerk MCP: Cloud-Backend als Nutzer <userId> (angemeldet).
```

`Demo-Backend (flüchtig)` heißt: keine Anmeldedaten gefunden – es wird nur
eine flüchtige Demo-Notiz angezeigt. **Nicht** mit echten Daten arbeiten,
sonst `login.js` ausführen.

### 2.1 Client-Konfiguration

Claude Desktop (`claude_desktop_config.json`), Cursor oder jeder
stdio-fähige MCP-Client:

```json
{
  "mcpServers": {
    "federwerk": {
      "command": "node",
      "args": ["/pfad/zu/federwerk/mcpserver/cli.js"]
    }
  }
}
```

Für den Betrieb **ohne** Credential-Datei (z. B. Container, CI):

```json
{
  "mcpServers": {
    "federwerk": {
      "command": "node",
      "args": ["/pfad/zu/federwerk/mcpserver/cli.js"],
      "env": {
        "APPWRITE_EMAIL": "<ADRESSE>",
        "APPWRITE_PASSWORD": "<PASSWORT>"
      }
    }
  }
}
```

> **Regel für KI-Modelle:** Das Passwort gehört **ausschließlich** in die
> Client-Config bzw. den Credential-Store. Nie als Argument an `login` oder ein
> anderes Tool übergeben – es landet dann im Prompt-Kontext. Die Tools `login`
> und `logout` lesen nur aus dem Store.

### 2.2 Betrieb als Appwrite Function (optional, Cloud)

Entrypoint `mcp/index.js`, Runtime Node.js 20/22, Verzeichnis `mcp/` +
`mcpserver/` deployen (oder `npm run build:mcp` → `dist/mcp-function.tar.gz`).
Pflicht-Env: `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID` sowie **eines** von
`APPWRITE_EMAIL`+`APPWRITE_PASSWORD`, `APPWRITE_SESSION`, `APPWRITE_API_KEY`
(+ `APPWRITE_USER_ID`). Optional, aber empfohlen: `MCP_TOKEN` (Bearer-Schutz
für Clients). Ohne `MCP_TOKEN` ist der Endpoint offen lesbar.

## 3. Werkzeuge

### 3.1 Anmeldung

| Tool | Parameter | Verhalten |
|---|---|---|
| `session_info` | – | `{authenticated, ownedByMcp, userId, email, expiresAt}`. **Nie** Passwörter. |
| `login` | – | Meldet mit den hinterlegten Daten erneut an (z. B. nach 401) |
| `logout` | – | Widerruft **nur** die selbst erzeugte Session. Fremde Sessions (z. B. per `APPWRITE_SESSION`) bleiben bestehen, damit die App angemeldet bleibt. |

### 3.2 Lesen

| Tool | Parameter | Rückgabe |
|---|---|---|
| `list_documents` | `limit` (1–100), `folderId`, `kind` (`notebook`\|`flashcards`) | Dokument-Metadaten (ohne Inhalt) |
| `get_document` | `id` | Titel, `markdown` (gekürzt, `truncated`), bei Decks `cards[]`, `deckOptions` |
| `list_folders` | – | flache Ordnerliste `{id, name, parentId}` |
| `search_documents` | `query`, `limit` | Substring-Treffer in Titel, Text **und** Kartentexten |
| `advanced_search` | `query`, `limit` | Query-Sprache, siehe unten |
| `get_graph` | `id?`, `depth?` (0–3) | Wikilink-Graph; mit `id` lokaler Subgraph |

### 3.3 Notizen schreiben

| Tool | Parameter | Verhalten |
|---|---|---|
| `create_document` | `title` (Pflicht), `content`, `contentFormat` (`markdown`\|`html`\|`text`), `folderId`, `kind` | Legt eine Notiz an. Markdown ist der Default. |
| `update_document` | `id` (Pflicht), `title`, `content`, `contentFormat`, `folderId`, `append` | `append: true` hängt als neue Textbox an, statt zu ersetzen. `folderId: ""` = unsortiert. |
| `delete_document` | `id`, `permanent` | Default: Tombstone (`title: "(gelöscht)"`, `deletedAt`) – verschwindet aus allen Listen. `permanent: true` löscht die Row endgültig. |
| `duplicate_document` | `id`, `title` | Kopie inkl. Seiten; Karten-IDs werden neu vergeben |
| `move_document` | `id`, `folderId` | Ordnerwechsel, `""` = unsortiert |

### 3.4 Ordner

| Tool | Parameter | Verhalten |
|---|---|---|
| `create_folder` | `name`, `parentId` | Verschachtelung über `parentId` |
| `rename_folder` | `id`, `name` | – |
| `delete_folder` | `id`, `moveDocumentsTo` | Enthaltene Notizen wandern nach `moveDocumentsTo` (Default: unsortiert); Anzahl in `documentsMoved` |

### 3.5 Karteikarten (SM-2, kompatibel zu `js/flashcards.js`)

| Tool | Parameter | Verhalten |
|---|---|---|
| `create_deck` | `title`, `folderId`, `cards[]` | Deck (`kind: flashcards`) mit Startkarten |
| `list_cards` | `deckId`, `filter` (`all`\|`due`\|`new`), `limit` | Karten inkl. SM-2-Zustand |
| `add_cards` | `deckId`, `cards[]` | max. 100 pro Aufruf |
| `update_card` | `deckId`, `cardId`, `front`, `back`, `suspended` | Text bearbeiten, Karte (de)aktivieren |
| `delete_card` | `deckId`, `cardId` | – |
| `review_card` | `deckId`, `cardId`, `grade` | `again`\|`hard`\|`good`\|`easy`; liefert Karte + `preview` (nächste Intervalle) |
| `deck_stats` | `deckId` | `total`, `active`, `fresh`, `due`, `learned`, `suspended`, `leeches`, `accuracy`, `forecast` (7 Tage), `streak` |

SM-2-Regeln (identisch zur App): `again` → Reset, `lapses+1`, in ~10 Min
fällig; `hard` → Intervall ×1,2; `good` → ×Ease (ab 2. Wiederholung fix 6 Tage);
`easy` → ×Ease×1,3. Ease 1,3–2,8, Start 2,5.

## 4. Query-Sprache (`advanced_search`)

- Leerzeichen = UND, `A OR B` = Alternativen (GROSS geschrieben)
- `-begriff` schließt aus, `"mehrere Worte"` = Phrase
- `file:` / `path:` wirken auf Titel, `tag:` auf `#Tags`, `task:` /
  `task-todo:` / `task-done:` auf `- [ ]` / `- [x]` (auch aus HTML-Checkboxen)
- Scoring: Titel 10 > Tag 5 > Task 3 > Text 1; Rückgabe sortiert, mit `snippet`

Beispiele: `tag:reisen`, `task-todo:steuer -erledigt`, `file:Notizen OR file:Ideen`.

## 5. Arbeitsabläufe (Rezepte)

**Notiz anlegen, wie ein Mensch tippen würde:**

1. `create_folder` → `{name: "Projekte"}` (optional, einmalig)
2. `create_document` → `{title: "Steuer 2027", content: "# Fristen\n\n- [ ] Anmeldung bis 31.03.", folderId: "<folderId>"}`
3. Später ergänzen: `update_document` → `{id, content: "- [ ] Erste Rate", append: true}`
   (nicht `content` überschreiben – `append` schützt vorhandenen Text)
4. Finden: `search_documents` → `{query: "Steuer"}`

**Karteikarten-Deck aus einer bestehenden Notiz:**

1. `create_deck` → `{title: "Vokabeln DE→FR", cards: [{front: "Haus", back: "maison"}]}`
2. `add_cards` → `{deckId, cards: [{front, back}, …]}` (Bulk, max 100)
3. Lernen: `list_cards {filter: "due"}` → `review_card {grade: "good"|"again"|…}`
4. Fortschritt: `deck_stats {deckId}`

**Aufräumen:** `delete_document {id, permanent: true}` bzw.
`delete_folder {id, moveDocumentsTo: ""}`.

## 6. Regeln für das Modell

1. **Erst lesen, dann schreiben.** `list_documents`/`search_documents` vor
   Änderungen; die `id` aus der vorherigen Antwort verwenden.
2. **IDs nicht raten.** `bookId`/`deckId`/`cardId`/`folderId` kommen aus
   Tool-Antworten. `list_documents` liefert Appwrite-Row-IDs (`$id`).
3. **Markdown ist der Default** für `content`. Überschriften, `- [ ]`-Tasks,
   `**fett**`, Listen und `[[Wikilinks]]` werden unterstützt.
4. **Nichts erfinden:** `folderId` muss existieren (sonst `Folder not found`).
5. **Karten-Tools nur auf Decks** (`kind: flashcards`), sonst `Document is not a deck`.
6. **Löschen ist zweistufig:** erst `delete_document` (Tombstone, sicher),
   nur bei ausdrücklicher Absicht `permanent: true`.
7. **Große Inhalte:** ab ~40 KB wird in den Bucket ausgelagert; der Bucket
   `attachments` erlaubt je nach Config nur `jpg/png/webp/pdf`. Passt der
   Inhalt weder inline (max ~60 KB) noch in den Bucket, kommt ein klarer
   Fehler → Inhalt teilen statt aufgeben.
8. **Fehler sind lesbar** (JSON-RPC `-32000` mit Klartext): `Document not
   found`, `Folder not found`, `Card not found`, `Document is not a deck`,
   `grade muss again|hard|good|easy sein`, `title zu lang (max 200 Zeichen)`.
   Bei 401: `login` aufrufen, dann erneut versuchen.
9. **Session-Limit:** Der MCP schließt seine alte Session vor dem Neuanmelden.
   `logout` am Ende langlebiger Sitzungen ist sauberer.

## 7. Selbsttest (ohne Cloud-Zugang)

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | node mcpserver/cli.js
```

Erwartet: `initialize` mit `federwerk-appwrite` und `tools/list` mit 24 Tools.

## 8. Weiterführend

- `docs/mcp.md` – vollständige Doku (deutsch, inkl. Worker-/curl-Legacy-API)
- `/agent` – Nutzer-Seite in der App
- `FEDERWERK_FORMAT.md`, `federwerk.schema.json`, `llms.txt` – Notizformat
