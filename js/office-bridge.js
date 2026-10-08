/* Federwerk Office Bridge -- Mapping zwischen Federwerks Office-Modell und dem
 * JSON-Vertrag der WordCraft-Crates (office-wasm).
 *
 * office-engine.js kann Bytes in JSON wandeln und zurueck, weiss aber nichts
 * ueber Federwerks Blockstruktur. Dieses Modul ist die Uebersetzung:
 *
 *   toDocJson(buch)      -> JSON-String fuer jsonToDocx()
 *   fromDocJson(json)    -> { title, blocks, warnungen } fuer den Writer
 *
 * Bewusst reines Logikmodul ohne DOM-Zugriff, damit es unter `node --test`
 * lauffaehig ist und dieselbe Datei im Browser laedt.
 *
 * Der JSON-Vertrag ist aus wordcraft-doc @ db0cfed festgeschrieben:
 *   Document { body: [Block], core: CoreProps, ... }   serde(default, camelCase)
 *   Block     = { kind: "para" | "table", ... }        intern getaggte Enum
 *   Paragraph { text: String, runs: [{ len, props }], props: { style, ... } }
 *   CharProps { bold, italic, strike, ... }             Option<bool>
 *
 * Was bewusst nicht abgebildet wird und warum:
 * - Unterstreichung: CharProps.underline ist eine Enum, deren Variante hier
 *   nicht verifiziert ist. Rate ich nicht, also geht sie beim Export verloren
 *   (der Text bleibt, die Linie nicht).
 * - Tabellen: Block::Table traegt Zeilen/Cells, deren Serialize-Form hier nicht
 *   geoeffnet wurde. Beim Import werden sie flach als Text uebernommen und
 *   gemeldet, statt Zeilen zu erfinden.
 * - Numbering fuer ol: ParaProps.numbering braucht eine vollstaendige
 *   Numbering-Definition. Statt zu raten, gehen beide Listentypen als
 *   ListParagraph raus (gueltiger eingebauter Style) und kommen als ul zurueck.
 */
