# Federwerk MCP – Setup, Tools & Speicherformat

Diese Seite dokumentiert beide MCP-Zugänge der Federwerk-Notiz-App:
den **echten MCP-Server (JSON-RPC 2.0, 24 Tools)** für KI-Clients und das
ältere **curl-API (`/mcp/*`, lesend)** auf Worker/lokalem Server.

## 0. Web-Routen

| Route | Inhalt | Für wen |
|---|---|---|
| `/agent` | `agent.html` – Einrichtung in drei Schritten, Beispiele, Warnungen | Nutzer (in der App verlinkt: ⚙ Appwrite-Cloud) |
| `/mcp` | `MCP_AI.md` als `text/markdown` – Installations- und Nutzungsanleitung | KI-Modelle (Adresse in den Chat kopierbar) |
| `/mcp/tools`, `/mcp/login`, `/mcp/search`, `/mcp/read`, `/mcp/prompt`, `/mcp/health` | Legacy-API | Skripte/curl |

Hinweis: `/mcp` war früher ein Alias der Tool-Liste; die Doku belegt ihn jetzt,
die Tool-Liste liegt unter `/mcp/tools`. Die Doku-Routen kommen im Worker
**vor** der API (`serveDocs` in `worker.js`); Quell-Dateien sind `agent.html`
und `MCP_AI.md`, werden von `scripts/build-dist.js` nach `dist/` kopiert und
sind über `tests/doc-routes.test.js` abgesichert.

## 1. Welcher Zugang wofür?

| Zugang | Protokoll | Tools | Wofür |
|---|---|---|---|
| `mcpserver/` + `mcp/` | MCP (JSON-RPC 2.0, stdio/HTTP) | 24 (Anmeldung, lesen **+ schreiben**) | **Empfohlen**: Claude Desktop, Cursor, Opencode – KI arbeitet wie ein Mensch (Notizen, Ordner, Karteikarten, Suche, Graph) |
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

**So funktioniert es:** Der MCP bekommt die Login-Daten (E-Mail + Passwort)
und **erstellt die Appwrite-Session (Cookie) selbst** – beim ersten Zugriff,
bei Bedarf erneut (z. B. nach Ablauf, automatisch bei 401). Ohne Anmeldedaten
läuft er als flüchtiges Demo-Backend.

Einmalig einrichten:

```bash
node mcpserver/login.js --email DU@BEISPIEL.DE --save
# Passwort wird interaktiv gefragt (weder History noch `ps`) und in
# ~/.config/federwerk/mcp-credentials.json (chmod 600, außerhalb des Repos)
# abgelegt. Ab jetzt genügt: node mcpserver/cli.js
```

Alternativ ohne Datei: `APPWRITE_EMAIL` + `APPWRITE_PASSWORD` als Env setzen.
Der Nutzer wird automatisch ermittelt, `APPWRITE_USER_ID` ist nicht nötig.

Passwort niemals als Tool-Argument übergeben – `login`/`logout` lesen nur aus
dem Store, damit es nicht im LLM-Kontext landet.

| Betriebsart | Env | Notes |
|---|---|---|
| **Anmeldung (empfohlen)** | `APPWRITE_EMAIL`+`APPWRITE_PASSWORD` oder Credential-Datei | MCP meldet sich selbst an, Re-Auth bei 401 |
| Fertige Session | `APPWRITE_SESSION=<token>` | Token z. B. aus `login.js`; fremde Session → `logout` löscht sie **nicht** |
| Server-Admin | `APPWRITE_API_KEY` + `APPWRITE_USER_ID` | Key-Modus, handelt mit Admin-Rechten |

Logout: `node mcpserver/login.js --logout --session <token>` oder das
`logout`-Tool (widerruft nur die Session, die der MCP selbst erzeugt hat).

> **Wichtig – Session-Limit:** Appwrite erlaubt pro Benutzer nur eine
> begrenzte Zahl Sessions und verdrängt dabei die **ältesten** (live
> beobachtet: die Browser-Sessions der App wurden dadurch abgemeldet). Der
> MCP schließt seine eigene alte Session vor dem Neuanmelden und erzeugt
> keine Leichen. Trotzdem: Viele parallele Logins (mehrere MCP-Instanzen,
> Geräte) können die App-Sessions verdrängen – Notizen bleiben erhalten,
> man muss sich in der App nur neu anmelden.

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
- Env-Vars: `APPWRITE_*`-Basis wie 3.1 plus **entweder** E-Mail/Passwort
  (`APPWRITE_EMAIL` + `APPWRITE_PASSWORD`, Function meldet sich selbst an)
  **oder** `APPWRITE_SESSION` **oder** `APPWRITE_API_KEY` + Pflicht-
  `APPWRITE_USER_ID`; `MCP_TOKEN` empfohlen. Ohne `MCP_TOKEN` ist die
  Function offen lesbar!
- Bei Credentials in der Function: Passwort als Secret hinterlegen, nicht
  in den Code – die Function erzeugt die Session selbst (gleicher Code-Pfad
  wie lokal).
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

## 4. Tool-Referenz (MCP, 24 Tools)

