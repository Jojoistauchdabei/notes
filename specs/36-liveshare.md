# SPEC-36: Liveshare (Share-Link + Live-Cursor, eigener Server)

- Quelle: Federwerk (eigene Anforderung, SPEC-35 Share-Link-Teil)
- Kategorie: Feature
- Status: V1 umgesetzt (`js/liveshare.js`, `server/shares.js`, Tests in
  `tests/liveshare.test.js` und `server/test/server.test.js`)

## 1. Beschreibung

Gemeinsam auf **einer Seite** schreiben, ohne Drittanbieter-Tracking:
Share-Link (Lesen/Edit, mit Ablauf) + Live-Session mit farbigem
Remote-Cursor und Namen. Transport ist der eigene Server: Freigaben und
Ereignisse liegen in `social.db` (`server/shares.js`), der Live-Kanal ist
SSE (`/api/events`). Merge per Last-Writer-Wins pro Stroke/Text-ID
(SPEC-35, kein Full-Overwrite).

## 2. Verhalten

- **Hosten** (🔴 Live / Bibliothek → Hosten): aktuelle Seite wird freigegeben.
  Der **Server** erzeugt den Code (`s` + 11 Zeichen aus crypto) und legt die
  Zeile an (Snapshot der Seite, Modus, Ablauf). Frueher musste der Client den
  Code erfinden und einen 409/POST-dann-PUT-Tanz auffangen – das entfaellt.
- **Beitreten** (Link oeffnen → Dialog, oder Code einfuegen): prueft Ablauf und
  Zurueckziehung, laedt den Snapshot in eine lokale Wegwerf-Kopie (`🔴 Titel`,
  ID `live-<code>`) und fragt per `sync-request` den Vollstand beim Owner an.
- **Live**: Striche/Texte reisen als `share_events`-Zeilen (Append-only) mit
  streng monotoner `seq` als Cursor, Cursor gedrosselt (~120 ms), Presence via
  `hello`/`heartbeat`/`bye` (Timeout 25 s). SSE meldet "da ist etwas neu", der
  Poll alle 4 s bleibt als Rueckfallweg.
- **Gast im Lesemodus**: sieht alles, kann nichts aendern. Im Edit-Modus
  schreibt er mit (Owner mergt per LWW).
- **Ende**: Verlassen (Gast-Kopie wird lokal geloescht), Zurueckziehen
  (Owner setzt `revoked`), Ablaufdatum.

## 3. Serverseitiges Setup

Nichts einzurichten: `server/db.js` legt `social.db` beim ersten Zugriff selbst
an (`SOCIAL_SCHEMA`). Bewusst **eine geteilte Datenbank** und nicht
`users/<id>/docs.db`: der Gast liegt in einer anderen Nutzer-DB als der
Besitzer, ein Lookup aus der Gast-DB heraus wuerde die Zeile nie finden.

**Tabelle `shares`** (PK = Freigabe-Code):

| Spalte | Typ | Hinweis |
|---|---|---|
| `share_id` | TEXT PK | `s` + 11 Zeichen, vom Server erzeugt |
| `book_id` | TEXT | Original-Buch (Owner) |
| `owner_id` | TEXT | Nutzer-ID des Besitzers |
| `owner_name` | TEXT | Anzeige |
| `title` | TEXT | Buchtitel |
| `mode` | TEXT | `read` \| `edit` |
| `page_id` | TEXT | geteilte Seite |
| `expires_at` | INTEGER | Unix-Millisekunden, NULL = nie |
| `revoked` | INTEGER | 0/1 |
| `snapshot` | TEXT | Seiten-Snapshot (JSON) |
| `created_at`/`updated_at` | INTEGER | — |

**Tabelle `share_events`** (PK = `seq`, Append-only, AUTOINCREMENT):

| Spalte | Typ | Hinweis |
|---|---|---|
| `seq` | INTEGER PK | streng monoton – der Cursor des Clients |
| `share_id` | TEXT | Index `(share_id, seq)` |
| `user_id` | TEXT | **vom Server gesetzt**, nicht aus dem Body |
| `user_name`/`user_color` | TEXT | Anzeige |
| `kind` | TEXT | Whitelist, siehe unten |
| `payload` | TEXT | JSON je Art, max 256 KB |
| `created_at` | INTEGER | — |

