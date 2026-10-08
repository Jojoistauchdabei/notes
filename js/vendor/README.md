# Vendored Abhängigkeiten

`js/vendor/` enthält Fremdcode, **byteweise unverändert** aus dem
npm-Original. Nicht bearbeiten, nicht minifizieren – bei einem Update die
Dateien aus dem Paket neu kopieren und die Version hier notieren.

## markdown-wasm

- Quelle: <https://github.com/rsms/markdown-wasm>
- Paket: `markdown-wasm` (Version siehe `markdown-wasm.package.json`)
- Lizenz: MIT, Text in `markdown-wasm.LICENSE`
- Übernommen aus: `dist/markdown.js` (UMD) + `dist/markdown.wasm`

Wird als Markdown-Parser benutzt (CommonMark + GFM: Tabellen, Strikethrough,
Aufgabenlisten, Autolinks), auf der Seite `md.html` und in den Tests.

Warum vendored statt CDN oder `node_modules`:

- Die App läuft offline (PWA) und lädt sonst nach; ein CDN würde den Editor
  beim ersten Start aussperren.
- `npm test` und `npm run build` brauchen weiterhin **keine** Installation –
  `tests/md-editor.test.js` holt sich den Parser per `require()` aus diesem
  Verzeichnis, der Browser über ein `<script>` in `md.html`.
- Kein Bundling: `js/vendor/markdown.js` löst die `.wasm` zur Laufzeit relativ
  zum eigenen Skript auf. Deshalb trägt sein `<script>`-Tag in `md.html` das
  Attribut `data-wasm` – `build-dist.js` bündelt nur Skript-Tags **ohne**
  Attribute, sonst wäre der Pfad im Bundle kaputt.