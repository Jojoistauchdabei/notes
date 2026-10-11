/* Federwerk Craft-Katalog – die Apps aus der GitHub-Organisation `storytold`.
 *
 * Federwerk baut keine eigene Office-Oberflaeche mehr (SPEC-40, alte Fassung):
 * Word-, Excel- und PowerPoint-Dokumente werden in WordCraft, GridCraft und
 * DeckCraft bearbeitet, Bilder in PhotoCraft, Vektoren in VectorCraft, Layouts
 * in DesignCraft, PDFs in PdfCraft – also in den WASM-Builds der Upstream-Apps.
 * Diese Datei ist die einzige Quelle der Wahrheit darueber, welche Apps es gibt,
 * welche Dateiendungen sie oeffnen und wie sie gebaut werden:
 *
 *   scripts/build-crafts.js   -> holt/baut die Web-Builds nach dist/crafts/<id>/
 *   scripts/update-crafts.js  -> schreibt die gepinnten Upstream-Releases nach
 *                                crafts.lock.json (bei jedem Release neu)
 *   js/craft-store.js         -> Dokumentmodell (Buch mit craft-Feld + Datei)
 *   js/craft-ui.js            -> Bibliothekskarten, Badges, "+ Neu"-Menue
 *   js/craft-host.js          -> laedt die App und schiebt die Datei hinein
 *
 * Bewusst reine Daten plus Funktionen ohne DOM: unter `node --test` genauso
 * ladbar wie im Browser.
 *
 * Die Endungslisten sind aus den Upstream-Quellen uebernommen (apps/<id>-web,
 * Datei web.rs bzw. die README der App) – nicht geraten. Die erste Endung ist
 * die, in der Federwerk neue Dokumente anlegt (upstream schreibt sie nativ).
 *
 * Was hier NICHT steht: Versionen. Die stehen in crafts.lock.json und werden
 * bei jedem Release gegen die neuesten Upstream-Releases aufgeloest.
 */
