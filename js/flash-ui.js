/* Federwerk – Karteikarten-UI: Deck-Ansicht (CRUD) + Lernmodus (SM-2).
 *
 * - Nutzt window.state (app.js), FederwerkFlashcards (SM-2) und GrimoireStore
 *   (Bild-Blobs). Kein Build, plain <script> nach app.js.
 * - Ein Overlay (#flashOverlay) mit zwei Modi: 'cards' (verwalten) und
 *   'learn' (lernen). Alles offline, keine Cloud nötig.
 * - Globale Funktionen für onclick-Handler in index.html + renderLibrary.
 */
(function () {
  'use strict';

  var deckId = null;
  var mode = 'cards'; // 'cards' | 'learn' | 'stats'
  var editingId = null;
  var session = [];
  var sessIdx = 0;
  var flipped = false;
  var sessCorrect = 0;
  var sessGraded = 0;
  var pendingImg = { frontImg: null, backImg: null };
  // Lernstand-Liste: Filter/Sortierung/Suche (bleiben pro geöffnetem Deck erhalten)
  var listQuery = '';
  var listFilter = 'all';
  var listSort = 'due';

  function FC() {
    return (typeof window !== 'undefined' && window.FederwerkFlashcards) ? window.FederwerkFlashcards : null;
  }
  function S() {
    try { return (typeof window !== 'undefined' && window.state) ? window.state : null; }
    catch (e) { return null; }
  }
  function deck() {
    var s = S();
    if (!s || !deckId) return null;
    var b = (s.books || []).find(function (x) { return x && x.id === deckId; });
    if (b && FC()) { try { FC().ensureDeck(b); } catch (e) { /* tolerant */ } }
    return b || null;
  }
  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function imgUrl(ref) {
    if (!ref) return '';
    try {
      if (typeof GrimoireStore !== 'undefined' && GrimoireStore.url) {
        var u = GrimoireStore.url(ref);
        if (u) return u;
      }
    } catch (e) { /* Hintergrund-Load läuft */ }
    if (typeof ref === 'string' && ref.indexOf('data:image/') === 0) return ref;
    return '';
  }
  function touch() {
    try {
      var b = deck();
      if (b) b.updatedAt = Date.now();
      if (typeof persistSoon === 'function') persistSoon();
      if (typeof renderLibrary === 'function') renderLibrary();
    } catch (e) { /* ignore */ }
  }

  /* ---------- Öffnen / Schließen ---------- */

  function openDeckView(id, ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    var s = S();
    var b = s ? (s.books || []).find(function (x) { return x && x.id === id; }) : null;
    if (!b) return;
    deckId = id;
    mode = 'cards';
    editingId = null;
    listQuery = ''; listFilter = 'all'; listSort = 'due';
    pendingImg = { frontImg: null, backImg: null };
    var ov = $('flashOverlay');
    if (ov) ov.classList.add('active');
    renderDeck();
  }
  function openDeckLearn(id, ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    openDeckView(id, null);
    startLearn();
  }
  function openDeckStats(id, ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    openDeckView(id, null);
    mode = 'stats';
    renderDeck();
  }
  function closeDeckView() {
    var ov = $('flashOverlay');
    if (ov) ov.classList.remove('active');
    deckId = null;
    session = [];
    try { if (typeof renderLibrary === 'function') renderLibrary(); } catch (e) { /* ignore */ }
  }
  function switchMode(m) {
    mode = (m === 'learn') ? 'learn' : (m === 'stats' ? 'stats' : 'cards');
    renderDeck();
  }

  /* ---------- Karten-CRUD ---------- */

  function resetForm() {
    editingId = null;
    pendingImg = { frontImg: null, backImg: null };
    var f = $('flashFront'), bk = $('flashBack');
    if (f) f.value = '';
    if (bk) bk.value = '';
    renderImgPreview();
    var btn = $('flashSaveBtn');
    if (btn) btn.textContent = '➕ Karte hinzufügen';
    var cancel = $('flashCancelBtn');
    if (cancel) cancel.style.display = 'none';
  }
  function editCard(id) {
    var b = deck();
    if (!b) return;
    var c = (b.cards || []).find(function (x) { return x && x.id === id; });
    if (!c) return;
    editingId = id;
    pendingImg = { frontImg: c.frontImg || null, backImg: c.backImg || null };
    var f = $('flashFront'), bk = $('flashBack');
    if (f) f.value = FC() ? FC().stripTags(c.front) : String(c.front || '');
    if (bk) bk.value = FC() ? FC().stripTags(c.back) : String(c.back || '');
    renderImgPreview();
    var btn = $('flashSaveBtn');
    if (btn) btn.textContent = '💾 Speichern';
    var cancel = $('flashCancelBtn');
    if (cancel) cancel.style.display = '';
    try { if (f) f.focus(); } catch (e) { /* ignore */ }
  }
  function saveCard() {
    var b = deck();
    if (!b || !FC()) return;
    var f = $('flashFront'), bk = $('flashBack');
    var front = f ? f.value.trim() : '';
    var back = bk ? bk.value.trim() : '';
    if (!front && !back && !pendingImg.frontImg && !pendingImg.backImg) return;
    if (editingId) {
      var c = (b.cards || []).find(function (x) { return x && x.id === editingId; });
      if (c) {
        c.front = front; c.back = back;
        c.frontImg = pendingImg.frontImg; c.backImg = pendingImg.backImg;
        c.updatedAt = Date.now();
      }
    } else {
      var nc = FC().newCard(front, back);
      nc.frontImg = pendingImg.frontImg; nc.backImg = pendingImg.backImg;
      b.cards.unshift(nc);
    }
    resetForm();
    touch();
    renderDeck();
  }
  async function deleteCard(id, ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    var b = deck();
    if (!b) return;
    var ok = true;
    try {
      ok = (typeof FederwerkDialog !== 'undefined' && FederwerkDialog.confirm)
        ? await FederwerkDialog.confirm('Karte wirklich löschen?', { title: 'Karte löschen', danger: true }).catch(function () { return false; })
        : (typeof confirm !== 'undefined' ? confirm('Karte wirklich löschen?') : true);
    } catch (e) { ok = false; }
    if (!ok) return;
    b.cards = (b.cards || []).filter(function (c) { return !c || c.id !== id; });
    if (editingId === id) resetForm();
    touch();
    renderDeck();
  }
  function toggleSuspend(id, ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    var b = deck();
    if (!b) return;
    var c = (b.cards || []).find(function (x) { return x && x.id === id; });
    if (c) { c.suspended = !c.suspended; c.updatedAt = Date.now(); }
    touch();
    renderDeck();
  }
  function resetProgress(id, ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    var b = deck();
    if (!b || !FC()) return;
    var c = (b.cards || []).find(function (x) { return x && x.id === id; });
    if (!c) return;
    var fresh = FC().newCard(FC().stripTags(c.front), FC().stripTags(c.back));
    c.ease = fresh.ease; c.interval = fresh.interval; c.reps = fresh.reps;
    c.lapses = 0; c.due = Date.now(); c.lastReview = null;
    c.totalReviews = 0; c.correctReviews = 0;
    c.updatedAt = Date.now();
    touch();
    renderDeck();
  }

  /* ---------- Karten-Bilder (Blob-Store) ---------- */

  function renderImgPreview() {
    var pf = $('flashFrontImgPrev'), pb = $('flashBackImgPrev');
    var uf = imgUrl(pendingImg.frontImg), ub = imgUrl(pendingImg.backImg);
    if (pf) pf.innerHTML = uf ? '<img src="' + esc(uf) + '" alt="Bild Vorderseite"><button type="button" class="mini-button" onclick="deckRemoveImage(\'front\')">✕</button>' : '<span style="opacity:.6">Kein Bild</span>';
    if (pb) pb.innerHTML = ub ? '<img src="' + esc(ub) + '" alt="Bild Rückseite"><button type="button" class="mini-button" onclick="deckRemoveImage(\'back\')">✕</button>' : '<span style="opacity:.6">Kein Bild</span>';
  }
  function attachImage(side, ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    var inp = $('flashImgFile');
    if (!inp) return;
    inp.dataset.side = (side === 'back') ? 'back' : 'front';
    inp.click();
  }
  function onImagePicked(ev) {
    var files = ev && ev.target && ev.target.files;
    if (!files || !files.length) return;
    var side = (ev.target.dataset && ev.target.dataset.side === 'back') ? 'backImg' : 'frontImg';
    var file = files[0];
    ev.target.value = '';
    (async function () {
      try {
        var ref = (typeof GrimoireStore !== 'undefined' && GrimoireStore.putBlob)
          ? await GrimoireStore.putBlob(file)
          : null;
        if (!ref) {
          // Fallback: dataURL inline (kleine Bilder)
          ref = await new Promise(function (res, rej) {
            var r = new FileReader();
            r.onload = function () { res(String(r.result || '')); };
            r.onerror = function () { rej(new Error('lesen')); };
            r.readAsDataURL(file);
          });
        }
        pendingImg[side === 'backImg' ? 'backImg' : 'frontImg'] = ref;
        renderImgPreview();
      } catch (e) { alert('Bild konnte nicht eingefügt werden.'); }
    })();
  }
  function removeImage(side) {
    if (side === 'back') pendingImg.backImg = null;
    else pendingImg.frontImg = null;
    renderImgPreview();
  }

  /* ---------- CSV Im-/Export ---------- */

  function exportCsv(ev) {
    if (ev) { try { ev.stopPropagation(); } catch (e) { /* ignore */ } }
    var b = deck();
    if (!b || !FC()) return;
    var rows = (b.cards || []).slice().reverse().map(function (c) { return FC().cardToCsvRow(c); });
    var csv = 'Vorderseite;Rückseite\n' + rows.join('\n') + '\n';
    try {
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'deck-' + (b.title || 'karten').replace(/[^\wäöüÄÖÜß-]+/gi, '_') + '.csv';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    } catch (e) { alert('CSV-Export fehlgeschlagen.'); }
  }
  function importCsv(ev) {
    var files = ev && ev.target && ev.target.files;
    if (!files || !files.length) return;
    var b = deck();
    if (!b || !FC()) return;
    var f = files[0];
    ev.target.value = '';
    var r = new FileReader();
    r.onload = function () {
      try {
        var rows = FC().parseCardCsv(String(r.result || ''));
        // Kopfzeile "Vorderseite;Rückseite" überspringen
        if (rows.length && /^vorderseite$/i.test(rows[0].front) && /^rückseite$/i.test(rows[0].back)) rows.shift();
        if (!rows.length) { alert('Keine Karten in der CSV gefunden (Format: Vorderseite;Rückseite).'); return; }
        rows.forEach(function (row) {
          var nc = FC().newCard(row.front, row.back);
          b.cards.unshift(nc);
        });
        touch();
        renderDeck();
      } catch (e) { alert('CSV-Import fehlgeschlagen.'); }
    };
    r.readAsText(f);
  }

  /* ---------- Deck-Optionen ---------- */

  function saveOptions() {
    var b = deck();
    if (!b) return;
    var n = $('flashNewPerDay'), m = $('flashMaxRev');
    if (!FC()) return;
    FC().ensureDeck(b);
    if (n) b.deckOptions.newPerDay = Math.max(1, Math.min(500, Math.round(Number(n.value) || 20)));
    if (m) b.deckOptions.maxReviewsPerDay = Math.max(1, Math.min(2000, Math.round(Number(m.value) || 100)));
    touch();
    renderDeck();
  }

  /* ---------- Lernmodus ---------- */

  function startLearn() {
    var b = deck();
    if (!b || !FC()) return;
    session = FC().buildSession(b, { now: Date.now() });
    sessIdx = 0;
    flipped = false;
    sessCorrect = 0;
    sessGraded = 0;
    mode = 'learn';
    renderDeck();
  }
  function currentCard() {
    return session[sessIdx] || null;
  }
  function flip() {
    flipped = true;
    renderDeck();
  }
  function grade(g) {
    var b = deck();
    var c = currentCard();
    if (!b || !c || !FC()) return;
    if (!flipped) return;
    // Live-Karte im Deck finden (Session hält Referenzen, aber sicherheitshalber)
    var live = (b.cards || []).find(function (x) { return x && x.id === c.id; }) || c;
    if (FC().gradeAndLog) FC().gradeAndLog(b, live.id, g, Date.now());
    else FC().gradeCard(live, g, Date.now());
    sessGraded++;
    if (g !== 'again') sessCorrect++;
    sessIdx++;
    flipped = false;
    touch();
    renderDeck();
  }
  function exitLearn() {
    mode = 'cards';
    session = [];
    renderDeck();
  }

  /* ---------- Rendering ---------- */

  function renderDeck() {
    var b = deck();
    var title = $('flashTitle'), body = $('flashBody'), foot = $('flashFoot');
    var tabCards = $('flashTabCards'), tabLearn = $('flashTabLearn'), tabStats = $('flashTabStats');
    if (!b) { if (body) body.innerHTML = '<p>Deck nicht gefunden.</p>'; return; }
    if (title) title.textContent = '🂠 ' + (b.title || 'Deck');
    if (tabCards) tabCards.classList.toggle('picked', mode === 'cards');
    if (tabLearn) tabLearn.classList.toggle('picked', mode === 'learn');
    if (tabStats) tabStats.classList.toggle('picked', mode === 'stats');
    if (mode === 'learn') renderLearn(b, body, foot);
    else if (mode === 'stats') renderStats(b, body, foot);
    else renderCards(b, body, foot);
  }

  function statsHtml(b) {
    if (!FC()) return '';
    var s = FC().deckStats(b, Date.now());
    var ret = (s.retention == null) ? '–' : String(s.retention).replace('.', ',') + ' %';
    return '<div class="flash-stats">'
      + '<span title="Karten gesamt">🂠 ' + s.total + '</span>'
      + '<span title="Heute fällig" class="flash-due">⏰ ' + s.due + ' fällig</span>'
      + '<span title="Neue Karten">✨ ' + s.fresh + ' neu</span>'
      + '<span title="Gelernte Karten">📚 ' + s.learned + ' gelernt</span>'
      + '<span title="Trefferquote">🎯 ' + ret + '</span>'
      + '</div>';
  }

  function renderCards(b, body, foot) {
    if (!body) return;
    var cards = (b.cards || []).slice().sort(function (a, c2) {
      return (a && a.createdAt || 0) - (c2 && c2.createdAt || 0);
    });
    var opts = (b.deckOptions) || { newPerDay: 20, maxReviewsPerDay: 100 };
    var h = statsHtml(b)
      + '<div class="flash-form box">'
      + '<div class="section-title">' + (editingId ? 'Karte bearbeiten' : 'Neue Karte') + '</div>'
      + '<label>Vorderseite<textarea id="flashFront" rows="2" placeholder="Frage / Begriff …"></textarea></label>'
      + '<div class="flash-imgrow"><div id="flashFrontImgPrev" class="flash-imgprev"></div>'
      + '<button type="button" class="mini-button" onclick="deckAttachImage(\'front\',event)">🖼 Bild vorne</button></div>'
      + '<label>Rückseite<textarea id="flashBack" rows="2" placeholder="Antwort …"></textarea></label>'
      + '<div class="flash-imgrow"><div id="flashBackImgPrev" class="flash-imgprev"></div>'
      + '<button type="button" class="mini-button" onclick="deckAttachImage(\'back\',event)">🖼 Bild hinten</button></div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
      + '<button type="button" id="flashSaveBtn" onclick="deckSaveCard()">➕ Karte hinzufügen</button>'
      + '<button type="button" id="flashCancelBtn" class="inactive" style="display:none" onclick="deckCancelEdit()">Abbrechen</button>'
      + '</div></div>'
      + '<div class="flash-toolbar">'
      + '<button type="button" class="mini-button" onclick="startLearn()">▶ Lernen</button>'
      + '<button type="button" class="mini-button" onclick="deckExportCsv(event)">⬇ CSV</button>'
      + '<button type="button" class="mini-button" onclick="document.getElementById(\'flashCsvFile\').click()">⬆ CSV-Import</button>'
      + '<label style="display:flex;gap:6px;align-items:center;margin:0">Neu/Tag <input type="number" id="flashNewPerDay" min="1" max="500" value="' + esc(opts.newPerDay) + '" style="width:64px"></label>'
      + '<label style="display:flex;gap:6px;align-items:center;margin:0">Max/Tag <input type="number" id="flashMaxRev" min="1" max="2000" value="' + esc(opts.maxReviewsPerDay) + '" style="width:72px"></label>'
      + '<button type="button" class="mini-button" onclick="deckSaveOptions()">💾 Limits</button>'
      + '</div>'
      + '<div class="flash-listhead">'
      + '<div class="section-title" style="margin:0">Lernstand <span id="flashListCount" class="flash-count"></span></div>'
      + '<div class="flash-listcontrols">'
      + '<input type="search" id="flashListQ" placeholder="Karten suchen …" oninput="flashListSearch(this.value)" aria-label="Karten suchen">'
      + '<select id="flashListFilter" onchange="flashListFilter(this.value)" aria-label="Karten filtern">'
      + '<option value="all">Alle</option>'
      + '<option value="due">Fällig</option>'
      + '<option value="new">Neu</option>'
      + '<option value="learning">Lernend</option>'
      + '<option value="young">Jung</option>'
      + '<option value="mature">Reif</option>'
      + '<option value="leech">⚠ Schwierig</option>'
      + '<option value="suspended">Pausiert</option>'
      + '</select>'
      + '<select id="flashListSort" onchange="flashListSort(this.value)" aria-label="Karten sortieren">'
      + '<option value="due">Fälligkeit ↑</option>'
      + '<option value="created">Neueste zuerst</option>'
      + '<option value="interval">Intervall ↓</option>'
      + '<option value="mastery">Beherrschung ↓</option>'
      + '<option value="accuracy">Trefferquote ↑</option>'
      + '<option value="az">A–Z</option>'
      + '</select>'
      + '</div></div>'
      + '<div class="flash-list" id="flashList"></div>';
    body.innerHTML = h;
    // Formularwerte nach Render wiederherstellen (Render frisst Eingaben sonst)
    try {
      if (editingId) {
        var c = (b.cards || []).find(function (x) { return x && x.id === editingId; });
        if (c) {
          var f = $('flashFront'), bk = $('flashBack');
          if (f) f.value = FC() ? FC().stripTags(c.front) : String(c.front || '');
          if (bk) bk.value = FC() ? FC().stripTags(c.back) : String(c.back || '');
          var btn = $('flashSaveBtn');
          if (btn) btn.textContent = '💾 Speichern';
          var cancel = $('flashCancelBtn');
          if (cancel) cancel.style.display = '';
        }
      }
    } catch (e) { /* ignore */ }
    renderImgPreview();
    // Filter/Sortier-Controls aus dem State spiegeln (innerHTML hat sie geleert)
    try {
      var qEl = $('flashListQ');
      if (qEl) qEl.value = listQuery;
      var fEl = $('flashListFilter');
      if (fEl) fEl.value = listFilter;
      var sEl = $('flashListSort');
      if (sEl) sEl.value = listSort;
    } catch (e2) { /* Controls optional */ }
    renderCardList();
    if (foot) foot.innerHTML = '<span style="font-size:12px;opacity:.75">SM-2 plant Fälligkeiten · Bilder landen im lokalen Blob-Store · Export löst sie als dataURL auf.</span>';
  }

  /* ---------- Lernstand-Liste: Filter / Sortierung / Suche ---------- */

  function renderCardList() {
    var b = deck();
    var list = $('flashList'), counter = $('flashListCount');
    if (!b || !list) return;
    var api = FC();
    var t = Date.now();
    var all = (b.cards || []).filter(function (c) { return !!c; });
    var leechIds = {};
    try {
      if (api && api.leeches) (api.leeches(b) || []).forEach(function (c) { leechIds[c.id] = true; });
    } catch (e) { /* Filter optional */ }
    var q = String(listQuery || '').toLowerCase().trim();
    var list2 = all.filter(function (c) {
      if (q) {
        var hay = (api ? api.cardText(c) : String(c.front || '') + ' ' + String(c.back || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      if (listFilter === 'all') return true;
      if (listFilter === 'due') return !c.suspended && !!(api && api.isDue(c, t));
      if (listFilter === 'new') return !c.suspended && !c.lastReview;
      if (listFilter === 'suspended') return !!c.suspended;
      if (listFilter === 'leech') return !c.suspended && !!leechIds[c.id];
      if (api && listFilter) return !c.suspended && api.maturity(c) === listFilter;
      return true;
    });
    var byDue = function (a, c2) {
      var da = a.suspended ? Number.MAX_SAFE_INTEGER : Number(a.due) || 0;
      var db = c2.suspended ? Number.MAX_SAFE_INTEGER : Number(c2.due) || 0;
      return da - db;
    };
    var sorters = {
      created: function (a, c2) { return (Number(c2.createdAt) || 0) - (Number(a.createdAt) || 0); },
      interval: function (a, c2) { return (Number(c2.interval) || 0) - (Number(a.interval) || 0); },
      mastery: function (a, c2) {
        var ma = api ? api.masteryScore(a) : 0, mb = api ? api.masteryScore(c2) : 0;
        return mb - ma || byDue(a, c2);
      },
      accuracy: function (a, c2) {
        var aa = api ? api.accuracyOf(a) : null, ab = api ? api.accuracyOf(c2) : null;
        var va = (aa == null ? -1 : aa), vb = (ab == null ? -1 : ab);
        return va - vb || byDue(a, c2);
      },
      az: function (a, c2) {
        var sa = api ? api.stripTags(a.front) : String(a.front || '');
        var sb = api ? api.stripTags(c2.front) : String(c2.front || '');
        return sa.localeCompare(sb, 'de');
      },
    };
    list2.sort(byDue);
    if (sorters[listSort]) list2.sort(sorters[listSort]);
    if (counter) counter.textContent = list2.length === all.length
      ? '(' + all.length + ')'
      : '(' + list2.length + ' / ' + all.length + ')';
    if (!list2.length) {
      list.innerHTML = all.length
        ? '<p style="opacity:.7">Keine Karte passt zu Filter/Suche.</p>'
        : '<p style="opacity:.7">Noch keine Karten. Lege oben die erste an – oder importiere eine CSV (Vorderseite;Rückseite).</p>';
      return;
    }
    list.innerHTML = list2.map(cardRow).join('');
  }
  /* Suchfeld entprellen: renderCardList() baut die komplette Kartenliste neu auf
   * und filtert jede Karte gegen die Query. Ohne Bremse passiert das bei jedem
   * Tastendruck. Filter/Sort (onchange) bleiben unveraendert sofort. */
      var listSearchTimer = 0;
      function flashListSearch(v) {
        listQuery = String(v == null ? '' : v);
        clearTimeout(listSearchTimer);
        listSearchTimer = setTimeout(function () { listSearchTimer = 0; renderCardList(); }, 150);
      }
  function flashListFilter(v) {
    listFilter = ['all', 'due', 'new', 'learning', 'young', 'mature', 'leech', 'suspended']
      .indexOf(String(v)) >= 0 ? String(v) : 'all';
    renderCardList();
  }
  function flashListSort(v) {
    listSort = ['due', 'created', 'interval', 'mastery', 'accuracy', 'az'].indexOf(String(v)) >= 0 ? String(v) : 'due';
    renderCardList();
  }

  function cardRow(c) {
    if (!c) return '';
    var api = FC();
    var front = api ? api.stripTags(c.front).slice(0, 90) : String(c.front || '').slice(0, 90);
    var back = api ? api.stripTags(c.back).slice(0, 90) : String(c.back || '').slice(0, 90);
    var dueTxt = '';
    try {
      var t = Date.now();
      dueTxt = (c.suspended) ? 'pausiert' : (!c.lastReview ? 'neu' : (api ? api.formatDue(c.due, t) : 'fällig'));
    } catch (e) { dueTxt = ''; }
    var m = 'new', mLabel = 'Neu', mastery = 0, acc = null;
    try {
      if (api) { m = api.maturity(c); mLabel = api.maturityLabel(m); mastery = api.masteryScore(c); acc = api.accuracyOf(c); }
    } catch (e) { /* Auswertung optional */ }
    var accTxt = (acc == null) ? '–' : String(acc).replace('.', ',') + ' %';
    return '<div class="flash-row' + (c.suspended ? ' suspended' : '') + '">'
      + '<div class="flash-row-text"><b>' + esc(front || '–') + '</b><span>' + esc(back || '–') + '</span>'
      + '<span class="flash-row-meta">' + esc(dueTxt) + ' · <span class="flash-chip flash-m-' + esc(m) + '">' + esc(mLabel) + '</span>'
      + ' · wdh ' + esc(c.reps || 0) + ' · ease ' + esc(c.ease) + ' · Quote ' + esc(accTxt) + '</span>'
      + '<span class="flash-mastery" title="Beherrschung aus Intervall (30+ Tage = 100 %)"><i style="width:' + esc(mastery) + '%"></i></span></div>'
      + '<div class="flash-row-actions">'
      + '<button type="button" class="mini-button" onclick="deckEditCard(\'' + c.id + '\')" title="Karte bearbeiten">✎</button>'
      + '<button type="button" class="mini-button" onclick="deckToggleSuspend(\'' + c.id + '\',event)" title="Pausieren/Fortsetzen">' + (c.suspended ? '▶' : '⏸') + '</button>'
      + '<button type="button" class="mini-button" onclick="deckResetProgress(\'' + c.id + '\',event)" title="Lernstand zurücksetzen">↺</button>'
      + '<button type="button" class="mini-button" onclick="deckDeleteCard(\'' + c.id + '\',event)" title="Karte löschen">🗑</button>'
      + '</div></div>';
  }

  /* ---------- Dashboard (Auswertungen) ---------- */

  function renderStats(b, body, foot) {
    if (!body) return;
    var api = FC();
    if (!api) { body.innerHTML = '<p>Lernmodul nicht geladen.</p>'; return; }
    var t = Date.now();
    var s = api.deckStats(b, t);
    var m = s.maturity || { new: 0, learning: 0, young: 0, mature: 0 };
    var active = Math.max(1, (m.new || 0) + (m.learning || 0) + (m.young || 0) + (m.mature || 0));
    var pct = function (n) { return Math.round((n / active) * 100); };
    var ret = (s.retention == null) ? '–' : String(s.retention).replace('.', ',') + ' %';
    var todayAcc = (s.todayAccuracy == null) ? '–' : String(s.todayAccuracy).replace('.', ',') + ' %';
    var h = '<div class="flash-dash">'
      + '<div class="flash-kpis">'
      + '<div class="flash-kpi" title="Karten im Deck"><b>' + s.total + '</b><span>Karten</span></div>'
      + '<div class="flash-kpi" title="Heute fällig"><b>' + s.due + '</b><span>fällig</span></div>'
      + '<div class="flash-kpi" title="Lern-Streak in Tagen"><b>' + s.streak + '</b><span>Tage 🔥</span></div>'
      + '<div class="flash-kpi" title="Bewertungen heute"><b>' + s.todayReviews + '</b><span>heute</span></div>'
      + '<div class="flash-kpi" title="Trefferquote heute"><b>' + todayAcc + '</b><span>Quote heute</span></div>'
      + '<div class="flash-kpi" title="Trefferquote über alle Bewertungen"><b>' + ret + '</b><span>Quote gesamt</span></div>'
      + '<div class="flash-kpi" title="Bewertungen der letzten 7 Tage"><b>' + s.weekReviews + '</b><span>letzte 7 Tage</span></div>'
      + '<div class="flash-kpi" title="Schwierige Karten (viele Fehler / niedrige Ease)"><b>' + s.leeches + '</b><span>schwierig</span></div>'
      + '</div>'
      + '<div class="flash-panel">'
      + '<div class="flash-panel-title">Lernfortschritt nach Reife</div>'
      + '<div class="flash-bar" title="Reif ' + (m.mature || 0) + ' · Jung ' + (m.young || 0) + ' · Lernend ' + (m.learning || 0) + ' · Neu ' + (m.new || 0) + '">'
      + '<i class="flash-bar-mature" style="width:' + pct(m.mature || 0) + '%"></i>'
      + '<i class="flash-bar-young" style="width:' + pct(m.young || 0) + '%"></i>'
      + '<i class="flash-bar-learning" style="width:' + pct(m.learning || 0) + '%"></i>'
      + '<i class="flash-bar-new" style="width:' + pct(m.new || 0) + '%"></i>'
      + '</div>'
      + '<div class="flash-legend">'
      + '<span><i class="flash-dot flash-m-mature"></i>Reif ' + (m.mature || 0) + ' (' + pct(m.mature || 0) + ' %)</span>'
      + '<span><i class="flash-dot flash-m-young"></i>Jung ' + (m.young || 0) + ' (' + pct(m.young || 0) + ' %)</span>'
      + '<span><i class="flash-dot flash-m-learning"></i>Lernend ' + (m.learning || 0) + ' (' + pct(m.learning || 0) + ' %)</span>'
      + '<span><i class="flash-dot flash-m-new"></i>Neu ' + (m.new || 0) + ' (' + pct(m.new || 0) + ' %)</span>'
      + '</div></div>'
      + activityPanel(b, api, t)
      + leechPanel(b, api)
      + '</div>';
    body.innerHTML = h;
    if (foot) foot.innerHTML = '<span style="font-size:12px;opacity:.75">Reif = Intervall ≥ ' + api.MATURE_DAYS + ' Tage · Schwierig = ≥ ' + api.LEECH_LAPSES + ' Fehler oder Ease am Minimum</span>';
  }

  function activityPanel(b, api, t) {
    var rows = api.activityByDay(b, 14, t);
    var max = 1;
    rows.forEach(function (r) { if (r.total > max) max = r.total; });
    var bars = rows.map(function (r) {
      var h = Math.max(4, Math.round((r.total / max) * 60));
      var acc = r.total ? Math.round((r.correct / r.total) * 100) : 0;
      var d = new Date(r.day);
      var label = d.getDate() + '.' + (d.getMonth() + 1) + '.';
      return '<div class="flash-day" title="' + label + ': ' + r.total + ' Bewertungen, ' + acc + ' % richtig">'
        + '<i style="height:' + h + 'px"></i><span>' + label + '</span></div>';
    }).join('');
    return '<div class="flash-panel"><div class="flash-panel-title">Lernaktivität (14 Tage)</div>'
      + '<div class="flash-days">' + bars + '</div></div>';
  }

  function leechPanel(b, api) {
    var list = api.leeches(b) || [];
    if (!list.length) {
      return '<div class="flash-panel"><div class="flash-panel-title">Schwierige Karten</div>'
        + '<p style="opacity:.75;font-size:13px">Keine auffälligen Karten. 🎉</p></div>';
    }
    var rows = list.slice(0, 8).map(function (c) {
      var front = api.stripTags(c.front).slice(0, 70);
      var acc = api.accuracyOf(c);
      return '<button type="button" class="flash-leech-row" onclick="deckEditCard(\'' + c.id + '\')">'
        + '<span>' + esc(front || '–') + '</span>'
        + '<span class="flash-row-meta">Fehler ' + esc(c.lapses || 0) + ' · ease ' + esc(c.ease) + ' · Quote '
        + esc(acc == null ? '–' : String(acc).replace('.', ',') + ' %') + '</span></button>';
    }).join('');
    return '<div class="flash-panel"><div class="flash-panel-title">Schwierige Karten (Top ' + Math.min(8, list.length) + ')</div>'
      + '<div class="flash-leech-list">' + rows + '</div></div>';
  }

  function renderLearn(b, body, foot) {
    if (!body) return;
    if (!session.length) {
      var s0 = FC() ? FC().deckStats(b, Date.now()) : null;
      body.innerHTML = statsHtml(b)
        + '<div class="flash-done"><div style="font-size:40px">🎉</div>'
        + '<p><b>Nichts fällig!</b>' + (s0 ? ' ' + s0.total + ' Karten im Deck, ' + s0.learned + ' gelernt.' : '') + '</p>'
        + '<p style="opacity:.75;font-size:13px">Neue Karten erscheinen nach Tages-Limit, Fällige nach SM-2-Plan.</p>'
        + '<button type="button" onclick="exitLearn()">← Zur Kartenliste</button></div>';
      if (foot) foot.innerHTML = '';
      return;
    }
    if (sessIdx >= session.length) {
      var quote = sessGraded ? Math.round((sessCorrect / sessGraded) * 100) : 0;
      body.innerHTML = statsHtml(b)
        + '<div class="flash-done"><div style="font-size:40px">✅</div>'
        + '<p><b>Einheit geschafft:</b> ' + sessGraded + ' bewertet, ' + sessCorrect + ' gewusst (' + quote + ' %).</p>'
        + '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">'
        + '<button type="button" onclick="exitLearn()">← Zur Kartenliste</button>'
        + '<button type="button" class="mini-button" onclick="startLearn()">↻ Weiter lernen</button>'
        + '</div></div>';
      if (foot) foot.innerHTML = '';
      return;
    }
    var c = session[sessIdx];
    var prev = {};
    try { prev = FC().previewIntervals(c); } catch (e) { prev = { again: 0, hard: 1, good: 1, easy: 4 }; }
    var fi = imgUrl(c.frontImg), bi = imgUrl(c.backImg);
    var frontTxt = FC() ? FC().stripTags(c.front) : String(c.front || '');
    var backTxt = FC() ? FC().stripTags(c.back) : String(c.back || '');
    var h = '<div class="flash-progress">Karte ' + (sessIdx + 1) + ' / ' + session.length + ' · heute ' + sessGraded + ' bewertet</div>'
      + '<div class="flash-card" onclick="if(!this.dataset.locked)learnFlip()">'
      + '<div class="flash-side">' + (frontTxt ? '<p>' + esc(frontTxt) + '</p>' : '')
      + (fi ? '<img src="' + esc(fi) + '" alt="Bild Vorderseite">' : '')
      + (!frontTxt && !fi ? '<p style="opacity:.6">(leere Vorderseite)</p>' : '') + '</div>';
    if (flipped) {
      h += '<hr><div class="flash-side flash-back">' + (backTxt ? '<p>' + esc(backTxt) + '</p>' : '')
        + (bi ? '<img src="' + esc(bi) + '" alt="Bild Rückseite">' : '') + '</div>';
    } else {
      h += '<div class="flash-hint">Antippen zum Umdrehen</div>';
    }
    h += '</div>';
    if (flipped) {
      h += '<div class="flash-grades">'
        + '<button type="button" class="grade-again" onclick="learnGrade(\'again\')">✕ Nochmal<span>' + esc(FC().formatInterval(prev.again)) + '</span></button>'
        + '<button type="button" class="grade-hard" onclick="learnGrade(\'hard\')">Hart<span>' + esc(FC().formatInterval(prev.hard)) + '</span></button>'
        + '<button type="button" class="grade-good" onclick="learnGrade(\'good\')">Gut<span>' + esc(FC().formatInterval(prev.good)) + '</span></button>'
        + '<button type="button" class="grade-easy" onclick="learnGrade(\'easy\')">Leicht<span>' + esc(FC().formatInterval(prev.easy)) + '</span></button>'
        + '</div>';
    } else {
      h += '<div style="display:flex;justify-content:center"><button type="button" onclick="learnFlip()">Umdrehen (Leertaste)</button></div>';
    }
    body.innerHTML = h;
    var cardEl = body.querySelector('.flash-card');
    if (cardEl && flipped) cardEl.dataset.locked = '1';
    if (foot) foot.innerHTML = '<span style="font-size:12px;opacity:.75">Ehrlich bewerten – davon lebt SM-2. Tasten: Leertaste = umdrehen, 1–4 = bewerten.</span>';
  }

  /* ---------- Tastatur ---------- */

  function onKey(e) {
    try {
      var ov = $('flashOverlay');
      if (!ov || !ov.classList.contains('active')) return;
      if (mode !== 'learn') return;
      if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
      if (e.code === 'Space') { e.preventDefault(); if (!flipped) flip(); }
      else if (e.key === '1' && flipped) grade('again');
      else if (e.key === '2' && flipped) grade('hard');
      else if (e.key === '3' && flipped) grade('good');
      else if (e.key === '4' && flipped) grade('easy');
    } catch (err) { /* ignore */ }
  }
  try {
    if (typeof document !== 'undefined') document.addEventListener('keydown', onKey);
  } catch (e) { /* ignore */ }

  // Blob-URLs nachladen, sobald der Store sie aufgelöst hat
  try {
    if (typeof GrimoireStore !== 'undefined' && GrimoireStore.subscribe) {
      GrimoireStore.subscribe(function () {
        try {
          var ov = document.getElementById('flashOverlay');
          if (ov && ov.classList.contains('active')) {
            if (mode === 'learn' && currentCard() && (currentCard().frontImg || currentCard().backImg)) renderDeck();
            else if (pendingImg.frontImg || pendingImg.backImg) renderImgPreview();
          }
        } catch (e) { /* ignore */ }
      });
    }
  } catch (e) { /* optional */ }

  var api = {
    openDeckView: openDeckView,
    openDeckLearn: openDeckLearn,
    closeDeckView: closeDeckView,
    switchMode: switchMode,
    startLearn: startLearn,
    exitLearn: exitLearn,
    flip: flip,
    grade: grade,
    renderStats: renderStats,
    renderCardList: renderCardList,
    editCard: editCard,
    saveCard: saveCard,
    cancelEdit: resetForm,
    deleteCard: deleteCard,
    toggleSuspend: toggleSuspend,
    resetProgress: resetProgress,
    attachImage: attachImage,
    onImagePicked: onImagePicked,
    removeImage: removeImage,
    exportCsv: exportCsv,
    importCsv: importCsv,
    saveOptions: saveOptions,
    renderDeck: renderDeck,
  };

  if (typeof window !== 'undefined') {
    window.FlashUI = api;
    window.openDeckView = openDeckView;
    window.openDeckLearn = openDeckLearn;
    window.openDeckStats = openDeckStats;
    window.closeDeckView = closeDeckView;
    window.flashSwitchMode = switchMode;
    window.flashListSearch = flashListSearch;
    window.flashListFilter = flashListFilter;
    window.flashListSort = flashListSort;
    window.startLearn = startLearn;
    window.exitLearn = exitLearn;
    window.learnFlip = flip;
    window.learnGrade = grade;
    window.deckEditCard = editCard;
    window.deckSaveCard = saveCard;
    window.deckCancelEdit = resetForm;
    window.deckDeleteCard = deleteCard;
    window.deckToggleSuspend = toggleSuspend;
    window.deckResetProgress = resetProgress;
    window.deckAttachImage = attachImage;
    window.deckImagePicked = onImagePicked;
    window.deckRemoveImage = removeImage;
    window.deckExportCsv = exportCsv;
    window.deckImportCsv = importCsv;
    window.deckSaveOptions = saveOptions;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
