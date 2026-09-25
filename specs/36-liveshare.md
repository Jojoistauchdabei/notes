# SPEC-36: Liveshare (Share-Link + Live-Cursor, Appwrite-only)

- Quelle: Federwerk (eigene Anforderung, SPEC-35 Share-Link-Teil)
- Kategorie: Feature
- Status: V1 umgesetzt (`js/liveshare.js`, Tests in `tests/liveshare.test.js`)

## 1. Beschreibung

Gemeinsam auf **einer Seite** schreiben, ohne eigenen Server und ohne
Drittanbieter-Tracking: Share-Link (Lesen/Edit, mit Ablauf) + Live-Session
mit farbigen Remote-Cursor + Namen. Transport: bestehende Appwrite-Instanz
(TablesDB + Realtime), Merge per Last-Writer-Wins pro Stroke/Text-ID
(SPEC-35, kein Full-Overwrite).

## 2. Verhalten

- **Hosten** (🔴 Live / Bibliothek → Hosten): aktuelle Seite wird freigegeben.
  Erzeugt Code `s…` (12 Zeichen), Link `…#share=s…`, legt Row in `shares` an
  (Snapshot der Seite, Modus, Ablauf). Link wird in die Zwischenablage kopiert.
- **Beitreten** (Link öffnen → Dialog, oder Code einfügen): prüft Ablauf +
  Zurückziehung, lädt Snapshot in eine lokale Wegwerf-Kopie (`🔴 Titel`,
  ID `live-<code>`), fragt per `sync-request` den Vollstand beim Owner an.
- **Live**: Strokes/Texte reisen als `share_events`-Rows (Append-only),
  Cursor gedrosselt (~120 ms), Presence via `hello`/`heartbeat`/`bye`
  (Timeout 25 s). Realtime-WebSocket, Polling-Fallback alle 4 s.
- **Gast im Lesemodus**: sieht alles, kann nichts ändern (Stift/Radierer/Text
  blockiert). Im Edit-Modus schreibt er mit (Owner mergt per LWW).
- **Ende**: Verlassen (Gast-Kopie wird lokal gelöscht), Zurückziehen
  (Owner setzt `revoked`), Ablaufdatum.

## 3. Appwrite-Setup (einmalig, ca. 5 Min)

Gleiche Database wie `notes`/`folders` (Default `federwerk`), zwei neue Tabellen.
**Weg A (empfohlen, 1 Befehl):** API-Key mit TablesDB-Scope anlegen
(Appwrite-Console → Project → API Keys), dann:

```bash
APPWRITE_API_KEY=... npm run setup:liveshare -- --apply
```

(idempotent: Existierendes wird per 409 übersprungen; ohne `--apply` nur Dry-Run).
**Weg B (Console):** Tabellen + Spalten/Indexe von Hand nach folgendem Schema:

**Tabelle `shares`** (Row-ID = Share-Code, z. B. `sabc…`):

| Key | Typ | Pflicht | Hinweis |
|---|---|---|---|
| `shareId` | String (36) | ja | = Row-ID |
| `bookId` | String (36) | ja | Original-Buch (Owner) |
| `ownerId` | String (36) | ja | Appwrite-User-ID |
| `ownerName` | String (64) | nein | Anzeige |
| `title` | String (160) | nein | Buchtitel |
| `mode` | String (8) | ja | `read` \| `edit` |
| `pageId` | String (36) | nein | geteilte Seite |
| `expiresAt` | Datetime | nein | leer = nie |
| `revoked` | Boolean | ja | Default `false` |
| `snapshot` | String (65535) | nein | Seiten-Snapshot (JSON) |
| `createdAt`/`updatedAt` | Datetime | ja | — |

Permissions: `read("users")`, `update("user:{ownerId}")`,
`delete("user:{ownerId}")` – die App setzt sie beim Anlegen; in der
Console ersatzweise „Anyone authenticated: read" + Owner-Update/Delete.

**Tabelle `share_events`** (Row-ID `unique()`, Append-only):

| Key | Typ | Pflicht | Hinweis |
|---|---|---|---|
| `shareId` | String (36) | ja | Index empfohlen |
| `userId` | String (36) | ja | — |
| `userName` | String (64) | nein | — |
| `userColor` | String (16) | nein | — |
| `kind` | String (16) | ja | `hello,heartbeat,bye,stroke-add,stroke-del,text-upsert,text-del,cursor,sync-request,sync-state,sync-chunk` |
| `payload` | String (65535) | ja | JSON je Kind |
| `createdAt` | Datetime | ja | — |

