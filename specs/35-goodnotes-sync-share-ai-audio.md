# SPEC-35: GoodNotes Sync, Share, Audio & AI

- Quelle: GoodNotes 6 (2025/2026)
- Kategorie: Feature
- Status: Vorschlag

## 1. Beschreibung

Cloud- und Kollaborations-Gegenstück zu Grimoires lokalem IndexedDB-Ansatz (`js/cloud.js`, `js/cloud-ui.js`): iCloud vs. GoodNotes-Cloud vs. Auto-Backup (WebDAV/GDrive/Dropbox), Share-Link-Collab mit Live-Cursor (CRDT-Gedanke), Audio-Recording mit Stroke-Timestamps + Transkript sowie Ask-AI (Summarize/Quiz/Mindmap) mit Credits-Modell (on-device vs. Cloud).

## 2. UI / Verhalten / Aufbau

- Sync-Optionen: iCloud (Apple-only, System-Sync), GoodNotes-Cloud (plattformübergreifend, Account), Auto-Backup (einseitig: WebDAV/Google Drive/Dropbox, Zeitplan + Jetzt-Button). Grimoire: lokale-First + optionaler Cloud-Adapter (`js/cloud.js`), kein Lock-in.
- Share-Link: Leselink vs. Edit-Link mit Ablauf; Collab-Session mit Live-Cursor (farbige Remote-Cursor + Namen), Konfliktlösung per CRDT-Gedanke (last-writer-wins pro Stroke, kein Full-Overwrite).
- Audio-Recording: Aufnahme pro Seite, Stroke-Timestamps (jeder Stroke speichert Audio-Offset); Tap auf Stroke springt im Audio (und umgekehrt Playback highlightet Strokes); Transkript als durchsuchbare Textbox.
- Ask-AI: Aktionen Summarize (Zusammenfassung), Quiz (Fragen aus Seite), Mindmap (Knoten aus Überschriften); Credits-Modell: on-device (frei, klein, offline) vs. Cloud (蝶 Credits pro Anfrage, Key/Server nötig).
- UI: Sync-Status-Icon (ok/offline/konflikt), Share-Dialog, Audio-Bar (Rec/Play/Waveform), AI-Panel mit Credit-Anzeige.

## 3. User-Story

Als Spielleiter will ich Session-Audio mit synchronen Karten-Notizen aufnehmen, die Zusammenfassung per Ask-AI erstellen und Spielern einen Lese-Link auf das Questlog teilen.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] Sync-Status sichtbar; Offline-Edits gehen nicht verloren (Queue + Merge ohne Full-Overwrite).
- [ ] Auto-Backup zu mind. einem Ziel (WebDAV oder Drive/Dropbox) manuell + Zeitplan.
- [ ] Share-Link lesend/editierend mit Ablaufdatum; Live-Cursor bei 2 Clients sichtbar.
- [ ] Audio-Recording mit Stroke-Timestamps: Tap-auf-Stroke springt im Audio (±2 s).
- [ ] Transkript speicherbar/durchsuchbar (oder begründet deaktivierbar V1).
- [ ] Ask-AI: Summarize/Quiz/Mindmap für aktuelle Seite, Credits/Modus (on-device/Cloud) transparent.
- [ ] Kein Tracking ohne Opt-in; Cloud-Features ohne Account lesbar dokumentiert (offline geht immer).

## 5. Verifikation

- Manuell: offline editieren → online syncen (kein Verlust); Backup + Restore; 2-Browser-Share mit Live-Cursor; 1-min-Audio + Tap-Sync; AI-Aktionen je 1× (beide Modi falls vorhanden).
- Automatisiert: `tests/cloud-sync.test.js` (+ neu `tests/share-audio-ai.test.js`): Sync-Queue/Merge (CRDT-LWW pro Stroke), Share-Link-Token/Ablauf, Timestamp-Mapping Stroke↔Audio, AI-Credit-Deduktion (Mock-Provider). Laufen lassen mit `npm test`.

## 6. Grimoire-Aufwand

L (Sync-Merge + Collab + Audio-Sync je M; AI-Integration S–M mit Mock).

## 7. Offene Entscheidung

Echter Collab-Server (WebSocket/CRDT-Lib) oder Share nur als Datei-Link V1? AI on-device (WASM-Modell) oder nur Cloud-API mit eigenem Key?