(function () {
  'use strict';

  /* WordCraft-Style-IDs der eingebauten Stylesheet. */
  const HEADING_STYLE = { h1: 'Heading1', h2: 'Heading2', h3: 'Heading3' };
  const STYLE_TYPE = { Heading1: 'h1', Heading2: 'h2', Heading3: 'h3', ListParagraph: 'ul' };
  const LIST_STYLE = 'ListParagraph';

  /* WordCraft kennt keinen Trennblock. 'hr' wird deshalb als Absatz mit genau
   * diesem Text abgebildet - im Word sieht man eine Zeile Bindestriche, und der
   * Round-Trip laesst den Block wieder zu hr werden. */
  const HR_MARK = '---';

  const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code', 'hr'];

  let zaehler = 0;
  function uid(prefix) {
    zaehler += 1;
    return prefix + '_b' + zaehler;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* Nur die Entities, die WordCraft bzw. der Writer erzeugen. */
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, '\u00a0')
      .replace(/&amp;/g, '&');
  }

  /* Zerlegt Inline-HTML in Textstuecke mit Auszeichnung. Unbekannte Tags
   * (a, span, ...) zaehlen als transparent - ihr Text bleibt erhalten. */
  function tokensFromHtml(html) {
    const out = [];
    const st = { bold: 0, italic: 0, strike: 0 };
    const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>|([^<]+)/g;
    let m;
    while ((m = re.exec(String(html == null ? '' : html))) !== null) {
      if (m[3] !== undefined) {
        const t = decodeEntities(m[3]);
        if (t) out.push({ text: t, bold: st.bold > 0, italic: st.italic > 0, strike: st.strike > 0 });
        continue;
      }
      const schliessend = m[1] === '/';
      const tag = m[2].toLowerCase();
      if (tag === 'strong' || tag === 'b') st.bold = Math.max(0, st.bold + (schliessend ? -1 : 1));
      else if (tag === 'em' || tag === 'i') st.italic = Math.max(0, st.italic + (schliessend ? -1 : 1));
      else if (tag === 's' || tag === 'strike' || tag === 'del') st.strike = Math.max(0, st.strike + (schliessend ? -1 : 1));
    }
    return out;
  }

  /* Vereinheitlicht die Auszeichnung direkt benachbarter Stuecke, damit die
   * Runs nicht ueber jedes Wort zerreissen. */
  function runsFromTokens(tokens) {
    const runs = [];
    let sigs = [];
    for (const t of tokens) {
      const props = {};
      if (t.bold) props.bold = true;
      if (t.italic) props.italic = true;
      if (t.strike) props.strike = true;
      // Signatur statt Objektvergleich: die Runs bleiben schlichte Daten.
      const sig = (props.bold ? 'b' : '') + (props.italic ? 'i' : '') + (props.strike ? 's' : '');
      const last = runs[runs.length - 1];
      if (last && sigs[sigs.length - 1] === sig) last.len += t.text.length;
      else { runs.push({ len: t.text.length, props }); sigs.push(sig); }
    }
    // Ohne jede Auszeichnung gibt es nichts zu formatieren: leere Runs.
    return sigs.some((s) => s) ? runs : [];
  }

  function runsToHtml(text, runs) {
    if (!Array.isArray(runs) || !runs.length) return escapeHtml(text);
    let out = '';
    let pos = 0;
    for (const r of runs) {
      const len = Math.max(0, Number(r && r.len) || 0);
      if (!len) continue;
      const stueck = String(text).slice(pos, pos + len);
      pos += len;
      if (stueck) out += verpacken(stueck, r.props);
    }
    if (pos < String(text).length) out += escapeHtml(String(text).slice(pos));
    return out;
  }

  function verpacken(text, props) {
    let h = escapeHtml(text);
    if (!props) return h;
    if (props.strike) h = '<s>' + h + '</s>';
    if (props.italic) h = '<em>' + h + '</em>';
    if (props.bold) h = '<strong>' + h + '</strong>';
    return h;
  }

  function textAusNode(node, acc) {
    if (node == null) return acc;
    if (typeof node === 'string') { acc.push(node); return acc; }
    if (Array.isArray(node)) { for (const n of node) textAusNode(n, acc); return acc; }
    if (typeof node !== 'object') return acc;
    if (typeof node.text === 'string') acc.push(node.text);
    else if (typeof node.html === 'string') acc.push(node.html.replace(/<[^>]*>/g, ''));
    for (const k of Object.keys(node)) {
      if (k === 'text' || k === 'html' || k === 'props') continue;
      const v = node[k];
      if (v && typeof v === 'object') textAusNode(v, acc);
    }
    return acc;
  }

  /* Federwerk-Buch -> Document.body */
  function toBody(blocks) {
    const body = [];
    for (const b of blocks || []) {
      const type = BLOCK_TYPES.indexOf(b && b.type) >= 0 ? b.type : 'p';
      if (type === 'hr') {
        body.push({ kind: 'para', text: HR_MARK, runs: [] });
        continue;
      }
      const tokens = tokensFromHtml(b.html);
      const para = { kind: 'para', text: tokens.map((t) => t.text).join(''), runs: runsFromTokens(tokens) };
      const props = {};
      if (HEADING_STYLE[type]) props.style = HEADING_STYLE[type];
      else if (type === 'ul' || type === 'ol') props.style = LIST_STYLE;
      if (Object.keys(props).length) para.props = props;
      body.push(para);
    }
    if (!body.length) body.push({ kind: 'para', text: '', runs: [] });
    return body;
  }

  function toDocJson(book) {
    const o = (book && book.office) || {};
    const doc = { body: toBody(o.blocks) };
    const titel = String((book && book.title) || '').trim();
    if (titel) doc.core = { title: titel };
    return JSON.stringify(doc);
  }

  /* Document.body -> Federwerk-Bloecke */
  function toBlocks(body) {
    const blocks = [];
    let tabellen = 0;
    for (const b of body || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.kind === 'table') {
        tabellen += 1;
        const text = textAusNode(b, []).join(' ').replace(/[ \t]+/g, ' ').trim();
        if (text) blocks.push({ id: uid('b'), type: 'p', html: escapeHtml(text) });
        continue;
      }
      if (b.kind !== 'para') continue;
      const text = String(b.text == null ? '' : b.text);
      if (text.trim() === HR_MARK) {
        blocks.push({ id: uid('b'), type: 'hr', html: '' });
        continue;
      }
      const style = b.props && b.props.style ? String(b.props.style) : '';
      blocks.push({
        id: uid('b'),
        type: STYLE_TYPE[style] || 'p',
        html: runsToHtml(text, Array.isArray(b.runs) ? b.runs : []),
      });
    }
    if (!blocks.length) blocks.push({ id: uid('b'), type: 'p', html: '' });
    const warnungen = [];
    if (tabellen) {
      warnungen.push(tabellen + ' Tabelle(n) als Text uebernommen - WordCraft liefert sie zurueck, der Writer zeigt sie flach.');
    }
    return { blocks, warnungen };
  }

  function fromDocJson(json) {
    const doc = typeof json === 'string' ? JSON.parse(json) : json;
    if (!doc || typeof doc !== 'object') throw new Error('Kein WordCraft-Dokument.');
    const ergebnis = toBlocks(Array.isArray(doc.body) ? doc.body : []);
    const titel = doc.core && doc.core.title ? String(doc.core.title) : '';
    return { title: titel, blocks: ergebnis.blocks, warnungen: ergebnis.warnungen };
  }

  /* Dateiname fuer den Download. */
  function fileName(book, ext) {
    const roh = String((book && book.title) || 'dokument')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    return (roh || 'dokument') + '.' + ext;
  }

  const Bridge = {
    toDocJson, fromDocJson, fileName,
    toBody, toBlocks, tokensFromHtml, runsFromTokens, runsToHtml, escapeHtml, decodeEntities,
    HEADING_STYLE, STYLE_TYPE, LIST_STYLE, HR_MARK, BLOCK_TYPES,
  };

  if (typeof window !== 'undefined') window.FederwerkOfficeBridge = Bridge;
  if (typeof module !== 'undefined' && module.exports) module.exports = Bridge;
})();