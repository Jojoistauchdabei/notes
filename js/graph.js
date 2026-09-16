/* Grimoire Graph View light (SPEC-09 light, V1) – lokaler + globaler Graph, kein Cloud.
 *
 * - Reine Funktionen, bewusst ohne Browser-APIs: per <script> im Browser
 *   (global GrimoireGraph) und per require() in Node-Tests ladbar.
 * - Knoten = Bücher (Titel-Match, case-insensitiv; Aliase aus [[Ziel|Alias]]
 *   werden auf das Ziel reduziert – nur Titel, keine Alias-Auflösung).
 * - Kanten = [[Wikilink]]-Treffer in allen Textboxen (texts[].html aller
 *   Seiten). Unbekannte Ziele (kein Buch mit diesem Titel) erzeugen V1
 *   keine Kante und keinen Dangling-Knoten.
 * - localGraph(graph, title, depth): BFS-Nachbarschaft, Kanten werden dabei
 *   UNGERICHTET traversiert (Rücklinks zählen zur Nachbarschaft, wie in
 *   Obsidians Local Graph); zurückgegebene Kanten bleiben gerichtet
 *   ({from, to}), gefiltert auf die sichtbare Teilmenge.
 * - V1-Limit (dokumentiert): statisches Radial-/Kreis-Layout in der UI,
 *   keine Force-Simulation, kein Pan/Zoom, keine Filter-/Gruppen-Regeln.
 */
var GrimoireGraph = (function () {
  'use strict';

  var WIKILINK_RE = /\[\[([^\[\]\n]+?)\]\]/g;

  /* Extrahiert Link-Ziele aus Markdown-Quelle ODER gerendertem HTML
   * (Wikilinks bleiben in beiden als [[...]] erhalten, vgl. js/markdown.js).
   * - Alias nach | abtrennen ([[Ziel|Anzeige]] -> "Ziel")
   * - #Subpath / Block-ID abtrennen ([[Seite#Kapitel]], [[Seite#^block]])
   * - trimmen; leere Ziele ([[#nur-hash]], [[|nur-alias]], [[]]) ignorieren
   * Gibt Treffer in Text-Reihenfolge zurück, Duplikate bleiben erhalten
   * (Deduplizierung passiert in buildGraph auf Kanten-Ebene). */
  function extractWikilinks(input) {
    var out = [];
    if (input == null) return out;
    var s = String(input);
    if (!s) return out;
    WIKILINK_RE.lastIndex = 0;
    var m;
    while ((m = WIKILINK_RE.exec(s)) !== null) {
      var inner = m[1];
      var pipe = inner.indexOf('|');
      if (pipe !== -1) inner = inner.slice(0, pipe);
      var hash = inner.indexOf('#');
      if (hash !== -1) inner = inner.slice(0, hash);
      var target = inner.trim();
      if (target) out.push(target);
    }
    return out;
  }

  function bookTextSources(book) {
    var out = [];
    if (!book || !Array.isArray(book.pages)) return out;
    for (var i = 0; i < book.pages.length; i++) {
      var p = book.pages[i];
      if (!p || !Array.isArray(p.texts)) continue;
      for (var k = 0; k < p.texts.length; k++) {
        var t = p.texts[k];
        if (t && t.html != null) out.push(String(t.html));
      }
    }
    return out;
  }

  /* Baut den globalen Graphen aus state.books[].
   * nodes: [{id, title, bookId, pages}] (pages = Seitenanzahl)
   * edges: [{from, to}] (Buch-IDs, gerichtet, dedupliziert;
   *   Selbstlinks [[Eigenes Buch]] sind als Loop-Kante enthalten). */
  function buildGraph(books) {
    var list = Array.isArray(books) ? books : [];
    var nodes = list.map(function (b) {
      var title = (b && b.title != null) ? String(b.title) : 'Unbenannt';
      return {
        id: b ? b.id : undefined,
        title: title,
        bookId: b ? b.id : undefined,
        pages: (b && Array.isArray(b.pages)) ? b.pages.length : 0
      };
    });
    // Titel-Index (case-insensitiv, getrimmt; erster Treffer gewinnt)
    var byTitle = {};
    for (var i = 0; i < nodes.length; i++) {
      var key = String(nodes[i].title).trim().toLowerCase();
      if (!(key in byTitle)) byTitle[key] = nodes[i].id;
    }
    var edges = [];
    var seen = {};
    list.forEach(function (b) {
      if (!b) return;
      var from = b.id;
      bookTextSources(b).forEach(function (src) {
        extractWikilinks(src).forEach(function (target) {
          var to = byTitle[String(target).trim().toLowerCase()];
          if (to === undefined) return; // unbekanntes Ziel -> V1: keine Kante
          var edgeKey = from + '→' + to;
          if (seen[edgeKey]) return; // Duplikate: nur eine Kante pro Paar
          seen[edgeKey] = true;
          edges.push({ from: from, to: to });
        });
      });
    });
    return { nodes: nodes, edges: edges };
  }

  /* Teilgraph um das Buch mit Titel `title` (case-insensitiv), BFS mit
   * Tiefe `depth` (Default 1). Unbekannter Titel -> {nodes: [], edges: []}. */
  function localGraph(graph, title, depth) {
    var d = (depth == null) ? 1 : Math.max(0, depth | 0);
    var nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
    var edges = (graph && Array.isArray(graph.edges)) ? graph.edges : [];
    var want = String(title == null ? '' : title).trim().toLowerCase();
    var start = null;
    for (var i = 0; i < nodes.length; i++) {
      if (String(nodes[i].title == null ? '' : nodes[i].title).trim().toLowerCase() === want) {
        start = nodes[i];
        break;
      }
    }
    if (!start) return { nodes: [], edges: [] };
    // Ungerichtete Adjazenz für die Nachbarschafts-Suche
    var adj = {};
    nodes.forEach(function (n) { adj[n.id] = []; });
    edges.forEach(function (e) {
      if (adj[e.from] && adj[e.to]) {
        if (adj[e.from].indexOf(e.to) === -1) adj[e.from].push(e.to);
        if (adj[e.to].indexOf(e.from) === -1) adj[e.to].push(e.from);
      }
    });
    var visited = {};
    visited[start.id] = 0;
    var queue = [start.id];
    while (queue.length) {
      var cur = queue.shift();
      if (visited[cur] >= d) continue;
      adj[cur].forEach(function (nb) {
        if (!(nb in visited)) {
          visited[nb] = visited[cur] + 1;
          queue.push(nb);
        }
      });
    }
    return {
      nodes: nodes.filter(function (n) { return n.id in visited; }),
      edges: edges.filter(function (e) { return (e.from in visited) && (e.to in visited); })
    };
  }

  return {
    extractWikilinks: extractWikilinks,
    buildGraph: buildGraph,
    localGraph: localGraph
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GrimoireGraph;
