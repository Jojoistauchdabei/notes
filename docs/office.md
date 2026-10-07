# Office

Office-Implementierung (DOCX/XLSX/PPTX/CSV/ODF/PDF) mit verschlüsselter
Dokumentablage, Versionierung und Konflikterkennung. Eigene App, **eigener
Cloudflare-Worker `office`** — bewusst getrennt vom Federwerk-Worker `notes`.

## Warum getrennt von Federwerk

| | Federwerk (`notes`) | Office (`office`) |
|---|---|---|
| Was | Handschrift-Notizbuch | Dokumentbearbeitung |
| Deploy | `dist/` → `wrangler.toml` | `office/dist/` → `office/wrangler.toml` |
| Workflow | `release.yml` | `office.yml` |
| Lizenz | eigen | AGPL-3.0-Nutzung des Editors, s. u. |

Drei Gründe, warum das ein getrenntes Deployment ist:

1. **Lizenz.** Der ONLYOFFICE-WASM-Editor ist AGPL-3.0 mit erwaehnungspflichtigen
   Zusatzbedingungen (ONLYOFFICE-Logo muss erhalten bleiben, keine Markenrechte
   nach §7). Solange kein ONLYOFFICE-Code in `dist/` landet, bleibt Federwerk
   davon unberührt.
2. **Größe.** Der Editor ist ein Framework-Paket mit ~3.200 Dateien und
   ~445 MB Rohdaten. Das gehört weder in das Release-ZIP noch in die
   Desktop-Installer (`src-tauri` baut gegen `../dist`).
3. **Ausfallsicherheit.** Eigener Job ohne `needs` — ein Office-Fehler rollt
   das Federwerk-Deployment nicht zurück.

## Editor-URL konfigurieren

Der ONLYOFFICE-WASM-Editor ist **nicht** Teil dieses Deployments und wird auch
nicht mitgebaut. Adresse zur Laufzeit setzen:

- Eingabefeld **„Editor-URL"** in der Kopfzeile (persistent für die Sitzung),
- oder beim Erzeugen des Builds: `office/index.html` → `window.EDITOR_BASE`
  direkt vor dem Bundle einfügen,
- oder pro Aufruf: `?editor=https://editor.example`.

Der Editor liefert seine Oberfläche aus dieser Origin; alles andere (Passphrase,
Dokumente, Schlüssel) bleibt in dieser App.

## Datenhaltung und späterer Backend-Wechsel

Aktuell `IndexedDB` über `office/js/kv.js`. Das Backend steckt hinter einem
Adapter (`office/js/storage-adapter.js`) mit genau diesen Methoden:

```
listDocuments() · createDocument() · readDocument() · writeDocument(id, data, {ifMatch})
listVersions()  · readVersion()    · restoreVersion() · deleteDocument()
acquireLock()   · releaseLock()
```

Für ein selbstgehostetes Backend ist `office/js/storage-adapter.js` die einzige
anzupassende Datei — `docstore.js`, `app.js` und der Editor bleiben unberührt.
`Storage.assertAdapter()` prüft den Vertrag beim Binden, damit ein unvollständiges
Backend nicht erst in der UI auffällt.

## Verschlüsselung

Jedes Dokument bekommt einen eigenen zufälligen **DEK** (AES-256-GCM). Der DEK
wird mit einem **KEK** umschlossen, der per PBKDF2-SHA256 (210.000 Runden) aus
der Passphrase und einem Salt im Tresor abgeleitet wird. Gespeichert wird nur
Chiffretext — auch das Backend sieht nie Klartext.

Die Passphrase existiert nur in der laufenden Sitzung und wird nirgends
gespeichert. **Geht sie verloren, sind die Dokumente nicht mehr lesbar** — es
gibt absichtlich keine Hintertür.

## Synchronisierung: ehrlicher Umfang

Umgesetzt:

- **Versionierung.** Jedes Speichern legt eine neue Version an; ältere bleiben
  abrufbar und wiederherstellbar. Ein Wiederherstellen ist ein *neuer* Stand,
  kein Überschreiben — Historie bleibt nachvollziehbar.
- **Optimistisches Locking.** Beim Lesen merkt sich der Aufrufer den `etag`
  (SHA-256 über das Chiffretext-Envelope, also inhaltsbasiert und ohne
  Server-Uhr vergleichbar). Beim Schreiben muss er mitgeschickt werden; bei
  veraltetem Stand bricht der Schreibvorgang ab und die UI bietet „fremde
  Fassung laden" oder „meine als eigene Version sichern" an. Es wird nie still
  überschrieben.
- **Weiche Sperren.** Wer ein Dokument öffnet, hält eine 2-Minuten-Sperre, die
  nach Ablauf automatisch frei wird (auch nach einem abgestürzten Tab). Sie ist
  ein Hinweis für die UI, keine Korrektheitsgarantie.

Nicht umgesetzt — und auf dem WASM-Editor **nicht erreichbar**:

- **Echtes gleichzeitiges Bearbeiten.** ONLYOFFICE bietet Co-Editing nur über den
  Connector im Document Server. Der WASM-Build hat keinen dokumentierten Hook,
  der Mutationen abgreift, auf dem sich ein CRDT/OT aufsetzen ließe. Zwei
  Personen im selben Dokument sind daher serialisiert (Sperre + Konflikt beim
  Speichern), nicht gleichzeitig.
- **Dateisystem-Sync.** Es gibt noch keinen Abgleich zwischen Geräten; dafür fehlt
  die Serverkomponente. Genau dafür ist die Adapter-Schnittstelle gedacht.

Wer echtes Co-Editing braucht, muss einen Collab-Server dazustellen — dann
entfällt der WASM-Build als Basis.

## Bauen und Deployen

```bash
npm run build:office          # office/dist/
cd office && wrangler deploy # oder: npx wrangler@4 deploy --config office/wrangler.toml
```

`office/dist/` ist ein Build-Artefakt und nicht eingecheckt. Jedes Release
enthält `Office-<version>-web.zip`.

Tests: `npm test` deckt Krypto-Roundtrip, Adapter-Vertrag, Versions-/Konfliktlogik,
Editor-Nachrichtenfilter und den Build ab (`tests/office-*.test.js`,
`tests/build-office.test.js`).

## Format-Stand

DOCX, XLSX, PPTX, CSV editierbar; ODT/ODS/ODP, RTF, TXT und die alten
Binärformate sowie PDF öffnen und annotieren. Export nach PDF für alle.
Welche Formate der konkrete Editor in der konfigurierten URL unterstützt, entscheidet
der Editor selbst — die App reicht die Bytes unverändert durch.