Anmeldung: `session_info` (wer angemeldet, `ownedByMcp`, Ablauf – **ohne**
Passwort), `login` (mit den hinterlegten Daten neu anmelden), `logout`
(widerruft nur die eigene Session; fremde Sessions bleiben unangetastet).

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
- **Offload:** Content > 40 KB soll als JSON-Datei in den Bucket
  (`content=""`, `contentFileId="fw<sha256>"`, Dedupe per Datei-ID).
  **Live gemessen:** Der Bucket `attachments` erlaubt standardmäßig nur
  `jpg/png/webp/pdf` – JSON wird mit `storage_file_type_unsupported`
  abgelehnt. Dann legt der MCP den Content inline ab, solange er in die
  Zeile passt; ab ~60 KB kommt ein klarer Fehler mit Lösungshinweis.
  Abhilfe: In der Console **Storage → attachments → erlaubte Endungen um
  `json` erweitern** (dann greift der Offload wieder).
- **Zeilenlimit:** `notes.content` akzeptiert live 60 KB inline, ab 64 KB
  lehnt Appwrite die Row ab (Tabelle/Attribut-Limit).
- **Limits:** Titel max 200 Zeichen, ein Schreibvorgang max ~200 KB
  (praktisch durch das Zeilenlimit begrenzt), max 100 Karten/Aufruf,
  `get_document` kürzt Markdown (~8,5 KB, `truncated:true`) und Karten
  (max 200, `cardsTruncated:true`).
- **Gelöscht:** Tombstone (`title:"(gelöscht)"`, `deletedAt` gesetzt) –
  taucht in keiner Liste/Suche mehr auf; `permanent:true` entfernt die Row.
- **Sync-Hinweis:** Der App-Sync (`js/appwrite-sync.js`) persistiert v2
  seit dem Deck-Fix (Änderungserkennung inkl. Karten). Der **erste Sync
  nach dem Update schiebt jedes Buch einmal hoch** (einmalige
  Hash-Migration). Alte Clients lesen v2 (Seiten laden, Deckfelder
  ignorieren), schreiben sie aber ohne Deckfelder zurück – Clients
  möglichst **gemeinsam aktualisieren**, sonst können Karten verloren gehen.

## 6. Sicherheit

- `APPWRITE_EMAIL`/`APPWRITE_PASSWORD`, `APPWRITE_SESSION`,
  `APPWRITE_API_KEY` + `MCP_TOKEN` sind Secrets (nie committen, nie loggen;
  Passwort nur interaktiv in `login.js` tippen). Die Credential-Datei
  (`~/.config/federwerk/mcp-credentials.json`) gehört **nicht** ins Repo.
- Passwörter nie als Tool-Argument übergeben – sonst landen sie im
  LLM-Kontext (Prompt-Logs, History). `login` nutzt den Store.
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
| Nur Demo-Notiz sichtbar | Keine Anmeldedaten → Demo-Backend (Startmeldung auf stderr beachten); `node mcpserver/login.js --email … --save` |
| `Unauthorized` (401) | `MCP_TOKEN` falsch/fehlend; Header `Authorization: Bearer …` prüfen |
| `Anmeldedaten erforderlich` (500) | Weder Session/Key noch E-Mail+Passwort (Env oder Credential-Datei) vorhanden |
| `Keine Anmeldedaten` | `login.js --save` ausführen oder `APPWRITE_EMAIL`/`APPWRITE_PASSWORD` setzen |
| `Login fehlgeschlagen` | E-Mail/Passwort falsch oder Appwrite-Login gedrosselt (Rate-Limit) |
| `Session ungültig oder abgelaufen` | Erneut `node mcpserver/login.js`; bei Credentials-Modus meldet sich der MCP selbst neu an |
| Leere Suche am lokalen Server | `--file` fehlt oder Pfad falsch (Log: "nicht lesbar") |
| 503 am Worker | Secrets (`MCP_USER/MCP_PASS/MCP_TOKEN`) oder Appwrite-Config fehlen |
| Karten nach Sync weg | Alter Client ohne v2-Support hat zurückgeschrieben → Clients aktualisieren (Kap. 5) |
| `Document is not a deck` | Karten-Tool auf Notebook aufgerufen; `kind`-Filter in `list_documents` nutzen |
| `File extension not allowed` / `storage_file_type_unsupported` | Bucket `attachments` erlaubt kein `json` → Endung in der Console freigeben (Kap. 5); MCP legt sonst inline ab, solange ≤ ~60 KB |
| `Appwrite 400: Missing required attribute "userId"` | Sollte nicht mehr vorkommen (Teildaten-Updates werden gemerged); bei Auftreten Bucket/Tabelle prüfen |

## 8. Weiterentwickeln

- Neue Tools: Schema in `mcpserver/index.js` + Handler-Slot, Logik nach
  `mcpserver/content.js` (rein) oder Adapter (`mcp/index.js`,
  `mcpserver/cli.js`), Tests in `tests/mcp-write.test.js`,
  dann `npm run build:mcp` + `npm test`.
- Tests: `npm test` (gesamt), `npm run test:mcp` (MCP-Kern + Function).
- Live-Test gegen die Cloud (schreibend, räumt selbst auf): `create_folder` →
  `create_document` → `create_deck` + `review_card` → Suche/Graph →
  alles `permanent: true` löschen. Nach dem Test prüfen, dass keine Zeilen
  mit dem Test-Präfix übrig sind, und die Session per `--logout` löschen.
