# SPEC-15: Attachments (Bilder, Audio, Video, PDF)

- Quelle: Obsidian
- Kategorie: Feature
- Status: Vorschlag

## 1. Beschreibung

Grimoire verwaltet eingebettete Dateien (Bilder, Audio, Video, PDF) Obsidian-kompatibel: Ablageordner aus `attachmentFolderPath` (vgl. SPEC-16), relative oder absolute Vault-Pfade, Größensteuerung per Wikilink-Suffix. Canvas-Notizbuch und IndexedDB-Blobs müssen auf dasselbe Auflösungsmodell zeigen.

## 2. UI / Verhalten / Aufbau (mit Schema/Beispiel wo relevant)

Syntax-Beispiele:

```markdown
![[skizze.png]]
![[skizze.png|300]]
![[skizze.png|300x200]]
[[audio.mp3]]
![[demo.mp4]]
![[paper.pdf]]
![[paper.pdf#page=3]]
![](anhang/skizze.png)
```

Verhalten:

- `attachmentFolderPath` aus `.obsidian/app.json`: z. B. `anhang` (vault-relativ) oder leer (= Notiz-Ordner). Neue Anhänge (Upload/Paste/Drag&Drop) landen dort.
- Pfadauflösung: zuerst relativ zum Notiz-Ordner, dann vault-relativ, dann absolut (`/anhang/x.png` = Vault-Root). Unauflösbar → Platzhalter mit Dateiname + „fehlt"-Stil (kein Broken-Image ohne Hinweis).
- Breiten-Syntax: `|300` = Breite in px; `|300x200` = Breite × Höhe. Nur für Bilder; andere Typen ignorieren die Angabe tolerant.
- Typ-Rendering: Bild → `<img>`; Audio → `<audio controls>`; Video → `<video controls>`; PDF → eingebettete Vorschau mit Seitenanker `#page=N` + Download-Link.
- Externe URLs (`http(s)://`) werden nie in den Anhang-Ordner kopiert, sondern direkt verlinkt.
- Löschen/Umbenennen einer Notiz lässt Anhang-Dateien unangetastet (kein implizites Aufräumen im MVP).

## 3. User-Story

Als Nutzer möchte ich Bilder per Drag&Drop in eine Notiz ziehen und per `|300` skalieren, damit meine Notizen in Grimoire wie in Obsidian aussehen und die Dateien an einem konfigurierten Ort im Vault liegen.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] Upload/Paste/Drag&Drop speichert neue Anhänge unter `attachmentFolderPath` (Fallback: Notiz-Ordner).
- [ ] Relative, vault-relative und absolute Pfade lösen korrekt auf; fehlende Dateien zeigen einen benannten Platzhalter.
- [ ] `|300` und `|300x200` skalieren Bilder; ungültige Angaben (`|abc`) fallen tolerant auf Originalgröße zurück.
- [ ] Audio/Video/PDF rendern mit Player bzw. Vorschau; `paper.pdf#page=3` öffnet Seite 3.
- [ ] Externe URLs werden direkt eingebettet/verlinkt, nicht lokal kopiert.
- [ ] Umbenennen/Verschieben einer Notiz zerbricht keine relativen Anhang-Links (Pfade werden mitgezogen oder bleiben gültig).
- [ ] Große Dateien (> 10 MB) blockieren weder Rendering noch Speichern (lazy loading / kein Inline-Base64 im Markdown).

## 5. Verifikation

Manuell:

1. Bild per Drag&Drop einfügen → liegt unter `attachmentFolderPath`, `![[bild.png|300]]` rendert 300px breit.
2. Notiz in Unterordner verschieben → Anhang rendert weiter; fehlende Datei umbenennen → Platzhalter mit Dateiname sichtbar.
3. Audio-, Video- und PDF-Embeds einfügen → Player/Vorschau + `#page=3`-Sprung funktionieren.

Automatisiert (`tests/obsidian-attachments.test.js`):

- Pfadauflösungs-Tests (relativ/vault-relativ/absolut/fehlend) gegen Fixture-Vault.
- Syntax-Tests für `|300`, `|300x200`, `#page=N`, externe URLs.
- Prüfen mit `npm test`.

## 6. Grimoire-Aufwand (S/M/L)

M — Auflösungslogik + Rendering pro Medientyp + Upload-Pipeline in den konfigurierten Ordner; IndexedDB-Blob-Cache für Offline-PWA ist der teure Anteil.

## 7. Offene Entscheidung

Speicherung in der PWA: Vault-Dateisystem (File System Access API, Obsidian-nah) vs. IndexedDB-Blob-Store mit Export-Sync — erstere ist kompatibler, letztere offline-robuster; ggf. Hybrid mit Cache.