Permissions: `read("users")`, `create("users")` (jeder Eingeloggte darf
Events anhängen – der unratbare Code + Ablauf begrenzen den Zugriff).
Tabellen-Defaults bewusst **ohne** `update`/`delete` (Append-only);
Event-Rows bekommen `read("users")` + `delete("user:{autor}")`
(eigene Rows aufräumbar, fremde unantastbar, Updates unmöglich).

> **Sicherheits-Hinweis (Review):** Row-Permissions können NICHT prüfen, ob
> ein Event zu einem Share gehört, dem der Schreiber beigetreten ist –
> jeder eingeloggte User mit dem Code kann Events injizieren.
> Empfehlung: **Guard-Function** deployen (`functions/share-events-guard/`,
> README dort) und in der App unter ⚙ als Liveshare-Guard-URL eintragen.
> Ab dann laufen Events exklusiv über die Function (Session-Verifikation +
> Share-Check serverseitig, kein direkter Fallback). Zusätzlich filtert der
> Client unbefugte Mutationen raus (`isEventAllowed` in `js/liveshare.js`:
> Absender-Owner vs. Modus statt eigener Schreibrechte – ersetzt aber keinen
> Server-Check).

Fehlen die Tabellen, meldet die App:
„Tabellen `shares`/`share_events` fehlen in Appwrite – Setup siehe specs/36-liveshare.md."

## 4. V1-Grenzen (bewusst)

- Nur **Strokes + Texte** syncen live; **Bilder/Hintergründe** reisen nicht
  mit (Snapshot enthält sie nicht). Seite vorher ggf. ohne Bilder teilen.
- Snapshot > 48 KB wird gechunkt (max. 8 × 30 KB); darüber: Texte kürzen /
  Striche reduzieren, sonst Fehlermeldung statt stillem Datenverlust.
- Rechte-Enforcement ist **Client-seitig**, solange keine Guard-Function
  deployed ist (Appwrite-Permissions kennen keinen
  „Gast-nur-lesen"-Status): unratbarer Code + Ablauf + Revoke sind der
  Schutz. **Mit Guard** (`functions/share-events-guard/`) ist das
  Enforcement serverseitig (Session-Verifikation, Share-Existenz,
  Revoke/Ablauf, Owner-vs.-Modus pro Event-Kind). Für öffentliche Links
  ohne Login ist V1 nicht gedacht –
  alle Teilnehmenden loggen sich auf derselben Appwrite-Instanz ein.
- Kein Tracking ohne Opt-in: Realtime/Polling läuft nur während einer
  aktiven Session, kein Drittanbieter (nur die eigene Appwrite-Instanz).

## 5. User-Story

Als Lerngruppe will ich eine Seite live teilen, damit alle gleichzeitig
mitschreiben und ich per Cursor zeige, wo wir sind – ohne Zoom-Konto,
nur mit Federwerk-Link.

## 6. Akzeptanzkriterien

- [ ] Zwei Browser (gleiches Appwrite): Host-Link → Gast sieht Seite + Striche live (< 5 s, auch per Polling).
- [ ] Remote-Cursor beider Seiten farbig + Namen sichtbar.
- [ ] Lesemodus: Gast kann nicht schreiben/radieren; Edit-Modus: beide Striche bleiben erhalten (LWW, kein Overwrite).
- [ ] Ablauf + Zurückziehen blockieren Beitritt mit verständlicher Meldung.
- [ ] Offline/ohne Tabellen: klare Fehlermeldung, kein Datenverlust lokal.
- [ ] `npm test` grün (23 Liveshare-Tests in `tests/liveshare.test.js`, inkl. LWW-Konvergenz).

## 7. Verifikation

- Automatisiert: `npm test` (Code/Link, Ablauf/Rechte, Event-Build,
  Stroke-/Text-LWW, Snapshot/Chunks, Presence/Cursor-Drossel, Zeilen-Bodies).
- Manuell: 2 Browser, je 1 Account (oder 2 Accounts) auf derselben
  Appwrite-Instanz → hosten, beitreten, malen, radieren, Text editieren,
  Modus wechseln, zurückziehen, Ablauf abwarten.
