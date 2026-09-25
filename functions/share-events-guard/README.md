# Share-Events-Guard (Appwrite Function)

Serverseitige Prüfung für Liveshare-Events (`share_events`), weil
Appwrite-Row-Permissions **nicht** ausdrücken können, „ob der Schreiber zu
diesem Share gehört". Ohne Guard kann jeder eingeloggte User, der den
12-stelligen Code kennt/errät, `stroke-add`-/`text-upsert`-Events in fremde
Live-Sessions injizieren.

## Was die Function tut

Der Client schickt Events an die Function statt direkt in die Tabelle. Die
Function:

1. verifiziert die Session serverseitig (`GET /account` mit
   `X-Appwrite-Session` → verifizierte User-ID; Client-Angaben zählen nicht),
2. lädt die Share-Row mit API-Key und prüft: existiert, nicht `revoked`,
   nicht abgelaufen, Absender darf diese Event-Kind senden (Owner immer,
   Gast nur bei Modus `edit`; `sync-state`/`sync-chunk` nur Owner),
3. schreibt erst dann die Event-Row mit API-Key (`userId` = verifiziert,
   `read("users")`).

Regel-Spiegel: `index.js` (`shareUsable`, `canSendKind`, `checkSender`)
entspricht `js/liveshare.js` – bei Regeländerungen **beide** pflegen
(Tests: `tests/liveshare.test.js`, `tests/share-guard.test.js`).

## Deploy (Console, ca. 5 Min)

1. Appwrite-Console → Functions → Create Function:
   Runtime **Node.js 22** (oder 20), Entrypoint **`index.js`**.
2. Code: Inhalt dieses Verzeichnisses hochladen (nur `index.js` nötig,
   keine `npm install` – keine Dependencies).
3. Variables setzen:
   `APPWRITE_ENDPOINT`, `APPWRITE_PROJECT_ID`,
   `APPWRITE_DATABASE_ID` (= `federwerk`),
   `APPWRITE_API_KEY` (Key mit TablesDB-Read auf `shares` + Create auf
   `share_events`).
4. Execute-Access: **Any** – die Auth prüft die Function selbst anhand der
   Appwrite-Session (Execute-Restriktion wäre zusätzlich möglich, ist aber
   kein Ersatz).
5. Function-Domain/Executions-URL kopieren, z. B.
   `https://fra.cloud.appwrite.io/v1/functions/<FUNCTION_ID>/executions`.

## In Federwerk aktivieren

In der App unter ⚙ (Appwrite-Einstellungen) die Executions-URL als
**Liveshare-Guard-URL** eintragen. Ab dann laufen alle Events exklusiv über
die Function – ohne Fallback auf direkte Row-Writes (Fallback würde die
Prüfung umgehen). Ohne eingetragene URL gilt weiter das V1-Verhalten
(direkte Writes, nur Client-Filter).