(function () {
  'use strict';

  /* ---- Upstream-Apps ------------------------------------------------------ */

  const CRAFTS = [
    {
      id: 'wordcraft',
      repo: 'storytold/wordcraft',
      name: 'WordCraft',
      label: 'Word',
      vendor: 'Microsoft Word',
      kind: 'doc',
      group: 'office',
      icon: '📄',
      color: '#2b579a',
      exts: ['docx', 'docm', 'dotx', 'odt', 'rtf', 'txt', 'md', 'html', 'htm', 'json'],
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      canvasId: 'wordcraft_canvas',
      build: { tool: 'trunk', app: 'apps/wordcraft-web' },
      note: 'Dokumente: DOCX, ODT, RTF, Text, Markdown',
    },
    {
      id: 'gridcraft',
      repo: 'storytold/gridcraft',
      name: 'GridCraft',
      label: 'Excel',
      vendor: 'Microsoft Excel',
      kind: 'sheet',
      group: 'office',
      icon: '📊',
      color: '#217346',
      exts: ['xlsx', 'xlsm', 'csv', 'tsv', 'txt', 'json'],
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      canvasId: 'gridcraft_canvas',
      build: { tool: 'trunk', app: 'apps/gridcraft-web' },
      note: 'Tabellen: XLSX, XLSM, CSV, TSV',
    },
    {
      id: 'deckcraft',
      repo: 'storytold/deckcraft',
      name: 'DeckCraft',
      label: 'PowerPoint',
      vendor: 'Microsoft PowerPoint',
      kind: 'slides',
      group: 'office',
      icon: '📽️',
      color: '#d24726',
      exts: ['pptx', 'potx', 'ppsx', 'deckcraft', 'txt', 'md'],
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      canvasId: 'deckcraft_canvas',
      build: { tool: 'trunk', app: 'apps/deckcraft-web' },
      note: 'Praesentationen: PPTX, POTX, PPSX',
    },
    {
      id: 'pdfcraft',
      repo: 'storytold/pdfcraft',
      name: 'PdfCraft',
      label: 'PDF',
      vendor: 'Adobe Acrobat',
      kind: 'pdf',
      group: 'adobe',
      icon: '📕',
      color: '#b30b00',
      exts: ['pdf'],
      mime: 'application/pdf',
      canvasId: 'pdfcraft_canvas',
      build: { tool: 'trunk', app: 'apps/pdfcraft-web' },
      note: 'PDF lesen, ordnen, schuetzen',
    },
    {
      id: 'photocraft',
      repo: 'storytold/photocraft',
      name: 'PhotoCraft',
      label: 'Photoshop',
      vendor: 'Adobe Photoshop',
      kind: 'image',
      group: 'adobe',
      icon: '🖌️',
      color: '#31a8ff',
      exts: ['pcraft', 'psd', 'psb', 'psdt', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'gif', 'bmp', 'tga', 'exr', 'hdr', 'heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'svg', 'svgz', 'af', 'afdesign', 'afphoto'],
      mime: 'image/vnd.adobe.photoshop',
      canvasId: 'photocraft_canvas',
      build: { tool: 'trunk', app: 'apps/photocraft-web' },
      note: 'Pixelbilder: PSD, PSB, PNG, JPEG, TIFF, WebP, EXR, RAW',
    },
    {
      id: 'vectorcraft',
      repo: 'storytold/vectorcraft',
      name: 'VectorCraft',
      label: 'Illustrator',
      vendor: 'Adobe Illustrator',
      kind: 'vector',
      group: 'adobe',
      icon: '✒️',
      color: '#ff9a00',
      exts: ['svg', 'svgz', 'ai', 'eps', 'pdf', 'dxf', 'emf', 'wmf'],
      mime: 'image/svg+xml',
      canvasId: 'vectorcraft_canvas',
      build: { tool: 'trunk', app: 'apps/vectorcraft-web' },
      note: 'Vektoren: SVG, PDF-kompatibles .ai, EPS, DXF, EMF/WMF',
    },
    {
      id: 'designcraft',
      repo: 'storytold/designcraft',
      name: 'DesignCraft',
      label: 'InDesign',
      vendor: 'Adobe InDesign',
      kind: 'layout',
      group: 'adobe',
      icon: '📐',
      color: '#ff3366',
      exts: ['designcraft', 'idml', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'tif', 'tiff', 'bmp', 'psd', 'svg', 'pdf'],
      mime: 'application/vnd.adobe.indesign-idml-package',
      canvasId: 'designcraft_canvas',
      build: { tool: 'trunk', app: 'apps/designcraft-web' },
      note: 'Satz und Layout: IDML',
    },
    {
      id: 'lightcraft',
      repo: 'storytold/lightcraft',
      name: 'LightCraft',
      label: 'Lightroom',
      vendor: 'Adobe Lightroom',
      kind: 'photo',
      group: 'adobe',
      icon: '🌤️',
      color: '#0a4a7a',
      exts: ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp', 'dng', 'cr2', 'nef', 'arw', 'psd', 'jxl', 'gif', 'bmp'],
      mime: 'image/jpeg',
      canvasId: 'lightcraft_canvas',
      api: 'lightcraft',
      /* LightCraft hat kein eigenes Projektformat: die Bibliothek ist ein
       * Katalog, die Bilder kommen von aussen. In Federwerk gibt es deshalb
       * keinen "Neues LightCraft-Dokument"-Knopf, nur Import. */
      create: false,
      build: { tool: 'xtask', app: 'apps/lightcraft-web', out: 'target/web/dist' },
      note: 'Fotobibliothek und RAW-Entwicklung',
    },
    {
      id: 'filmcraft',
      repo: 'storytold/filmcraft',
      name: 'FilmCraft',
      label: 'Premiere',
      vendor: 'Adobe Premiere Pro',
      kind: 'video',
      group: 'adobe',
      icon: '🎬',
      color: '#7d2ae8',
      exts: ['fcproj', 'mp4', 'm4v', 'mov', 'mkv', 'webm'],
      mime: 'application/x-filmcraft-project',
      canvasId: 'filmcraft_canvas',
      api: 'filmcraft',
      build: { tool: 'xtask', app: 'apps/filmcraft-web', out: 'target/web/dist' },
      note: 'Schnitt: .fcproj, MP4/MOV/Matroska/WebM',
    },
    {
      id: 'effectcraft',
      repo: 'storytold/effectcraft',
      name: 'EffectCraft',
      label: 'After Effects',
      vendor: 'Adobe After Effects',
      kind: 'effects',
      group: 'adobe',
      icon: '✨',
      color: '#6a4cff',
      exts: ['ecproj', 'mp4', 'mov', 'png', 'jpg', 'tif', 'wav', 'mp3'],
      mime: 'application/x-effectcraft-project',
      canvasId: 'effectcraft_canvas',
      api: 'effectcraft',
      build: { tool: 'xtask', app: 'apps/effectcraft-web', out: 'target/web/dist' },
      note: 'Motion Graphics und Compositing: .ecproj',
    },
    {
      id: 'cadcraft',
      repo: 'storytold/cadcraft',
      name: 'CadCraft',
      label: 'CAD',
      vendor: 'AutoCAD',
      kind: 'cad',
      group: 'adobe',
      icon: '📏',
      color: '#0f9d58',
      exts: ['dxf', 'dwg', 'svg', 'png', 'pdf'],
      mime: 'image/vnd.dxf',
      canvasId: 'cadcraft_canvas',
      build: { tool: 'trunk', app: 'apps/cadcraft-web' },
      note: 'Technisches Zeichnen: DXF, DWG, SVG',
    },
    {
      id: 'soundcraft',
      repo: 'storytold/soundcraft',
      name: 'SoundCraft',
      label: 'Audio',
      vendor: 'Avid Pro Tools',
      kind: 'audio',
      group: 'adobe',
      icon: '🎧',
      color: '#1db954',
      exts: ['wav', 'aif', 'aiff', 'mp3', 'flac', 'ogg', 'opus', 'm4a'],
      mime: 'audio/wav',
      canvasId: 'soundcraft_canvas',
      build: { tool: 'trunk', app: 'apps/soundcraft-web' },
      note: 'Audio: WAV, AIFF, MP3, FLAC, OGG, Opus',
    },
  ];

  /* ---- Nachschlagen ------------------------------------------------------- */


  const BY_ID = {};
  for (const c of CRAFTS) BY_ID[c.id] = c;

  /* Endung -> Craft.
   *
   * `OWNS` ist die Liste der Endungen, fuer die ein Craft der Standard ist
   * (Doppelklick in der Bibliothek, Import-Routing). Viele Formate koennen
   * mehrere Apps oeffnen – .png sowohl PhotoCraft als auch DesignCraft – aber
   * nur eine darf gewinnen. Die Zuordnung ist deshalb ausdruecklich und wird
   * von problems() auf Eindeutigkeit geprueft, nicht aus der Reihenfolge des
   * Katalogs geraten. Endungen, die mehrere Crafts oeffnen koennen, stehen
   * weiterhin in `exts` (dort steht die Wahrheit ueber die Faehigkeiten). */
  const OWNS = {
    wordcraft: ['docx', 'docm', 'dotx', 'odt', 'rtf', 'txt', 'md', 'html', 'htm', 'json'],
    gridcraft: ['xlsx', 'xlsm', 'csv', 'tsv'],
    deckcraft: ['pptx', 'potx', 'ppsx', 'deckcraft'],
    pdfcraft: ['pdf'],
    photocraft: ['pcraft', 'psd', 'psb', 'psdt', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'webp', 'gif', 'bmp', 'tga', 'exr', 'hdr', 'heic', 'heif', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'af', 'afdesign', 'afphoto'],
    vectorcraft: ['svg', 'svgz', 'ai', 'eps', 'emf', 'wmf'],
    designcraft: ['designcraft', 'idml'],
    lightcraft: ['jxl'],
    filmcraft: ['fcproj', 'mp4', 'm4v', 'mov', 'mkv', 'webm'],
    effectcraft: ['ecproj'],
    cadcraft: ['dxf', 'dwg'],
    soundcraft: ['wav', 'aif', 'aiff', 'mp3', 'flac', 'ogg', 'opus', 'm4a'],
  };

  const BY_EXT = {};
  for (const c of CRAFTS) {
    for (const e of (OWNS[c.id] || [c.exts[0]])) BY_EXT[e] = c.id;
  }


  const OFFICE_IDS = CRAFTS.filter((c) => c.group === 'office').map((c) => c.id);

  function byId(id) {
    return BY_ID[String(id || '')] || null;
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
    return m ? m[1].toLowerCase() : '';
  }

  /* Craft zu einem Dateinamen (Endung) oder null. */
  function forFileName(name) {
    return byId(BY_EXT[extOf(name)] || '');
  }

  /* Craft zu einer Endung, ohne Punkt. */
  function forExt(ext) {
    return byId(BY_EXT[String(ext || '').toLowerCase().replace(/^\./, '')] || '');
  }

  /* Die Endung, in der neue Dokumente angelegt werden. */
  function primaryExt(craft) {
    const c = typeof craft === 'string' ? byId(craft) : craft;
    return c && c.exts && c.exts.length ? c.exts[0] : 'bin';
  }

  function mimeFor(craftOrId, ext) {
    const c = typeof craftOrId === 'string' ? byId(craftOrId) : craftOrId;
    if (!c) return 'application/octet-stream';
    const e = String(ext || '').toLowerCase().replace(/^\./, '');
    if (e && e !== c.exts[0]) {
      // Bekannte Nebendateien mit eigenem Typ (sonst der Haupttyp des Crafts).
      if (e === 'pdf') return 'application/pdf';
      if (e === 'svg' || e === 'svgz') return 'image/svg+xml';
      if (e === 'png') return 'image/png';
      if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
      if (e === 'webp') return 'image/webp';
      if (e === 'txt' || e === 'md') return 'text/plain';
      if (e === 'csv' || e === 'tsv') return 'text/csv';
      if (e === 'json') return 'application/json';
    }
    return c.mime;
  }

  function isOfficeCraft(id) {
    return OFFICE_IDS.indexOf(String(id || '')) >= 0;
  }

  /* Anzeige-Daten fuer Badge/Karte in der Bibliothek. */
  function badge(craftOrId) {
    const c = typeof craftOrId === 'string' ? byId(craftOrId) : craftOrId;
    if (!c) return null;
    return { id: c.id, icon: c.icon, label: c.label, name: c.name, color: c.color, vendor: c.vendor, kind: c.kind };
  }

  function ids() {
    return CRAFTS.map((c) => c.id);
  }

  /* Prueft den Katalog gegen sich selbst: doppelte IDs, fehlende Pflichtfelder,
   * unbekannte Build-Werkzeuge und doppelt vergebene Standard-Endungen. Wird von
   * scripts/build-crafts.js und tests/craft-catalog.test.js benutzt – ein
   * kaputter Katalog soll den Build rot machen, nicht still ein falsches dist/
   * erzeugen. Rueckgabe: Liste von Fehlertexten (leer = in Ordnung). */
  function problems() {
    const out = [];
    const seenId = new Set();
    const ownerOf = {};
    for (const c of CRAFTS) {
      if (!c.id || seenId.has(c.id)) out.push('doppelte oder fehlende id: ' + c.id);
      seenId.add(c.id);
      for (const f of ['repo', 'name', 'label', 'kind', 'mime', 'canvasId']) {
        if (!c[f]) out.push(c.id + ': ' + f + ' fehlt');
      }
      if (!Array.isArray(c.exts) || !c.exts.length) out.push(c.id + ': exts fehlen');
      if (!c.build || !c.build.tool || !c.build.app) out.push(c.id + ': build fehlt');
      else if (['trunk', 'xtask'].indexOf(c.build.tool) < 0) out.push(c.id + ': unbekanntes build.tool ' + c.build.tool);
      const owns = OWNS[c.id];
      if (!owns || !owns.length) out.push(c.id + ': owns fehlt');
      else {
        for (const e of owns) {
          if (ownerOf[e]) out.push('Endung .' + e + ' doppelt vergeben: ' + ownerOf[e] + ' und ' + c.id);
          else ownerOf[e] = c.id;
          if ((c.exts || []).indexOf(e) < 0) out.push(c.id + ': owns .' + e + ', aber nicht in exts');
        }
        if (c.create !== false && c.exts && c.exts[0] !== owns[0]) {
          out.push(c.id + ': erste Endung (' + c.exts[0] + ') ist nicht die Standard-Endung (' + owns[0] + ')');
        }
      }
    }
    return out;
  }

  /* Endungen, die mehrere Crafts oeffnen koennen – nur zur Information (Doku,
   * Hinweis in der Oberflaeche: "kann auch in X geoeffnet werden"). */
  function sharedExts() {
    const map = {};
    for (const c of CRAFTS) for (const e of c.exts) (map[e] = map[e] || []).push(c.id);
    const out = {};
    for (const e of Object.keys(map)) if (map[e].length > 1) out[e] = map[e];
    return out;
  }

  const Catalog = {
    CRAFTS, OFFICE_IDS, OWNS, byId, ids, forExt, forFileName, extOf, primaryExt, mimeFor,
    isOfficeCraft, badge, problems, sharedExts,
    get count() { return CRAFTS.length; },
  };

  if (typeof window !== 'undefined') window.FederwerkCraftCatalog = Catalog;
  if (typeof module !== 'undefined' && module.exports) module.exports = Catalog;
})();