Erlaubte `kind`-Werte (`server/shares.js`): `hello`, `heartbeat`, `bye`,
`stroke-add`, `stroke-del`, `text-upsert`, `text-del`, `cursor`,
`sync-request`, `sync-state`, `sync-chunk`. Die Liste **muss** der des Clients
entsprechen (`js/liveshare.js`: `KINDS`); `server/test/server.test.js`
vergleicht beide, damit sie nicht auseinanderlaufen.

Ein Ringpuffer haelt die Tabelle klein: pro Freigabe bleiben die letzten
20 000 Ereignisse. `expires_at` begrenzt die Sichtbarkeit, nicht den Speicher –
deshalb der Puffer.

## 4. Zugriffskontrolle

Der Sicherheitskern ist `readShare()` plus `appendEvent()` in
`server/shares.js`, beides im selben Prozess:

- **Lesen** darf jeder angemeldete Nutzer, solange die Freigabe existiert,
  nicht widerrufen und nicht abgelaufen ist – der Code ist die Berechtigung
  (12 Zeichen, aus crypto, jederzeit widerrufbar).
- **Aendern und Zurueckziehen** darf nur der Besitzer.
- **Anhaengen** eines Ereignisses prueft dieselbe Bedingung wie das Lesen.
  Damit ist ausgeschlossen, dass jemand mit geratenem Code in eine fremde
  Sitzung schreibt.

Frueher lag genau diese Pruefung in einer separaten Cloud-Function
(`functions/share-events-guard/`), weil die Zeilenrechte des Backends keine
Freigabe-Mitgliedschaft kannten. Mit eigenem Server waere das nur ein Umweg um
dieselbe Pruefung – der Guard ist entfallen.

Zusaetzlich filtert der Client unbefugte Mutationen (`isEventAllowed` in
`js/liveshare.js`: Absender-Owner vs. Modus) – das ist reine UI-Hygiene und
ersetzt **keinen** Server-Check.

## 5. V1-Grenzen (bewusst)

- Nur **Striche + Texte** syncen live; **Bilder/Hintergruende** reisen nicht
  mit (der Snapshot enthaelt sie nicht). Seite vorher ggf. ohne Bilder teilen.
- Snapshot > 48 KB wird gechunkt (max. 8 × 30 KB); darueber: Texte kuerzen /
  Striche reduzieren, sonst Fehlermeldung statt stillem Datenverlust.
- Fuer oeffentliche Links ohne Konto ist V1 nicht gedacht: alle Teilnehmenden
  brauchen ein Konto auf derselben Instanz.
- Kein Tracking ohne Opt-in: SSE/Polling laeuft nur waehrend einer aktiven
  Session.

## 6. User-Story

Als Lerngruppe will ich eine Seite live teilen, damit alle gleichzeitig
mitschreiben und ich per Cursor zeige, wo wir sind – ohne Zoom-Konto,
nur mit Federwerk-Link.

## 7. Akzeptanzkriterien

- [ ] Zwei Browser (gleiche Instanz): Host-Link → Gast sieht Seite + Striche live (< 5 s, auch per Polling).
- [ ] Remote-Cursor beider Seiten farbig + Namen sichtbar.
- [ ] Lesemodus: Gast kann nicht schreiben/radieren; Edit-Modus: beide Striche bleiben erhalten (LWW, kein Overwrite).
- [ ] Ablauf + Zurueckziehen blockieren Beitritt mit verstaendlicher Meldung.
- [ ] Fremder mit dem Code darf mitlesen, aber nicht aendern (`server/test/server.test.js`).
- [ ] `npm test` gruen (Liveshare-Tests in `tests/liveshare.test.js`, inkl. LWW-Konvergenz).

## 8. Verifikation

- Automatisiert: `npm test` (Code/Link, Ablauf/Rechte, Event-Build,
  Stroke-/Text-LWW, Snapshot/Chunks, Presence/Cursor-Drossel) und
  `node --test server/test/server.test.js` (Freigabe, Ereignisstrom,
  Whitelist, Ringpuffer, Zugriffsschutz).
- Manuell: 2 Browser, je ein Konto auf derselben Instanz → hosten,
  beitreten, malen, radieren, Text editieren, Modus wechseln,
  zurueckziehen, Ablauf abwarten.
